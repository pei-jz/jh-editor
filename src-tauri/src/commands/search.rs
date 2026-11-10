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

    // Files this editor cannot open at all, so quick-open should not list them.
    // The Office formats with a reader (.xlsx/.xls/.ods/.docx/.pptx) are NOT
    // here: they open in the read-only preview, and a file that can be opened
    // but not found by name is a feature nobody discovers. This is a different
    // question from what GREP should read — a workbook is still binary to a
    // content search, which skips it on its own.
    let binary_exts: std::collections::HashSet<&str> = [
        "exe", "dll", "so", "dylib", "bin", "obj", "o",
        "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg",
        "zip", "tar", "gz", "7z", "rar",
        "pdf", "doc", "ppt",
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
use std::sync::{Arc, Mutex};

// Bumped on every start_grep. A running search checks that its generation is
// still current; a newer search supersedes (cancels) it.
static GREP_GEN: AtomicU64 = AtomicU64::new(0);
// The search that generation belongs to, as the bits of its id. A tab closing
// must not cancel a newer search than its own.
static GREP_RUNNING: AtomicU64 = AtomicU64::new(0);

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
struct GrepProgress {
    search_id: f64,
    files: usize,
    /// Folders walked. With a file filter, `files` only counts what passes it
    /// and can stay at 0 for a long time while the search is hard at work.
    folders: usize,
    /// The folder last entered: "" before the first.
    folder: String,
    bytes: u64,
    /// The large file being read, if any: "" when there is none.
    current: String,
    current_done: u64,
    current_size: u64,
}

#[derive(serde::Serialize, Clone)]
struct GrepDone {
    search_id: f64,
    total: usize,
    truncated: bool,
    canceled: bool,
}

/// What a search says as it goes.
enum GrepEvent {
    Match(GrepBatch),
    Progress(GrepProgress),
    Done(GrepDone),
}

struct GrepRequest {
    dir: String,
    patterns: GrepPatterns,
    include_subdirs: bool,
    overrides: Override,
    max_matches: usize,
    search_id: f64,
    my_gen: u64,
}

/// Start an asynchronous workspace grep. Returns immediately; matches stream to
/// the frontend as `grep-match` events (batched) and completion is signalled by
/// `grep-done`. `search_id` correlates events; starting a new search cancels any
/// in-flight one. Respects .gitignore, skips binary files, caps total. `grep-progress`
/// says how far it has got. `max_matches` is the limit on the whole search.
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
    max_matches: Option<usize>,
    search_id: f64,
) -> Result<(), String> {
    let my_gen = begin_search(search_id);

    if term.is_empty() {
        let _ = app.emit("grep-done", GrepDone { search_id, total: 0, truncated: false, canceled: false });
        return Ok(());
    }

    // Optional filename filter, e.g. "*.java" or "*.java, *.xml" (a `!` prefix
    // excludes), and the pattern. The dialog shows the error, but its results
    // tab is already open and listening: without a grep-done it says
    // "Searching…" for good.
    let prepared = build_overrides(&dir, globs.as_deref()).and_then(|overrides| {
        compile_patterns(&term, regex, case_sensitive, whole_word)
            .map(|patterns| (overrides, patterns))
            .map_err(|e| format!("Invalid search pattern: {}", e))
    });
    let (overrides, patterns) = match prepared {
        Ok(ready) => ready,
        Err(e) => {
            let _ = app.emit("grep-done", GrepDone { search_id, total: 0, truncated: false, canceled: true });
            return Err(e);
        }
    };

    let request = GrepRequest {
        dir,
        patterns,
        include_subdirs,
        overrides,
        max_matches: max_matches.unwrap_or(GREP_MAX_MATCHES).max(1),
        search_id,
        my_gen,
    };
    std::thread::spawn(move || {
        let emit = move |event: GrepEvent| {
            let _ = match event {
                GrepEvent::Match(batch) => app.emit("grep-match", batch),
                GrepEvent::Progress(progress) => app.emit("grep-progress", progress),
                GrepEvent::Done(done) => app.emit("grep-done", done),
            };
        };
        grep_worker(emit, request);
    });
    Ok(())
}

