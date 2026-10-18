use std::fs;
use std::io::Write;
use std::collections::{HashMap, HashSet};
use chardetng::EncodingDetector;
use tauri::{command, State};
use std::sync::{Arc, Mutex};
use crate::models::{FileEntry, FileContent};

/// Per-window workspace roots, keyed by the calling webview's label. With one
/// process hosting several windows, each window has its own workspace. A std
/// Mutex (not tokio) so it can be locked from the single-instance callback too.
pub struct WorkspaceState {
    pub roots: Arc<Mutex<HashMap<String, String>>>,
    /// Directories already handed to the asset protocol.
    ///
    /// `allow_directory` appends a pattern every time it is called, so granting
    /// the same folder on each file read would grow the list for as long as the
    /// session lasts.
    pub asset_dirs: Arc<Mutex<HashSet<String>>>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            roots: Arc::new(Mutex::new(HashMap::new())),
            asset_dirs: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

/// Let the asset protocol read from `dir`.
///
/// Markdown images go through convertFileSrc(), and every such request is
/// checked against assetProtocol.scope — which is `$HOME/**`. A document
/// anywhere else has its images denied and shows alt text instead.
///
/// Granted per directory the user actually opened rather than by widening the
/// configured scope to `**`, which would let a document name any path on the
/// machine. Remembered so the pattern list does not grow with every read.
fn allow_asset_dir(webview: &tauri::WebviewWindow, dir: &std::path::Path,
                   state: &State<'_, WorkspaceState>) {
    use tauri::Manager;

    let key = dir.to_string_lossy().to_string();
    {
        let mut seen = state.asset_dirs.lock().unwrap();
        if !seen.insert(key.clone()) {
            return;
        }
    }
    if let Err(e) = webview.asset_protocol_scope().allow_directory(dir, true) {
        // Not fatal: the file still opens, its images just stay blocked.
        log::warn!("could not allow {key} for the asset protocol: {e}");
    }
}

#[command(async)]
pub fn set_workspace_root(
    webview: tauri::WebviewWindow,
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let label = webview.label().to_string();

    // Let the workspace's own files render.
    //
    // Markdown images go through convertFileSrc(), and the asset protocol
    // checks every request against assetProtocol.scope. That scope is
    // `$HOME/**`, so a workspace anywhere else — C:\cusor_workspace\… , a
    // second drive, a network share — has every image denied, and the document
    // shows nothing but alt text.
    //
    // Widening the configured scope to `**` would fix it by letting a document
    // name any path on the machine, opened or not. Granting it here instead
    // keeps it to the directory the user actually opened.
    if !path.is_empty() {
        allow_asset_dir(&webview, std::path::Path::new(&path), &state);
    }

    let mut roots = state.roots.lock().unwrap();
    if path.is_empty() {
        roots.remove(&label);
    } else {
        roots.insert(label, path);
    }
    Ok(())
}

#[command(async)]
pub fn read_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let is_directory = path.is_dir();
        result.push(FileEntry {
            name,
            is_directory,
            path: path.to_string_lossy().to_string(),
        });
    }
    Ok(result)
}

#[command(async)]
pub fn read_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| e.to_string())
}

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// Turn the editor's text into the bytes that go on disk.
///
/// Two things here used to change a file without a word:
///
/// - `encode` does not fail on a character the encoding has no code for — it
///   writes `&#NNNN;` in its place. An emoji typed into a Shift_JIS file came
///   back as markup. Refusing is the only honest answer: the buffer stays
///   dirty, nothing on disk changes, and the message says what to do.
/// - Reading strips a UTF-8 BOM, and writing never put it back. A file that
///   had one keeps it.
pub(crate) fn encode_for_disk(content: &str, encoding_label: &str, had_bom: bool) -> Result<Vec<u8>, String> {
    let encoding = encoding_rs::Encoding::for_label(encoding_label.as_bytes())
        .ok_or(format!("Unsupported encoding: {}", encoding_label))?;
    // UTF-16 labels encode as UTF-8 in encoding_rs; saying UTF-16 and writing
    // UTF-8 would be a silent conversion, so it is refused as well.
    if encoding.output_encoding() != encoding {
        return Err(format!("Saving as {} is not supported. Choose UTF-8 instead.", encoding.name()));
    }
    let (encoded, _, had_errors) = encoding.encode(content);
    if had_errors {
        return Err(format!(
            "Some characters cannot be written in {}. Nothing was saved. Change the file's encoding to UTF-8, or remove those characters.",
            encoding.name()
        ));
    }
    let mut bytes = encoded.into_owned();
    if had_bom && encoding == encoding_rs::UTF_8 && !bytes.starts_with(UTF8_BOM) {
        bytes.splice(0..0, UTF8_BOM.iter().copied());
    }
    Ok(bytes)
}

