use std::process::Command;
use serde::{Serialize, Deserialize};
use chardetng::EncodingDetector;

/// Decode raw bytes using chardetng auto-detection, falling back to UTF-8 lossy.
fn decode_git_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let check_len = std::cmp::min(bytes.len(), 1024);
    if bytes[..check_len].contains(&0) {
        return String::from_utf8_lossy(bytes).to_string();
    }
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (cow, _, _) = encoding.decode(bytes);
    cow.to_string()
}

fn git_command() -> Command {
    let mut cmd = Command::new("git");
    // Prevent git from quoting non-ASCII filenames (e.g. Japanese) as octal escapes.
    // With this, filenames are emitted as raw UTF-8.
    cmd.args(["-c", "core.quotepath=false"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub staged: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
    pub untracked: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub author_email: String,
    pub date: String,
    pub parents: Vec<String>,
    pub refs: String,
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    let output = git_command()
        .args(["status", "--porcelain", "-b", "-uall"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = decode_git_bytes(&output.stdout);
    let mut lines = stdout.lines();
    
    let mut branch = String::from("unknown");
    let mut staged = Vec::new();
    let mut modified = Vec::new();
    let mut deleted = Vec::new();
    let mut untracked = Vec::new();

    if let Some(first_line) = lines.next() {
        if first_line.starts_with("## ") {
            branch = first_line[3..].split("...").next().unwrap_or("unknown").to_string();
        }
    }

    for line in lines {
        if line.len() < 3 { continue; }
        let status = &line[0..2];
        let file = line[3..].to_string();

        // Worktree-deleted: " D" (space then D) or "UD"/"DD" (conflict) → the
        // file is gone on disk but still in HEAD, so we can diff HEAD→empty.
        if status.starts_with('D') || (status.len() == 2 && status.ends_with('D')) {
            if status.starts_with("D ") {
                staged.push(file);
            } else {
                deleted.push(file);
            }
            continue;
        }

        match status {
            "M " | "A " | "R " | "C " => staged.push(file),
            " M" | " D" => { if status == " D" { deleted.push(file); } else { modified.push(file); } },
            "??" => untracked.push(file),
            "UU" => modified.push(file), // Conflict
            _ => {
                if status.starts_with('M') || status.starts_with('A') {
                    staged.push(file);
                } else {
                    modified.push(file);
                }
            }
        }
    }

    Ok(GitStatus { branch, staged, modified, deleted, untracked })
}


#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    let output = git_command()
        .args(["commit", "-m", &message])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(decode_git_bytes(&output.stdout))
}

#[tauri::command]
pub async fn git_add(path: String, file: String) -> Result<(), String> {
    let output = git_command()
        .args(["add", &file])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn git_unstage(path: String, file: String) -> Result<(), String> {
    let output = git_command()
        .args(["reset", "HEAD", &file])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn git_log(path: String, count: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let count_val = count.unwrap_or(30);
    let count_str = count_val.to_string();

    let output = git_command()
        .args(["log", "--format=%H|%h|%s|%an|%ae|%ar|%P|%D", "-n", &count_str])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = decode_git_bytes(&output.stdout);
    let entries: Vec<GitLogEntry> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 6 {
                // Format: %H|%h|%s|%an|%ae|%ar|%P|%D
                let author_email = if parts.len() > 4 { parts[4].to_string() } else { "".to_string() };
                let date = if parts.len() > 5 { parts[5].to_string() } else { "".to_string() };
                let parents_str = if parts.len() > 6 { parts[6] } else { "" };
                let parents: Vec<String> = parents_str.split_whitespace().map(|s| s.to_string()).collect();
                let refs = if parts.len() > 7 { parts[7].to_string() } else { "".to_string() };
                Some(GitLogEntry {
                    hash: parts[0].to_string(),
                    short_hash: parts[1].to_string(),
                    message: parts[2].to_string(),
                    author: parts[3].to_string(),
                    author_email,
                    date,
                    parents,
                    refs,
                })
            } else if parts.len() == 5 {
                // Fallback if no parents/refs
                Some(GitLogEntry {
                    hash: parts[0].to_string(),
                    short_hash: parts[1].to_string(),
                    message: parts[2].to_string(),
                    author: parts[3].to_string(),
                    author_email: "".to_string(),
                    date: parts[4].to_string(),
                    parents: vec![],
                    refs: "".to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub async fn git_push(path: String) -> Result<String, String> {
    let output = git_command()
        .args(["push"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr);
    }

    Ok(decode_git_bytes(&output.stdout))
}

#[tauri::command]
pub async fn git_pull(path: String) -> Result<String, String> {
    let output = git_command()
        .args(["pull"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(decode_git_bytes(&output.stdout))
}

#[tauri::command]
pub async fn git_fetch(path: String) -> Result<String, String> {
    let output = git_command()
        .args(["fetch", "--all"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(decode_git_bytes(&output.stdout))
}

#[tauri::command]
pub async fn git_diff(path: String, file_path: Option<String>, staged: bool) -> Result<String, String> {
    let mut args = vec!["diff"];
    if staged {
        args.push("--staged");
    }
    if let Some(f) = &file_path {
        args.push("--");
        args.push(f);
    }

    let output = git_command()
        .args(args)
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(decode_git_bytes(&output.stdout))
}

#[tauri::command]
pub async fn find_git_repos(path: String) -> Result<Vec<String>, String> {
    use std::fs;
    let mut repos = Vec::new();
    
    let base_path = std::path::Path::new(&path);
    if !base_path.exists() {
        return Err("Path does not exist".to_string());
    }

    // Check root itself
    if base_path.join(".git").exists() {
        repos.push(".".to_string());
    }

    // Shallow recursive search (depth 1 to 2)
    if let Ok(entries) = fs::read_dir(base_path) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let p = entry.path();
                let name = p.file_name().unwrap_or_default();
                if name == ".git" || name == "node_modules" || name == "target" || name == ".next" { continue; }
                
                if p.join(".git").exists() {
                    if let Ok(rel) = p.strip_prefix(base_path) {
                        repos.push(rel.to_string_lossy().to_string());
                    }
                }
                
                // Depth 2
                if let Ok(sub_entries) = fs::read_dir(&p) {
                    for sub_entry in sub_entries.filter_map(|e| e.ok()) {
                        if sub_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            let sp = sub_entry.path();
                            if sp.join(".git").exists() {
                                if let Ok(rel) = sp.strip_prefix(base_path) {
                                    repos.push(rel.to_string_lossy().to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(repos)
}

#[tauri::command]
pub async fn git_show(path: String, revision: String, file: String) -> Result<String, String> {
    // revision can be "HEAD", "", or a hash. 
    // If revision is empty, it refers to the index (":file")
    let target = if revision.is_empty() {
        format!(":{}", file)
    } else {
        format!("{}:{}", revision, file)
    };

    let output = git_command()
        .args(["show", &target])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // Fallback for new files (they don't exist in HEAD)
        return Ok("".to_string());
    }

    Ok(decode_git_bytes(&output.stdout))
}

#[tauri::command]
pub async fn git_discard(path: String, file: String, status: String) -> Result<(), String> {
    let file_path = std::path::Path::new(&path).join(&file);
    if status == "U" {
        if file_path.is_dir() {
            std::fs::remove_dir_all(&file_path).map_err(|e| e.to_string())?;
        } else if file_path.is_file() {
            std::fs::remove_file(&file_path).map_err(|e| e.to_string())?;
        } else {
            return Err("File or directory not found".to_string());
        }
    } else {
        let output = git_command()
            .args(["checkout", "--", &file])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitCommitFile {
    pub status: String,
    pub path: String,
}

#[tauri::command]
pub async fn git_commit_files(path: String, hash: String) -> Result<Vec<GitCommitFile>, String> {
    let output = git_command()
        .args(["diff-tree", "--no-commit-id", "--name-status", "-r", &hash])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = decode_git_bytes(&output.stdout);
    let files: Vec<GitCommitFile> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                let status_char = parts[0..1].join("");
                Some(GitCommitFile {
                    status: status_char,
                    path: parts[1].to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(files)
}

/// List files that differ between two revisions.
/// `to_rev` empty ("") means compare `from_rev` against the working tree.
#[tauri::command]
pub async fn git_diff_files(path: String, from_rev: String, to_rev: String) -> Result<Vec<GitCommitFile>, String> {
    let mut args: Vec<String> = vec!["diff".into(), "--name-status".into(), from_rev.clone()];
    if !to_rev.is_empty() {
        args.push(to_rev.clone());
    }
    let output = git_command()
        .args(&args)
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = decode_git_bytes(&output.stdout);
    let files: Vec<GitCommitFile> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                Some(GitCommitFile {
                    // Status can be like "R100"/"C075"; keep just the first char.
                    status: parts[0].chars().next().unwrap_or('M').to_string(),
                    // For renames/copies the new path is the last field.
                    path: parts[parts.len() - 1].to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(files)
}

#[tauri::command]
pub async fn git_file_diff(path: String, hash: String, file: String) -> Result<String, String> {
    // Detect if this is the first commit (no parent)
    let has_parent = !git_command()
        .args(["cat-file", "-e", &format!("{}^", hash)])
        .current_dir(&path)
        .output()
        .map(|o| !o.status.success())
        .unwrap_or(true);

    let output = if has_parent {
        git_command()
            .args(["diff", &format!("{}^", hash), &hash, "--", &file])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?
    } else {
        // First commit: show the file content as added
        git_command()
            .args(["show", &format!("{}:{}", hash, file)])
            .current_dir(&path)
            .output()
            .map_err(|e| e.to_string())?
    };

    Ok(decode_git_bytes(&output.stdout))
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<String, String> {
    let output = git_command()
        .args(["init"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(decode_git_bytes(&output.stdout))
}

#[tauri::command]
pub async fn git_ignore(path: String, file: String) -> Result<(), String> {
    let gitignore_path = std::path::Path::new(&path).join(".gitignore");
    use std::fs::OpenOptions;
    use std::io::Write;

    let mut file_handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&gitignore_path)
        .map_err(|e| e.to_string())?;

    writeln!(file_handle, "{}", file).map_err(|e| e.to_string())?;
    Ok(())
}

