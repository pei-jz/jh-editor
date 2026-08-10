use std::fs;
use chardetng::EncodingDetector;
use crossbeam_channel::unbounded;
use ignore::WalkBuilder;
use ignore::overrides::{Override, OverrideBuilder};
use tauri::{AppHandle, Emitter, command};
use crate::models::{FileEntry, SearchProgress};

/// Fast file listing for file search modal.
/// Uses .gitignore, skips binary extensions, and collects file paths quickly.
#[command]
pub async fn list_all_files(dir: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        do_list_all_files(dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn do_list_all_files(dir: String) -> Result<Vec<FileEntry>, String> {
    let (tx, rx) = unbounded();

    let walker = WalkBuilder::new(&dir)
        .threads(
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1),
        )
        .hidden(true)       // Skip hidden files/dirs
        .git_ignore(true)   // Respect .gitignore
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .build_parallel();

    let binary_exts: std::collections::HashSet<&str> = [
        "exe", "dll", "so", "dylib", "bin", "obj", "o",
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg",
        "zip", "tar", "gz", "7z", "rar",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "mp3", "mp4", "wav", "avi", "mov", "mkv", "flac",
        "db", "sqlite", "class", "jar", "pyc", "pdb",
        "woff", "woff2", "ttf", "eot", "otf",
        "lock",
    ].into_iter().collect();

    walker.run(|| {
        let tx = tx.clone();
        let binary_exts = binary_exts.clone();
        Box::new(move |entry| {
            if let Ok(entry) = entry {
                let path = entry.path();
                let is_dir = path.is_dir();

                // Skip directories in results (we only want files)
                if is_dir {
                    return ignore::WalkState::Continue;
                }

                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

                // Skip binary file extensions
                if let Some(ext) = path.extension() {
                    if binary_exts.contains(ext.to_string_lossy().to_lowercase().as_str()) {
                        return ignore::WalkState::Continue;
                    }
                }

                let _ = tx.send(FileEntry {
                    name,
                    is_directory: false,
                    path: path.to_string_lossy().to_string(),
                });
            }
            ignore::WalkState::Continue
        })
    });

    drop(tx);
    let results: Vec<FileEntry> = rx.into_iter().collect();
    Ok(results)
}

pub enum SearchEvent {
    ScannedBatch(usize, String),
    Found,
    TotalFiles(usize),
}

#[command]
pub async fn search_files(
    app: AppHandle,
    dir: String,
    term: String,
    search_content: bool,
    search_id: f64,
) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        do_search(app, dir, term, search_content, search_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn do_search(
    app: AppHandle,
    dir: String,
    term: String,
    search_content: bool,
    search_id: f64,
) -> Result<Vec<FileEntry>, String> {
    let term = term.to_lowercase();
    let (stats_tx, stats_rx) = unbounded();
    let (results_tx, results_rx) = unbounded();

    let walker = WalkBuilder::new(&dir)
        .threads(
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1),
        )
        .hidden(false)
        .git_ignore(false)
        .ignore(false)
        .build_parallel();

    // Progress reporter thread
    let progress_handle = std::thread::spawn(move || {
        let mut scanned = 0;
        let mut found = 0;
        let mut total = 0;
        let mut current_path = String::new();
        let mut last_emit = std::time::Instant::now();

        for event in stats_rx {
            match event {
                SearchEvent::ScannedBatch(count, path) => {
                    scanned += count;
                    current_path = path;
                }
                SearchEvent::Found => found += 1,
                SearchEvent::TotalFiles(t) => total = t,
            }

            if last_emit.elapsed().as_millis() > 50 {
                let _ = app.emit(
                    "search-progress",
                    SearchProgress {
                        scanned,
                        found,
                        current_path: current_path.clone(),
                        total,
                        search_id,
                    },
                );
                last_emit = std::time::Instant::now();
            }
        }
        let _ = app.emit(
            "search-progress",
            SearchProgress {
                scanned,
                found,
                current_path: current_path,
                total,
                search_id,
            },
        );
    });

    // 1. Pre-scan to count files
    let stats_tx_count = stats_tx.clone();
    let dir_count = dir.clone();

    std::thread::spawn(move || {
        let count_walker = WalkBuilder::new(&dir_count)
            .threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
            .hidden(false)
            .git_ignore(false)
            .ignore(false)
            .build_parallel();

        let (count_tx, count_rx) = unbounded();
        let aggregator = std::thread::spawn(move || {
            let mut total = 0;
            for _ in count_rx {
                total += 1;
            }
            let _ = stats_tx_count.send(SearchEvent::TotalFiles(total));
        });

        count_walker.run(|| {
            let count_tx = count_tx.clone();
            Box::new(move |_| {
                let _ = count_tx.send(());
                ignore::WalkState::Continue
            })
        });
        drop(count_tx);
        let _ = aggregator.join();
    });

    // 2. Actual Search
    walker.run(|| {
        let stats_tx = stats_tx.clone();
        let results_tx = results_tx.clone();
        let term = term.clone();

        struct ProgressReporter {
            tx: crossbeam_channel::Sender<SearchEvent>,
            count: usize,
            last_path: String,
        }

        impl ProgressReporter {
            fn new(tx: crossbeam_channel::Sender<SearchEvent>) -> Self {
                Self { tx, count: 0, last_path: String::new() }
            }
            fn record(&mut self, path: String) {
                self.count += 1;
                self.last_path = path;
                if self.count >= 10 { self.flush(); }
            }
            fn flush(&mut self) {
                if self.count > 0 {
                    let _ = self.tx.send(SearchEvent::ScannedBatch(
                        self.count,
                        std::mem::take(&mut self.last_path),
                    ));
                    self.count = 0;
                }
            }
        }
        impl Drop for ProgressReporter {
            fn drop(&mut self) { self.flush(); }
        }

        let mut reporter = ProgressReporter::new(stats_tx);

        Box::new(move |entry| {
            if let Ok(entry) = entry {
                let path = entry.path();
                reporter.record(path.to_string_lossy().to_string());

                let is_directory = path.is_dir();
                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let re = regex::RegexBuilder::new(&term)
                    .case_insensitive(true)
                    .build();

                let matches_name = match &re {
                    Ok(r) => r.is_match(&name),
                    Err(_) => name.to_lowercase().contains(&term),
                };
                
                let mut matches = matches_name;

                if !matches && !is_directory && search_content {
                    if let Ok(bytes) = fs::read(path) {
                        let check_len = std::cmp::min(bytes.len(), 1024);
                        if !bytes[0..check_len].contains(&0) {
                            let mut detector = EncodingDetector::new();
                            detector.feed(&bytes, true);
                            let encoding = detector.guess(None, true);
                            let (cow, _, _) = encoding.decode(&bytes);
                            
                            matches = match &re {
                                Ok(r) => r.is_match(&cow),
                                Err(_) => cow.to_lowercase().contains(&term),
                            };
                        }
                    }
                }

                if matches {
                    let file_entry = FileEntry {
                        name,
                        is_directory,
                        path: path.to_string_lossy().to_string(),
                    };
                    let _ = results_tx.send(file_entry);
                    let _ = reporter.tx.send(SearchEvent::Found);
                }
            }
            ignore::WalkState::Continue
        })
    });

    drop(stats_tx);
    drop(results_tx);
    let _ = progress_handle.join();

    let mut results = Vec::new();
    while let Ok(entry) = results_rx.recv() {
        results.push(entry);
    }
    Ok(results)
}

// ─── Workspace grep: streaming, line-level content search ────────────────────

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

// Bumped on every start_grep. A running search checks that its generation is
// still current; a newer search supersedes (cancels) it.
static GREP_GEN: AtomicU64 = AtomicU64::new(0);

const GREP_MAX_MATCHES: usize = 5000;

#[derive(serde::Serialize, Clone)]
pub struct GrepMatch {
    pub path: String,
    pub line: usize, // 1-based
    pub col: usize,  // 1-based (character column)
    pub text: String,
}

#[derive(serde::Serialize, Clone)]
struct GrepBatch {
    search_id: f64,
    matches: Vec<GrepMatch>,
}

#[derive(serde::Serialize, Clone)]
struct GrepDone {
    search_id: f64,
    total: usize,
    truncated: bool,
    canceled: bool,
}

/// Start an asynchronous workspace grep. Returns immediately; matches stream to
/// the frontend as `grep-match` events (batched) and completion is signalled by
/// `grep-done`. `search_id` correlates events; starting a new search cancels any
/// in-flight one. Respects .gitignore, skips binary/oversized files, caps total.
#[command]
pub fn start_grep(
    app: AppHandle,
    dir: String,
    term: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include_subdirs: bool,
    globs: Option<String>,
    search_id: f64,
) -> Result<(), String> {
    let my_gen = GREP_GEN.fetch_add(1, Ordering::SeqCst) + 1;

    if term.is_empty() {
        let _ = app.emit("grep-done", GrepDone { search_id, total: 0, truncated: false, canceled: false });
        return Ok(());
    }

    // Optional filename filter, e.g. "*.java" or "*.java, *.xml" (a `!` prefix
    // excludes). Built here so an invalid glob is reported to the caller before
    // a results tab is opened.
    let overrides = build_overrides(&dir, globs.as_deref())?;

    // Build/validate the pattern up front so an invalid regex returns an error
    // to the caller (before a results tab is opened).
    let mut pattern = if regex { term.clone() } else { regex::escape(&term) };
    if whole_word {
        pattern = format!(r"\b(?:{})\b", pattern);
    }
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Invalid search pattern: {}", e))?;

    std::thread::spawn(move || {
        grep_worker(app, dir, re, include_subdirs, overrides, search_id, my_gen);
    });
    Ok(())
}

/// Build an `Override` matcher from a comma/whitespace separated glob list.
/// Returns an empty (match-everything) Override when no globs are given.
fn build_overrides(dir: &str, globs: Option<&str>) -> Result<Override, String> {
    let mut builder = OverrideBuilder::new(dir);
    let mut added = false;
    if let Some(raw) = globs {
        for g in raw.split(|c| c == ',' || c == ';' || c == ' ' || c == '\t') {
            let g = g.trim();
            if g.is_empty() {
                continue;
            }
            builder
                .add(g)
                .map_err(|e| format!("Invalid file glob '{}': {}", g, e))?;
            added = true;
        }
    }
    if !added {
        return Ok(Override::empty());
    }
    builder.build().map_err(|e| format!("Invalid file glob: {}", e))
}

fn grep_worker(
    app: AppHandle,
    dir: String,
    re: regex::Regex,
    include_subdirs: bool,
    overrides: Override,
    search_id: f64,
    my_gen: u64,
) {
    const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
    const MAX_LINE_LEN: usize = 500;

    let (tx, rx) = unbounded::<GrepMatch>();
    let count = Arc::new(AtomicUsize::new(0));

    // Collector: batch incoming matches and emit them to the frontend live.
    let collector_app = app.clone();
    let collector = std::thread::spawn(move || {
        use std::time::Instant;
        let mut batch: Vec<GrepMatch> = Vec::new();
        let mut last = Instant::now();
        let mut total = 0usize;
        while let Ok(m) = rx.recv() {
            if GREP_GEN.load(Ordering::SeqCst) != my_gen {
                return; // superseded — stop emitting
            }
            total += 1;
            batch.push(m);
            if batch.len() >= 50 || last.elapsed().as_millis() > 80 {
                let _ = collector_app.emit("grep-match", GrepBatch { search_id, matches: std::mem::take(&mut batch) });
                last = Instant::now();
            }
        }
        if GREP_GEN.load(Ordering::SeqCst) != my_gen {
            return;
        }
        if !batch.is_empty() {
            let _ = collector_app.emit("grep-match", GrepBatch { search_id, matches: batch });
        }
        let _ = collector_app.emit("grep-done", GrepDone {
            search_id,
            total,
            truncated: total >= GREP_MAX_MATCHES,
            canceled: false,
        });
    });

    let mut builder = WalkBuilder::new(&dir);
    builder
        .threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
        .hidden(false)
        .git_ignore(true)
        .ignore(true)
        .overrides(overrides);
    if !include_subdirs {
        builder.max_depth(Some(1));
    }
    let walker = builder.build_parallel();

    walker.run(|| {
        let tx = tx.clone();
        let re = re.clone();
        let count = count.clone();
        Box::new(move |entry| {
            if GREP_GEN.load(Ordering::SeqCst) != my_gen
                || count.load(Ordering::Relaxed) >= GREP_MAX_MATCHES
            {
                return ignore::WalkState::Quit;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };
            let path = entry.path();
            if path.is_dir() {
                return ignore::WalkState::Continue;
            }
            if let Ok(meta) = entry.metadata() {
                if meta.len() > MAX_FILE_SIZE {
                    return ignore::WalkState::Continue;
                }
            }
            let bytes = match fs::read(path) {
                Ok(b) => b,
                Err(_) => return ignore::WalkState::Continue,
            };
            if bytes.iter().take(8000).any(|&b| b == 0) {
                return ignore::WalkState::Continue; // likely binary
            }
            // Detect the file's encoding (Shift_JIS / EUC-JP / UTF-8 / …) and
            // decode with it, so grep matches text in non-UTF-8 files too.
            let mut detector = EncodingDetector::new();
            detector.feed(&bytes, true);
            let encoding = detector.guess(None, true);
            let (text, _, _) = encoding.decode(&bytes);
            let path_str = path.to_string_lossy().to_string();
            for (i, line) in text.lines().enumerate() {
                if let Some(m) = re.find(line) {
                    if count.fetch_add(1, Ordering::Relaxed) >= GREP_MAX_MATCHES {
                        return ignore::WalkState::Quit;
                    }
                    let mut t = line.to_string();
                    if t.chars().count() > MAX_LINE_LEN {
                        t = t.chars().take(MAX_LINE_LEN).collect();
                    }
                    let col = line[..m.start()].chars().count() + 1;
                    let _ = tx.send(GrepMatch { path: path_str.clone(), line: i + 1, col, text: t });
                }
            }
            ignore::WalkState::Continue
        })
    });
    drop(tx);
    let _ = collector.join();
}

#[cfg(test)]
mod grep_glob_tests {
    use super::*;
    use std::fs;

    #[test]
    fn glob_filters_files_but_still_recurses() {
        let base = std::env::temp_dir().join(format!("jh_glob_test_{}", std::process::id()));
        let sub = base.join("nested").join("deep");
        fs::create_dir_all(&sub).unwrap();
        fs::write(base.join("a.java"), "x").unwrap();
        fs::write(base.join("a.txt"), "x").unwrap();
        fs::write(sub.join("b.java"), "x").unwrap();
        fs::write(sub.join("b.txt"), "x").unwrap();

        let dir = base.to_string_lossy().to_string();
        let ov = build_overrides(&dir, Some("*.java")).unwrap();

        let mut found: Vec<String> = Vec::new();
        let mut b = WalkBuilder::new(&dir);
        b.hidden(false).overrides(ov);
        for e in b.build().flatten() {
            let p = e.path();
            if p.is_file() {
                found.push(p.file_name().unwrap().to_string_lossy().to_string());
            }
        }
        found.sort();
        let _ = fs::remove_dir_all(&base);
        assert_eq!(found, vec!["a.java".to_string(), "b.java".to_string()],
                   "whitelist glob must keep nested .java and drop .txt");
    }

    #[test]
    fn empty_glob_matches_everything() {
        let ov = build_overrides(".", None).unwrap();
        assert!(ov.is_empty());
        let ov2 = build_overrides(".", Some("   ")).unwrap();
        assert!(ov2.is_empty());
    }

    #[test]
    fn invalid_glob_errors() {
        assert!(build_overrides(".", Some("[")).is_err());
    }
}