static SAVE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Replace a file's contents so that, at every moment, the file on disk is
/// either the old version or the new one — never empty, never half written.
///
/// `File::create` truncates first and writes after. A crash, a forced quit
/// from Task Manager, a full disk or a dropped network share in between left
/// an empty or cut-off file where the user's document had been. Here the new
/// bytes go to a temporary file in the same folder, are flushed to the disk,
/// and only then take the old file's place in one rename.
///
/// Falls back to writing in place (the old behaviour, so never worse than
/// before) when that is not possible: the folder does not let us create a
/// file, the target is hidden/system (a rename would drop those attributes),
/// or the rename keeps failing because something holds the file open.
pub(crate) fn write_replacing(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    // Save through a symlink to its target, so the link itself survives.
    let target = match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let existing = fs::metadata(&target).ok();
    if let Some(m) = &existing {
        if m.permissions().readonly() {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "The file is read-only."));
        }
        if keeps_attributes_only_in_place(m) {
            return write_in_place(&target, bytes);
        }
    }

    let dir = match target.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => std::path::PathBuf::from("."),
    };
    let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let seq = SAVE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{}.{}-{}.jh-save", name, std::process::id(), seq));

    let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
        Ok(f) => f,
        // No right to create files here, but perhaps to rewrite this one.
        Err(_) => return write_in_place(&target, bytes),
    };
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    // A virus scanner or the search indexer often has a just-written file open
    // for a moment; Windows refuses the rename until it lets go.
    let mut last_err = None;
    for attempt in 0..6u64 {
        match fs::rename(&tmp, &target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(40 * (attempt + 1)));
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    match write_in_place(&target, bytes) {
        Ok(()) => Ok(()),
        Err(e) => Err(last_err.unwrap_or(e)),
    }
}

/// Hidden and system files lose those attributes if replaced by a rename.
#[cfg(windows)]
fn keeps_attributes_only_in_place(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    m.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn keeps_attributes_only_in_place(_m: &fs::Metadata) -> bool {
    false
}

/// Truncate-and-write, flushed. `truncate` rather than `create`: on Windows
/// `File::create` is refused for a hidden file.
fn write_in_place(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn starts_with_bom(path: &str) -> bool {
    use std::io::Read;
    let mut head = [0u8; 3];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map(|_| head == UTF8_BOM)
        .unwrap_or(false)
}

#[command(async)]
pub fn write_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let encoding_label = encoding.as_deref().unwrap_or("utf-8");
    let bytes = encode_for_disk(&content, encoding_label, starts_with_bom(&path))?;
    write_replacing(std::path::Path::new(&path), &bytes).map_err(|e| e.to_string())
}

/// Write raw bytes (pasted images, downloaded assets…). Parent directories are
/// created as needed so callers don't have to pre-make `assets/`.
#[command(async)]
pub fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_replacing(std::path::Path::new(&path), &bytes).map_err(|e| e.to_string())
}

#[command(async)]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

#[command(async)]
pub fn remove_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

#[command(async)]
pub fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(old_path, new_path).map_err(|e| e.to_string())
}

