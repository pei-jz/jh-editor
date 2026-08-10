use std::fs;
use std::io::Write;
use std::collections::HashMap;
use chardetng::EncodingDetector;
use tauri::{command, State};
use std::sync::{Arc, Mutex};
use crate::models::{FileEntry, FileContent};

/// Per-window workspace roots, keyed by the calling webview's label. With one
/// process hosting several windows, each window has its own workspace. A std
/// Mutex (not tokio) so it can be locked from the single-instance callback too.
pub struct WorkspaceState {
    pub roots: Arc<Mutex<HashMap<String, String>>>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            roots: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[command]
pub fn set_workspace_root(
    webview: tauri::WebviewWindow,
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let mut roots = state.roots.lock().unwrap();
    if path.is_empty() {
        roots.remove(&label);
    } else {
        roots.insert(label, path);
    }
    Ok(())
}

#[command]
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

#[command]
pub fn read_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| e.to_string())
}

#[command]
pub fn write_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let encoding_label = encoding.as_deref().unwrap_or("utf-8");
    let encoding = encoding_rs::Encoding::for_label(encoding_label.as_bytes())
        .ok_or(format!("Unsupported encoding: {}", encoding_label))?;

    let (encoded_bytes, _, _) = encoding.encode(&content);

    let mut file = fs::File::create(path).map_err(|e| e.to_string())?;
    file.write_all(&encoded_bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Write raw bytes (pasted images, downloaded assets…). Parent directories are
/// created as needed so callers don't have to pre-make `assets/`.
#[command]
pub fn write_file_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

#[command]
pub fn remove_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

#[command]
pub fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(old_path, new_path).map_err(|e| e.to_string())
}

#[command]
pub fn copy_file_cmd(source: String, dest: String) -> Result<(), String> {
    fs::copy(source, dest)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[command]
pub fn exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[command]
pub fn read_file_auto_detect(path: String) -> Result<FileContent, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;

    let check_len = std::cmp::min(bytes.len(), 1024);
    if bytes[0..check_len].contains(&0) {
        return Err("Binary file detected".to_string());
    }

    let mut detector = EncodingDetector::new();
    detector.feed(&bytes, true);
    let encoding = detector.guess(None, true);

    let (cow, _encoding_used, _malformed) = encoding.decode(&bytes);

    Ok(FileContent {
        content: cow.to_string(),
        encoding: encoding.name().to_string(),
    })
}

#[command]
pub fn read_file_with_encoding(path: String, encoding: String) -> Result<FileContent, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;

    let encoding = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or(format!("Unsupported encoding: {}", encoding))?;

    let (cow, _, _) = encoding.decode(&bytes);

    Ok(FileContent {
        content: cow.to_string(),
        encoding: encoding.name().to_string(),
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

        let content = read_file_auto_detect(path_str.clone()).unwrap();
        assert_eq!(content.content, "Hello World");
        assert_eq!(content.encoding, "UTF-8");

        fs::remove_file(&file_path).unwrap();
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
#[command]
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