/// A new search takes the generation over from whatever was running.
fn begin_search(search_id: f64) -> u64 {
    let my_gen = GREP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    GREP_RUNNING.store(search_id.to_bits(), Ordering::SeqCst);
    my_gen
}

/// Stop a search, if it is still the one running. The worker says so itself, as
/// `grep-done` with `canceled`.
#[command]
pub fn cancel_grep(search_id: f64) {
    if GREP_RUNNING.load(Ordering::SeqCst) == search_id.to_bits() {
        GREP_GEN.fetch_add(1, Ordering::SeqCst);
    }
}

/// Build an `Override` matcher from a comma/whitespace separated glob list.
/// Returns an empty (match-everything) Override when no globs are given.
fn build_overrides(dir: &str, globs: Option<&str>) -> Result<Override, String> {
    let mut builder = OverrideBuilder::new(dir);
    // File names here do not care about case, so neither does the filter:
    // `*.java` has to find Main.JAVA.
    builder
        .case_insensitive(true)
        .map_err(|e| format!("Invalid file glob: {}", e))?;
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

/// What a grep walks: everything but what git ignores, hidden files included
/// (.github and .vscode are worth searching), and never a VCS's own store.
///
/// That store used to be walked too, because `hidden(false)` is what lets it in
/// and no .gitignore lists it. In a repository it can be a third of the files:
/// slow to read, and the hits in it (logs, COMMIT_EDITMSG) are noise.
fn grep_walk(dir: &str, include_subdirs: bool, overrides: Override) -> WalkBuilder {
    let mut builder = WalkBuilder::new(dir);
    builder
        .threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
        .hidden(false)
        .git_ignore(true)
        .ignore(true)
        .overrides(overrides)
        // Depth 0 is the folder asked for. Someone who points the search at
        // .git itself means it.
        .filter_entry(|e| {
            e.depth() == 0
                || !(e.file_type().is_some_and(|t| t.is_dir())
                    && matches!(e.file_name().to_str(), Some(".git" | ".hg" | ".svn")))
        });
    if !include_subdirs {
        builder.max_depth(Some(1));
    }
    builder
}

/// What one search looks for: the pattern, applied line by line, and a version
/// that can rule out a whole chunk of a file at once.
///
/// The second is what makes a large file affordable, since most of one holds no
/// match. It has to find everything the line-by-line one would, so `^` and `$`
/// mean the ends of a line and \r\n counts as one; a stray hit on a span crossing
/// lines costs nothing, as the lines are then asked one at a time. A pattern
/// that opts out of those meanings has no such version, and is asked line by line.
struct GrepPatterns {
    line: regex::Regex,
    chunk: Option<regex::Regex>,
}

fn compile_patterns(
    term: &str,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<GrepPatterns, regex::Error> {
    let mut pattern = if regex { term.to_string() } else { regex::escape(term) };
    if whole_word {
        pattern = format!(r"\b(?:{})\b", pattern);
    }
    let line = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()?;
    let line_anchored = regex
        && (pattern.contains(r"\A") || pattern.contains(r"\z") || pattern.contains("-m"));
    let chunk = if line_anchored {
        None
    } else {
        regex::RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .multi_line(true)
            .crlf(true)
            .build()
            .ok()
    };
    Ok(GrepPatterns { line, chunk })
}

/// How much of a file is held at a time.
const GREP_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// How far a chunk grows looking for the end of its last line. Past this it is
/// cut where it stands: a match straddling that cut is lost, in a file with a
/// single line this long, which beats holding all of it in memory.
const GREP_MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
/// Files at least this big are named in the progress line: anything smaller is
/// over before the name could be read.
const GREP_NAMED_FILE_BYTES: u64 = 1024 * 1024;

/// The file's encoding (Shift_JIS / EUC-JP / UTF-8 / …), so grep matches text in
/// non-UTF-8 files too.
fn pick_encoding(bytes: &[u8]) -> &'static encoding_rs::Encoding {
    use encoding_rs::{ISO_2022_JP, UTF_8};
    if let Some((encoding, _)) = encoding_rs::Encoding::for_bom(bytes) {
        return encoding;
    }
    // Most files are UTF-8, and checking that is far cheaper than a detector run
    // that would only say the same. Not with an ESC in it: ISO-2022-JP is valid
    // ASCII byte for byte, and only the detector can tell it is Japanese.
    let valid = std::str::from_utf8(bytes).is_ok();
    if valid && !bytes.contains(&0x1B) {
        return UTF_8;
    }
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    // ANSI colours in a log are ESC too, and are not a reason to leave UTF-8.
    if valid && encoding != ISO_2022_JP { UTF_8 } else { encoding }
}

/// Search one file a chunk at a time, however large it is.
///
/// `on_read` is told how many bytes each chunk took; `on_match` gets the line
/// number, the line and where in it the match starts. Either returning false
/// stops the file. A file that looks binary is skipped from its start, without
/// reading the rest: a binary is usually the largest thing in a folder.
fn grep_file(
    path: &std::path::Path,
    patterns: &GrepPatterns,
    on_read: &mut dyn FnMut(u64) -> bool,
    on_match: &mut dyn FnMut(usize, &str, usize) -> bool,
) {
    use std::io::Read;
    const BINARY_CHECK_LEN: u64 = 8000;

    let Ok(mut file) = fs::File::open(path) else { return };
    let mut buf = Vec::new();
    if file.by_ref().take(BINARY_CHECK_LEN).read_to_end(&mut buf).is_err() || buf.contains(&0) {
        return;
    }

    let mut encoding: Option<&'static encoding_rs::Encoding> = None;
    let mut next_line = 1usize;
    let mut target = GREP_CHUNK_BYTES;
    loop {
        let want = target.saturating_sub(buf.len());
        let held = buf.len();
        if file.by_ref().take(want as u64).read_to_end(&mut buf).is_err() {
            return;
        }
        let eof = buf.len() - held < want;

        // Up to the end of the last whole line. A line has no business being cut
        // by where a read happened to stop, and no encoding here uses \n inside
        // a multi-byte character.
        let cut = if eof {
            buf.len()
        } else {
            match memchr::memrchr(b'\n', &buf) {
                Some(at) => at + 1,
                None if target < GREP_MAX_LINE_BYTES => {
                    target *= 2;
                    continue;
                }
                None => buf.len(),
            }
        };
        target = GREP_CHUNK_BYTES;

        let chunk = &buf[..cut];
        let text = match encoding {
            None => {
                let picked = pick_encoding(chunk);
                encoding = Some(picked);
                picked.decode(chunk).0 // drops a BOM: `^` has to match after it
            }
            // A log can run in ASCII for gigabytes before its first Japanese line.
            Some(known) => {
                let known = if known == encoding_rs::UTF_8 && std::str::from_utf8(chunk).is_err() {
                    let again = pick_encoding(chunk);
                    encoding = Some(again);
                    again
                } else {
                    known
                };
                known.decode_without_bom_handling(chunk).0
            }
        };

        let may_match = patterns.chunk.as_ref().map_or(true, |re| re.is_match(&text));
        if may_match {
            for (i, line) in text.lines().enumerate() {
                if let Some(m) = patterns.line.find(line) {
                    if !on_match(next_line + i, line, m.start()) {
                        return;
                    }
                }
            }
        }
        next_line += memchr::memchr_iter(b'\n', text.as_bytes()).count();

        let read = cut as u64;
        drop(text);
        buf.drain(..cut);
        if !on_read(read) || (eof && buf.is_empty()) {
            return;
        }
    }
}

/// A line as the results show it: all of it. Only one past `max_chars` (a minified
/// bundle, a dump on one line) is cut, keeping the hit in view, and says so with
/// a `…`: thousands of hits on lines like that would otherwise fill the memory.
fn shown_line(line: &str, start: usize, max_chars: usize) -> String {
    const LEAD_CHARS: usize = 40;
    if line.len() <= max_chars {
        return line.to_string();
    }
    let before = &line[..start];
    let (from, lead) = if before.chars().count() + LEAD_CHARS < max_chars {
        (0, "")
    } else {
        (before.char_indices().rev().nth(LEAD_CHARS - 1).map_or(0, |(at, _)| at), "…")
    };
    let mut rest = line[from..].chars();
    let shown: String = rest.by_ref().take(max_chars).collect();
    let tail = if rest.next().is_some() { "…" } else { "" };
    format!("{lead}{shown}{tail}")
}

/// How far a search has got, shared between the threads doing it.
#[derive(Default)]
struct GrepScan {
    files: AtomicUsize,
    folders: AtomicUsize,
    folder: Mutex<String>,
    bytes: AtomicU64,
    /// The large file being read: path, bytes so far, size.
    current: Mutex<Option<(String, u64, u64)>>,
}

impl GrepScan {
    fn progress(&self, search_id: f64) -> GrepProgress {
        let current = self.current.lock().ok().and_then(|c| c.clone());
        let (current, current_done, current_size) = current.unwrap_or_default();
        GrepProgress {
            search_id,
            files: self.files.load(Ordering::Relaxed),
            folders: self.folders.load(Ordering::Relaxed),
            folder: self.folder.lock().map(|f| f.clone()).unwrap_or_default(),
            bytes: self.bytes.load(Ordering::Relaxed),
            current,
            current_done,
            current_size,
        }
    }

    fn set_current(&self, value: Option<(String, u64, u64)>) {
        if let Ok(mut current) = self.current.lock() {
            *current = value;
        }
    }
}

fn grep_worker(emit: impl Fn(GrepEvent) + Send + 'static, request: GrepRequest) {
    let GrepRequest {
        dir,
        patterns,
        include_subdirs,
        overrides,
        max_matches,
        search_id,
        my_gen,
    } = request;
    const MAX_LINE_LEN: usize = 20_000;

    let (tx, rx) = unbounded::<GrepMatch>();
    let count = Arc::new(AtomicUsize::new(0));
    let scan = Arc::new(GrepScan::default());

    // Collector: batch incoming matches and emit them to the frontend live. On a
    // timer as well as on arrival: reading a large file can go a long time
    // between matches, and a search that says nothing looks like a hung one.
    let collector_scan = scan.clone();
    let collector = std::thread::spawn(move || {
        use crossbeam_channel::RecvTimeoutError;
        use std::time::{Duration, Instant};
        let mut batch: Vec<GrepMatch> = Vec::new();
        let mut last = Instant::now();
        let mut last_progress = Instant::now();
        let mut total = 0usize;
        loop {
            let ended = match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(m) => {
                    total += 1;
                    batch.push(m);
                    false
                }
                Err(RecvTimeoutError::Timeout) => false,
                Err(RecvTimeoutError::Disconnected) => true,
            };
            if GREP_GEN.load(Ordering::SeqCst) != my_gen {
                // Canceled or superseded. Said out loud, or its tab would show
                // "Searching…" for good.
                if !batch.is_empty() {
                    emit(GrepEvent::Match(GrepBatch { search_id, matches: batch }));
                }
                emit(GrepEvent::Done(GrepDone { search_id, total, truncated: false, canceled: true }));
                return;
            }
            if !batch.is_empty() && (batch.len() >= 50 || last.elapsed().as_millis() > 80) {
                emit(GrepEvent::Match(GrepBatch { search_id, matches: std::mem::take(&mut batch) }));
                last = Instant::now();
            }
            if last_progress.elapsed().as_millis() >= 150 {
                emit(GrepEvent::Progress(collector_scan.progress(search_id)));
                last_progress = Instant::now();
            }
            if ended {
                break;
            }
        }
        if !batch.is_empty() {
            emit(GrepEvent::Match(GrepBatch { search_id, matches: batch }));
        }
        // The final count: "no results" means more with how much was looked at.
        emit(GrepEvent::Progress(collector_scan.progress(search_id)));
        emit(GrepEvent::Done(GrepDone {
            search_id,
            total,
            truncated: total >= max_matches,
            canceled: false,
        }));
    });

    let walker = grep_walk(&dir, include_subdirs, overrides).build_parallel();

    walker.run(|| {
        let tx = tx.clone();
        let patterns = &patterns;
        let count = count.clone();
        let scan = scan.clone();
        Box::new(move |entry| {
            let still_wanted = || {
                GREP_GEN.load(Ordering::SeqCst) == my_gen
                    && count.load(Ordering::Relaxed) < max_matches
            };
            if !still_wanted() {
                return ignore::WalkState::Quit;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return ignore::WalkState::Continue,
            };
            let path = entry.path();
            if path.is_dir() {
                scan.folders.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut folder) = scan.folder.lock() {
                    *folder = path.to_string_lossy().to_string();
                }
                return ignore::WalkState::Continue;
            }
            let path_str = path.to_string_lossy().to_string();
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let named = size >= GREP_NAMED_FILE_BYTES;
            if named {
                scan.set_current(Some((path_str.clone(), 0, size)));
            }

            let mut done = 0u64;
            grep_file(
                path,
                patterns,
                &mut |read| {
                    done += read;
                    scan.bytes.fetch_add(read, Ordering::Relaxed);
                    if named {
                        scan.set_current(Some((path_str.clone(), done, size)));
                    }
                    still_wanted()
                },
                &mut |line_no, line, start| {
                    if count.fetch_add(1, Ordering::Relaxed) >= max_matches {
                        return false;
                    }
                    let _ = tx.send(GrepMatch {
                        path: path_str.clone(),
                        line: line_no,
                        col: line[..start].chars().count() + 1,
                        text: shown_line(line, start, MAX_LINE_LEN),
                    });
                    true
                },
            );

            scan.files.fetch_add(1, Ordering::Relaxed);
            if named {
                scan.set_current(None);
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
    fn a_vcs_store_is_not_walked_but_other_hidden_folders_are() {
        let base = std::env::temp_dir().join(format!("jh_grep_walk_{}", std::process::id()));
        for d in [".git/objects", ".github", "src"] {
            fs::create_dir_all(base.join(d)).unwrap();
        }
        fs::write(base.join(".git/objects/x"), "x").unwrap();
        fs::write(base.join(".git/HEAD"), "x").unwrap();
        fs::write(base.join(".github/ci.yml"), "x").unwrap();
        fs::write(base.join("src/a.txt"), "x").unwrap();
        // A file may be called .git: a worktree's is. Only the folder is the store.
        fs::write(base.join("src/.git"), "x").unwrap();

        let dir = base.to_string_lossy().to_string();
        let mut found: Vec<String> = grep_walk(&dir, true, Override::empty())
            .build()
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.path().strip_prefix(&base).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        found.sort();
        assert_eq!(found, vec![".github/ci.yml", "src/.git", "src/a.txt"]);

        // Pointed at the store on purpose, it is searched.
        let inside = base.join(".git").to_string_lossy().to_string();
        let names = grep_walk(&inside, true, Override::empty()).build().flatten().count();
        let _ = fs::remove_dir_all(&base);
        assert!(names > 1);
    }

    /// Everything a real search says, from the start to its grep-done. The
    /// generation is global, so these take turns. `on_event` may act along the way.
    fn run_search(
        dir: &std::path::Path,
        term: &str,
        max_matches: usize,
        mut on_event: impl FnMut(&GrepEvent, f64),
    ) -> (Vec<GrepMatch>, GrepDone) {
        static TURN: Mutex<()> = Mutex::new(());
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let search_id = 1234.5;
        let my_gen = begin_search(search_id);
        let request = GrepRequest {
            dir: dir.to_string_lossy().to_string(),
            patterns: compile_patterns(term, false, false, false).unwrap(),
            include_subdirs: true,
            overrides: Override::empty(),
            max_matches,
            search_id,
            my_gen,
        };
        let (tx, rx) = unbounded::<GrepEvent>();
        let worker = std::thread::spawn(move || {
            grep_worker(move |event| { let _ = tx.send(event); }, request);
        });
        let mut matches = Vec::new();
        let mut done = None;
        for event in rx {
            on_event(&event, search_id);
            match event {
                GrepEvent::Match(batch) => matches.extend(batch.matches),
                GrepEvent::Done(d) => done = Some(d),
                GrepEvent::Progress(_) => {}
            }
        }
        worker.join().unwrap();
        (matches, done.expect("every search ends by saying so"))
    }

    #[test]
    fn the_limit_is_on_the_whole_search_and_says_when_it_was_reached() {
        let base = std::env::temp_dir().join(format!("jh_grep_limit_{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        for name in ["a.txt", "b.txt", "c.txt"] {
            fs::write(base.join(name), "needle\n".repeat(40)).unwrap();
        }
        let capped = run_search(&base, "needle", 50, |_, _| {});
        let room = run_search(&base, "needle", 1000, |_, _| {});
        let _ = fs::remove_dir_all(&base);
        assert_eq!(capped.0.len(), 50, "across the files, not per file");
        assert!(capped.1.truncated);
        assert_eq!(room.0.len(), 120);
        assert!(!room.1.truncated);
    }

    #[test]
    fn a_search_stops_and_says_so_when_canceled_in_a_file_it_is_part_way_through() {
        let base = std::env::temp_dir().join(format!("jh_grep_cancel_{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        // Larger than a chunk many times over, with a hit on every line.
        let lines = 3 * GREP_CHUNK_BYTES;
        fs::write(base.join("big.txt"), "needle\n".repeat(lines)).unwrap();

        let mut sent = false;
        let (matches, done) = run_search(&base, "needle", usize::MAX, |event, id| {
            if !sent && matches!(event, GrepEvent::Match(_)) {
                sent = true;
                cancel_grep(id);
            }
        });
        let _ = fs::remove_dir_all(&base);
        assert!(done.canceled);
        assert!(!done.truncated);
        assert!(matches.len() < lines, "got {} of {}", matches.len(), lines);
    }

    #[test]
    fn a_line_is_shown_whole_and_only_an_enormous_one_is_cut_around_its_hit() {
        assert_eq!(shown_line("short needle", 6, 500), "short needle");
        // A long line, hit far along it, comes back as it is.
        let long = format!("{}needle{}", "あ".repeat(3000), "い".repeat(3000));
        assert_eq!(shown_line(&long, "あ".len() * 3000, 20_000), long);

        // Past the limit: keep the start of the line while the hit is in it.
        let near = format!("{}needle{}", "a".repeat(50), "b".repeat(1000));
        let cut = shown_line(&near, 50, 500);
        assert!(cut.starts_with("aaa"));
        assert!(cut.ends_with('…'));

        let far = format!("{}needle{}", "あ".repeat(1000), "い".repeat(1000));
        let shown = shown_line(&far, "あ".len() * 1000, 500);
        assert!(shown.starts_with('…'));
        assert!(shown.ends_with('…'));
        assert_eq!(shown.chars().position(|c| c == 'n'), Some(41));
        assert_eq!(shown.chars().count(), 502);
    }

    /// (line number, column, line) of every hit.
    fn grep_all(path: &std::path::Path, term: &str, regex: bool) -> Vec<(usize, usize, String)> {
        let patterns = compile_patterns(term, regex, false, false).unwrap();
        let mut hits = Vec::new();
        grep_file(path, &patterns, &mut |_| true, &mut |n, line, start| {
            hits.push((n, line[..start].chars().count() + 1, line.to_string()));
            true
        });
        hits
    }

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jh_grep_{}_{}", name, std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn remove(path: &std::path::Path) {
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_file_past_any_one_chunk_is_searched_with_the_right_line_numbers() {
        // Three chunks' worth, with hits on either side of each boundary.
        let mut text = String::new();
        let total = 3 * GREP_CHUNK_BYTES / 20;
        for i in 1..=total {
            if i == 1 || i == total / 3 || i == total / 3 + 1 || i == total {
                text.push_str("....needle.........\n");
            } else {
                text.push_str("just some line.....\n");
            }
        }
        assert!(text.len() > 2 * GREP_CHUNK_BYTES);
        let path = temp_file("big.log", text.as_bytes());

        let hits = grep_all(&path, "NEEDLE", false);
        remove(&path);
        let lines: Vec<usize> = hits.iter().map(|h| h.0).collect();
        assert_eq!(lines, vec![1, total / 3, total / 3 + 1, total]);
        assert_eq!(hits[0].1, 5, "column");
    }

    #[test]
    fn a_chunk_ruled_out_at_once_finds_what_the_lines_would() {
        let path = temp_file("anchors.txt", b"first\r\nneedle\r\n  needle  \r\nlast\n");
        let lines = |term: &str| -> Vec<usize> {
            grep_all(&path, term, true).iter().map(|h| h.0).collect()
        };
        assert_eq!(lines("^needle$"), vec![2]);
        assert_eq!(lines(r"\s+needle\s+$"), vec![3]);
        // Means the start of the line when lines are asked one at a time.
        assert_eq!(lines(r"\Aneedle"), vec![2]);
        assert!(compile_patterns(r"\Aneedle", true, false, false).unwrap().chunk.is_none());
        assert!(compile_patterns("needle", false, false, false).unwrap().chunk.is_some());
        // Only ever a stand-in for the line pattern: a hit across lines is no hit.
        assert!(lines(r"first\s+needle").is_empty());
        remove(&path);
    }

    #[test]
    fn one_enormous_line_is_read_whole_up_to_the_limit() {
        let mut text = "x".repeat(GREP_CHUNK_BYTES + 1000);
        text.push_str("needle");
        let path = temp_file("oneline.txt", text.as_bytes());
        let hits = grep_all(&path, "needle", false);
        remove(&path);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, 1);
    }

    #[test]
    fn a_binary_is_left_after_its_start_and_a_stop_is_obeyed() {
        let mut bytes = b"needle\0".to_vec();
        bytes.resize(3 * GREP_CHUNK_BYTES, b'x');
        let binary = temp_file("bin.dat", &bytes);
        let mut reads = 0;
        let patterns = compile_patterns("needle", false, false, false).unwrap();
        grep_file(&binary, &patterns, &mut |_| { reads += 1; true }, &mut |_, _, _| panic!("binary"));
        assert_eq!(reads, 0, "nothing past the first look");
        remove(&binary);

        let text = "needle\n".repeat(GREP_CHUNK_BYTES / 2);
        let path = temp_file("stop.txt", text.as_bytes());
        let mut reads = 0;
        grep_file(&path, &patterns, &mut |_| { reads += 1; false }, &mut |_, _, _| true);
        assert_eq!(reads, 1, "canceled after the chunk it was on");

        let mut hits = 0;
        grep_file(&path, &patterns, &mut |_| true, &mut |_, _, _| { hits += 1; hits < 3 });
        assert_eq!(hits, 3, "the match cap stops mid-chunk");
        remove(&path);
        assert!(grep_all(std::path::Path::new("no/such/file"), "x", false).is_empty());
    }

    #[test]
    fn encodings_are_found_from_the_text() {
        let needle = "テキスト";
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("utf8", format!("日本語の{}です\n", needle).into_bytes()),
            ("sjis", encoding_rs::SHIFT_JIS.encode("日本語のテキストです\n").0.into_owned()),
            // 7-bit, so it passes for UTF-8 unless it is asked about.
            ("jis", b"\x1B$BF|K\\8l$N%F%-%9%H$G$9\x1B(B\n".to_vec()),
        ];
        for (name, bytes) in cases {
            let path = temp_file(name, &bytes);
            let hits = grep_all(&path, needle, false);
            remove(&path);
            assert_eq!(hits.len(), 1, "{}", name);
            assert_eq!(hits[0].1, 5, "{}: column counts characters", name);
        }

        // A BOM is not part of the first line.
        let path = temp_file("bom.txt", b"\xEF\xBB\xBFabc\n");
        assert_eq!(grep_all(&path, "^abc$", true).len(), 1);
        remove(&path);

        // ANSI colours are not ISO-2022-JP.
        assert_eq!(pick_encoding("\x1B[31m日本語のログ\x1B[0m\n".as_bytes()), encoding_rs::UTF_8);
    }

    #[test]
    fn a_log_that_turns_japanese_past_its_first_chunk_is_still_read() {
        let lines = GREP_CHUNK_BYTES / 15;
        let mut bytes = "ascii only line.....\n".repeat(lines).into_bytes();
        bytes.extend(encoding_rs::SHIFT_JIS.encode("障害が発生しました。処理を中断します。\n").0.iter());
        let path = temp_file("late.log", &bytes);
        let hits = grep_all(&path, "障害", false);
        remove(&path);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, lines + 1);
    }

    #[test]
    fn a_file_asked_for_by_name_is_searched_even_when_git_ignores_it() {
        let base = std::env::temp_dir().join(format!("jh_grep_named_{}", std::process::id()));
        fs::create_dir_all(base.join(".git")).unwrap();
        fs::write(base.join(".gitignore"), "*.log\n").unwrap();
        fs::write(base.join("big.log"), "x").unwrap();
        fs::write(base.join("a.txt"), "x").unwrap();
        let files = |dir: &std::path::Path, globs: Option<&str>| -> Vec<String> {
            let d = dir.to_string_lossy().to_string();
            let root = base.to_string_lossy().to_string();
            let mut found: Vec<String> = grep_walk(&d, true, build_overrides(&root, globs).unwrap())
                .build()
                .flatten()
                .filter(|e| e.path().is_file())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            found.sort();
            found
        };
        // What the dialog's three ways of asking come to.
        let everything = files(&base, None);
        let by_glob = files(&base, Some("*.log"));
        let by_name = files(&base.join("big.log"), None);
        let _ = fs::remove_dir_all(&base);
        assert!(!everything.contains(&"big.log".to_string()), "{:?}", everything);
        assert_eq!(by_glob, vec!["big.log"]);
        assert_eq!(by_name, vec!["big.log"]);
    }

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

    /// The backlink pattern is built in JS (src/modules/utils/Backlinks.js)
    /// and compiled HERE by start_grep. This is its output for
    /// `THIRD-PARTY-NOTICES.md`: if the two engines ever disagree on syntax,
    /// the search fails to start rather than quietly finding nothing.
    #[test]
    fn backlink_pattern_compiles_and_matches() {
        let pattern = r#"\[\[(?:[^\]|#\n]*[/\\])?THIRD-PARTY-NOTICES(?:\.md)?\s*[|#\]]|\]\(\s*<?(?:[^()\s<>]*[/\\])?THIRD-PARTY-NOTICES\.md(?:#[^()\s<>]*)?>?(?:\s|\))|^\s*\[[^\]]+\]:\s*<?(?:[^\s<>]*[/\\])?THIRD-PARTY-NOTICES\.md(?:#\S*)?>?(?:\s|$)"#;
        let re = regex::RegexBuilder::new(pattern)
            .case_insensitive(true)
            .build()
            .expect("backlink pattern must compile in the Rust engine");
        assert!(re.is_match("一覧は [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) にあります。"));
        assert!(re.is_match("[[docs/THIRD-PARTY-NOTICES|notices]]"));
        assert!(re.is_match("[n]: ./THIRD-PARTY-NOTICES.md"));
        assert!(!re.is_match("`THIRD-PARTY-NOTICES.md`"));
        assert!(!re.is_match("[x](./MY-THIRD-PARTY-NOTICES.md)"));
    }
}

#[cfg(test)]
mod search_id_tests {
    /// Events are matched to their tab by comparing this id exactly, and
    /// serde_json may round a fraction when reading it: this one came back
    /// one bit off, and the tab never heard from its own search. Whole numbers
    /// (src/modules/utils/SearchId.js) arrive intact.
    #[test]
    fn a_whole_number_id_survives_the_trip_and_a_fraction_may_not() {
        let whole: f64 = serde_json::from_str("1794216410306123").unwrap();
        assert_eq!(whole, 1794216410306123.0);
        let fraction: f64 = serde_json::from_str("1794216410306.9321").unwrap();
        assert_ne!(fraction, "1794216410306.9321".parse::<f64>().unwrap());
    }
}