#[command(async)]
pub fn copy_file_cmd(source: String, dest: String) -> Result<(), String> {
    fs::copy(source, dest)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Size and modification time, for the status bar and the save-conflict check.
///
/// This exists because the JS side cannot get it. `@tauri-apps/plugin-fs`'s
/// `stat` is limited by the plugin's `fs:scope`, which allows `$HOME/**` — so
/// for a workspace anywhere else the call was denied, the error was swallowed
/// as "no stats", and the file's modification date simply never appeared.
///
/// Every other read and write in this app goes through commands like the ones
/// around this, which take a path and use it. Doing the same here makes the
/// behaviour consistent rather than dependent on where the project happens to
/// live.
#[derive(serde::Serialize)]
pub struct FileStats {
    pub size: u64,
    /// Milliseconds since the epoch, so `new Date(mtime)` is exact. Null when
    /// the platform does not record one.
    pub mtime: Option<f64>,
}

#[command(async)]
pub fn file_stats(path: String) -> Result<FileStats, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64);
    Ok(FileStats { size: meta.len(), mtime })
}

/// One note, as the notes browser needs to draw a row for it.
#[derive(serde::Serialize)]
pub struct NoteEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: Option<f64>,
    /// The note's first non-blank line, with any leading `#` taken off, capped
    /// at 120 characters. A note's title is the first thing in it — asking the
    /// frontend to read every file to find that out would be one IPC round trip
    /// per note, so it is read here, where the directory is already open.
    pub title: String,
}

/// List the .md files in one directory, newest first, each with its title.
///
/// Not recursive and not general-purpose: this is for the notes folders, which
/// are flat by construction. A missing directory is an empty list, not an
/// error — there are simply no notes yet.
#[command(async)]
pub fn list_notes(dir: String) -> Result<Vec<NoteEntry>, String> {
    let read = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out: Vec<NoteEntry> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_md = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64);
        out.push(NoteEntry {
            title: note_title(&path),
            path: path.to_string_lossy().replace('\\', "/"),
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            size: meta.len(),
            mtime,
        });
    }
    // Newest first: a notes list is a stack, not an alphabet.
    out.sort_by(|a, b| b.mtime.unwrap_or(0.0).total_cmp(&a.mtime.unwrap_or(0.0)));
    Ok(out)
}

/// First non-blank line of a note, minus its heading marks.
fn note_title(path: &std::path::Path) -> String {
    // Only the head of the file: a note's title cannot be on line 5000, and
    // reading a large one in full to find that out would defeat the point.
    let mut buf = [0u8; 4096];
    let read = {
        use std::io::Read;
        match fs::File::open(path).and_then(|mut f| f.read(&mut buf)) {
            Ok(n) => n,
            Err(_) => 0,
        }
    };
    let head = String::from_utf8_lossy(&buf[..read]);
    for line in head.lines() {
        let t = line.trim_start_matches(['#', ' ', '\t']).trim();
        if !t.is_empty() {
            return t.chars().take(120).collect();
        }
    }
    String::new()
}

#[command(async)]
pub fn exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[command(async)]
pub fn read_file_auto_detect(
    webview: tauri::WebviewWindow,
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<FileContent, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;

    // Opening a single file sets no workspace, so this is the only chance to
    // let its own folder through. Relative image paths resolve against it.
    if let Some(dir) = std::path::Path::new(&path).parent() {
        allow_asset_dir(&webview, dir, &state);
    }

    decode_auto_detect(&bytes)
}

/// The decoding half of `read_file_auto_detect`: refuse binary, guess the
/// encoding, decode. Kept apart from the command so it can be tested without a
/// webview and workspace state, which only the asset-scope side needs.
fn decode_auto_detect(bytes: &[u8]) -> Result<FileContent, String> {
    let check_len = std::cmp::min(bytes.len(), 1024);
    if bytes[0..check_len].contains(&0) {
        return Err("Binary file detected".to_string());
    }

    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);

    let (cow, _encoding_used, malformed) = encoding.decode(bytes);

    Ok(FileContent {
        content: cow.to_string(),
        encoding: encoding.name().to_string(),
        lossy: malformed,
    })
}

#[command(async)]
pub fn read_file_with_encoding(path: String, encoding: String) -> Result<FileContent, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;

    let encoding = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or(format!("Unsupported encoding: {}", encoding))?;

    let (cow, _, malformed) = encoding.decode(&bytes);

    Ok(FileContent {
        content: cow.to_string(),
        encoding: encoding.name().to_string(),
        lossy: malformed,
    })
}

#[command]
pub fn paste_files() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use clipboard_win::{formats, Clipboard, Getter};
        let _clip = Clipboard::new_attempts(10).map_err(|e| e.to_string())?;
        let mut file_list: Vec<String> = Vec::new();
        match formats::FileList.read_clipboard(&mut file_list) {
            Ok(_) => Ok(file_list),
            Err(_) => Ok(Vec::new())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}
#[command]
pub async fn list_recursive(
    app: tauri::AppHandle,
    path: String
) -> Result<Vec<FileEntry>, String> {
    use tauri::Emitter;
    use crate::models::SearchProgress;

    let mut results = Vec::new();
    let root = std::path::PathBuf::from(&path);
    
    // Stack: (Path, CurrentDepth)
    let mut stack = vec![(root.clone(), 0)];
    
    // Limits
    let max_items = 10000;
    let default_max_depth = 3;
    let deep_max_depth = 10;
    
    // Folders to deep scan
    let priority_folders = ["src", "lib", "app", "test", "include", "main", "packages"];

    let mut scanned_count = 0;

    while let Some((current, depth)) = stack.pop() {
        if results.len() >= max_items {
            break;
        }

        if let Ok(entries) = fs::read_dir(&current) {
            for entry in entries.flatten() {
                if results.len() >= max_items {
                    break;
                }

                let p = entry.path();
                let is_dir = p.is_dir();
                let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                let name_lower = name.to_lowercase();

                // Exclusions
                if name_lower == ".git" || name_lower == "node_modules" || 
                   name_lower == "target" || name_lower == "dist" || 
                   name_lower == "build" || name_lower == "venv" || 
                   name_lower == ".idea" || name_lower == ".vscode" ||
                   name_lower == "bin" || name_lower == "obj" {
                    continue;
                }

                scanned_count += 1;
                results.push(FileEntry {
                    name,
                    is_directory: is_dir,
                    path: p.to_string_lossy().to_string(),
                });

                if is_dir {
                    // Determine max depth for this branch
                    let is_priority = priority_folders.iter().any(|&f| name_lower.contains(f));
                    let branch_max_depth = if is_priority { deep_max_depth } else { default_max_depth };

                    if depth < branch_max_depth {
                        stack.push((p.clone(), depth + 1));
                    }
                }

                // Periodic Progress Report (Every 100 items for smoothness)
                if scanned_count % 100 == 0 {
                    let _ = app.emit("scan-progress", SearchProgress {
                        scanned: scanned_count,
                        found: results.len(),
                        current_path: p.to_string_lossy().to_string(),
                        total: 0, // Unknown
                        search_id: 0.0,
                    });
                }
            }
        }
    }
    
    // Final report
    let _ = app.emit("scan-progress", SearchProgress {
        scanned: scanned_count,
        found: results.len(),
        current_path: "Complete".to_string(),
        total: 0,
        search_id: 0.0,
    });

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jh_save_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_replaces_the_file_and_leaves_no_temp_behind() {
        let dir = scratch("replace");
        let file = dir.join("doc.md");
        fs::write(&file, b"old text").unwrap();
        write_replacing(&file, b"new text").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"new text");
        let left: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left.len(), 1, "temporary file left behind: {:?}", left);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_creates_a_new_file() {
        let dir = scratch("create");
        let file = dir.join("new.txt");
        write_replacing(&file, b"hello").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"hello");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_refuses_a_read_only_file_and_leaves_it_alone() {
        let dir = scratch("readonly");
        let file = dir.join("ro.txt");
        fs::write(&file, b"keep me").unwrap();
        let mut perm = fs::metadata(&file).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&file, perm.clone()).unwrap();
        assert!(write_replacing(&file, b"overwritten").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"keep me");
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(false);
        fs::set_permissions(&file, perm).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_character_the_encoding_cannot_hold_is_refused_not_rewritten() {
        // encoding_rs would otherwise write "&#128512;" for the emoji.
        let err = encode_for_disk("日本語 😀", "Shift_JIS", false).unwrap_err();
        assert!(err.contains("Nothing was saved"), "{}", err);
        assert!(encode_for_disk("日本語", "Shift_JIS", false).is_ok());
    }

    #[test]
    fn a_utf8_bom_survives_the_round_trip() {
        let bytes = encode_for_disk("abc", "UTF-8", true).unwrap();
        assert_eq!(bytes, b"\xEF\xBB\xBFabc");
        let plain = encode_for_disk("abc", "UTF-8", false).unwrap();
        assert_eq!(plain, b"abc");
        // The BOM is not doubled when the text already carries one.
        let again = encode_for_disk("\u{FEFF}abc", "UTF-8", true).unwrap();
        assert_eq!(again, b"\xEF\xBB\xBFabc");
    }

    #[test]
    fn utf16_is_refused_rather_than_written_as_utf8() {
        assert!(encode_for_disk("abc", "UTF-16LE", false).is_err());
    }

    #[test]
    fn undecodable_bytes_are_reported() {
        let ok = decode_auto_detect("plain ascii".as_bytes()).unwrap();
        assert!(!ok.lossy);
        // Not FF FE first: decode() would sniff that as a UTF-16 BOM.
        let bad = read_file_with_encoding_bytes(b"ok \xFF\xFD ok", "UTF-8");
        assert!(bad.lossy);
    }

    fn read_file_with_encoding_bytes(bytes: &[u8], label: &str) -> FileContent {
        let dir = scratch("lossy");
        let file = dir.join("x.bin");
        fs::write(&file, bytes).unwrap();
        let r = read_file_with_encoding(file.to_string_lossy().to_string(), label.to_string()).unwrap();
        let _ = fs::remove_dir_all(&dir);
        r
    }

    #[test]
    fn test_exists() {
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("jh_test_exists.txt");
        let path_str = file_path.to_string_lossy().to_string();

        let _ = fs::remove_file(&file_path); // clean if exists
        assert!(!exists(path_str.clone()));

        fs::write(&file_path, b"test").unwrap();
        assert!(exists(path_str.clone()));

        fs::remove_file(&file_path).unwrap();
        assert!(!exists(path_str.clone()));
    }

    #[test]
    fn test_write_and_read_file() {
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("jh_test_io.txt");
        let path_str = file_path.to_string_lossy().to_string();

        let _ = fs::remove_file(&file_path);
        write_file(path_str.clone(), "Hello World".to_string(), None).unwrap();

        let bytes = read_file(path_str.clone()).unwrap();
        assert_eq!(bytes, b"Hello World");

        let content = decode_auto_detect(&read_file(path_str.clone()).unwrap()).unwrap();
        assert_eq!(content.content, "Hello World");
        assert_eq!(content.encoding, "UTF-8");

        fs::remove_file(&file_path).unwrap();
    }

    #[test]
    fn test_decode_auto_detect_refuses_binary_and_reads_shift_jis() {
        assert!(decode_auto_detect(b"PK\x03\x04\x00\x00").is_err());
        assert_eq!(decode_auto_detect(b"").unwrap().content, "");

        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("これは日本語のテキストです。文字コードを判定します。");
        let content = decode_auto_detect(&sjis).unwrap();
        assert_eq!(content.content, "これは日本語のテキストです。文字コードを判定します。");
        assert_eq!(content.encoding, "Shift_JIS");
    }

    #[test]
    fn test_write_file_with_encoding() {
        let temp_dir = std::env::temp_dir();
        let file_path = temp_dir.join("jh_test_encoding.txt");
        let path_str = file_path.to_string_lossy().to_string();

        let _ = fs::remove_file(&file_path);
        // Write Shift-JIS text (Japanese chars)
        write_file(path_str.clone(), "こんにちは".to_string(), Some("shift_jis".to_string())).unwrap();

        let content = read_file_with_encoding(path_str.clone(), "shift_jis".to_string()).unwrap();
        assert_eq!(content.content, "こんにちは");

        fs::remove_file(&file_path).unwrap();
    }

    #[test]
    fn test_create_and_remove_dir() {
        let temp_dir = std::env::temp_dir();
        let dir_path = temp_dir.join("jh_test_dir");
        let path_str = dir_path.to_string_lossy().to_string();

        let _ = fs::remove_dir_all(&dir_path);
        assert!(!dir_path.exists());
        create_dir(path_str.clone()).unwrap();
        assert!(dir_path.exists());

        remove_file(path_str.clone()).unwrap();
        assert!(!dir_path.exists());
    }

    #[test]
    fn test_rename_and_copy_file() {
        let temp_dir = std::env::temp_dir();
        let file1 = temp_dir.join("jh_test_rename1.txt");
        let file2 = temp_dir.join("jh_test_rename2.txt");
        let file3 = temp_dir.join("jh_test_rename3.txt");

        let path1 = file1.to_string_lossy().to_string();
        let path2 = file2.to_string_lossy().to_string();
        let path3 = file3.to_string_lossy().to_string();

        let _ = fs::remove_file(&file1);
        let _ = fs::remove_file(&file2);
        let _ = fs::remove_file(&file3);

        // Write file1
        fs::write(&file1, b"rename test").unwrap();

        // Copy file1 to file2
        copy_file_cmd(path1.clone(), path2.clone()).unwrap();
        assert!(file2.exists());

        // Rename file2 to file3
        rename_file(path2.clone(), path3.clone()).unwrap();
        assert!(!file2.exists());
        assert!(file3.exists());

        fs::remove_file(&file1).unwrap();
        fs::remove_file(&file3).unwrap();
    }
}

#[command]
pub async fn parse_excel_to_markdown(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    use calamine::{Xlsx, Xls, Ods, open_workbook_from_rs};
    use std::io::Cursor;

    let cursor = Cursor::new(bytes);
    let ext_lower = ext.to_lowercase();

    if ext_lower == "xlsx" {
        let mut workbook = open_workbook_from_rs::<Xlsx<_>, _>(cursor)
            .map_err(|e| format!("Failed to open XLSX workbook: {}", e))?;
        process_workbook(&mut workbook)
    } else if ext_lower == "xls" {
        let mut workbook = open_workbook_from_rs::<Xls<_>, _>(cursor)
            .map_err(|e| format!("Failed to open XLS workbook: {}", e))?;
        process_workbook(&mut workbook)
    } else if ext_lower == "ods" {
        let mut workbook = open_workbook_from_rs::<Ods<_>, _>(cursor)
            .map_err(|e| format!("Failed to open ODS workbook: {}", e))?;
        process_workbook(&mut workbook)
    } else {
        Err(format!("Unsupported Excel extension: {}", ext))
    }
}

fn process_workbook<R, RS>(workbook: &mut R) -> Result<String, String>
where
    R: calamine::Reader<RS>,
    RS: std::io::Read + std::io::Seek,
{
    let mut output = String::new();
    let sheet_names = workbook.sheet_names().to_vec();

    for sheet_name in sheet_names {
        if let Ok(range) = workbook.worksheet_range(&sheet_name) {
            output.push_str(&format!("### Sheet: {}\n", sheet_name));
            
            let rows: Vec<_> = range.rows().collect();
            if rows.is_empty() {
                output.push_str("*Empty sheet*\n\n");
                continue;
            }

            let col_count = rows[0].len();
            output.push('|');
            for cell in rows[0].iter() {
                output.push_str(&format!(" {} |", format_cell(cell)));
            }
            output.push('\n');

            output.push('|');
            for _ in 0..col_count {
                output.push_str("---|");
            }
            output.push('\n');

            for row in rows.iter().skip(1) {
                output.push('|');
                for cell in row.iter() {
                    output.push_str(&format!(" {} |", format_cell(cell)));
                }
                output.push('\n');
            }
            output.push('\n');
        }
    }

    Ok(output)
}

fn format_cell(cell: &calamine::Data) -> String {
    match cell {
        calamine::Data::Empty => "".to_string(),
        calamine::Data::String(s) => s.replace("\n", " ").replace("|", "\\|"),
        calamine::Data::Float(f) => f.to_string(),
        calamine::Data::Int(i) => i.to_string(),
        calamine::Data::Bool(b) => b.to_string(),
        calamine::Data::DateTime(d) => d.to_string(),
        calamine::Data::Error(err) => format!("Error: {:?}", err),
        _ => "".to_string(),
    }
}

#[derive(serde::Serialize)]
pub struct DirDiffEntry {
    /// "A" added (right only), "D" deleted (left only), "M" modified, "S" same
    pub status: String,
    /// Path relative to the compared roots (forward slashes).
    pub path: String,
    pub left: Option<String>,
    pub right: Option<String>,
}

/// Recursively compare two directory trees.
///
/// Files present in both are compared BY CONTENT (size first, then bytes) so
/// unchanged files can be filtered out. Files on one side only are reported as
/// added/deleted. Comparison is done here rather than in JS because it means
/// reading every file once, natively, instead of shuttling whole trees over IPC.
#[command(async)]
pub fn diff_directories(
    left_root: String,
    right_root: String,
    include_same: Option<bool>,
) -> Result<Vec<DirDiffEntry>, String> {
    use std::collections::BTreeMap;

    fn collect(root: &std::path::Path, base: &std::path::Path, out: &mut BTreeMap<String, std::path::PathBuf>) {
        let rd = match std::fs::read_dir(root) {
            Ok(rd) => rd,
            Err(_) => return, // unreadable dir: skip rather than fail the whole diff
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Noise that would swamp a source-tree comparison.
            if name == ".git" || name == "node_modules" || name == "target" || name == "dist" {
                continue;
            }
            if p.is_dir() {
                collect(&p, base, out);
            } else if let Ok(rel) = p.strip_prefix(base) {
                out.insert(rel.to_string_lossy().replace('\\', "/"), p.clone());
            }
        }
    }

    let lroot = std::path::Path::new(&left_root);
    let rroot = std::path::Path::new(&right_root);
    if !lroot.is_dir() || !rroot.is_dir() {
        return Err("Both paths must be existing directories.".into());
    }

    let mut lmap = BTreeMap::new();
    let mut rmap = BTreeMap::new();
    collect(lroot, lroot, &mut lmap);
    collect(rroot, rroot, &mut rmap);

    let want_same = include_same.unwrap_or(false);
    let mut out = Vec::new();

    for (rel, lpath) in &lmap {
        match rmap.get(rel) {
            Some(rpath) => {
                let same = files_equal(lpath, rpath);
                if same && !want_same {
                    continue;
                }
                out.push(DirDiffEntry {
                    status: if same { "S".into() } else { "M".into() },
                    path: rel.clone(),
                    left: Some(lpath.to_string_lossy().replace('\\', "/")),
                    right: Some(rpath.to_string_lossy().replace('\\', "/")),
                });
            }
            None => out.push(DirDiffEntry {
                status: "D".into(),
                path: rel.clone(),
                left: Some(lpath.to_string_lossy().replace('\\', "/")),
                right: None,
            }),
        }
    }
    for (rel, rpath) in &rmap {
        if !lmap.contains_key(rel) {
            out.push(DirDiffEntry {
                status: "A".into(),
                path: rel.clone(),
                left: None,
                right: Some(rpath.to_string_lossy().replace('\\', "/")),
            });
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Byte-compare two files, cheaply rejecting on size first.
fn files_equal(a: &std::path::Path, b: &std::path::Path) -> bool {
    let (ma, mb) = match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(x), Ok(y)) => (x, y),
        _ => return false,
    };
    if ma.len() != mb.len() {
        return false;
    }
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}
