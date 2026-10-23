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
    /// Author date as ISO 8601, for the tooltip; `date` is the relative one.
    pub iso_date: String,
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

/// Fields of one `git log` line, separated by the ASCII unit separator.
///
/// The separator used to be `|`, which a commit subject is free to contain:
/// "fix: a | b" shifted every later field by one, so the author became the
/// date and the parents vanished from the graph. The subject also goes LAST,
/// so even a subject holding the separator itself only lengthens itself.
const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ar%x1f%aI%x1f%P%x1f%D%x1f%s";

fn parse_log_line(line: &str) -> Option<GitLogEntry> {
    let parts: Vec<&str> = line.splitn(9, '\x1f').collect();
    if parts.len() < 9 || parts[0].is_empty() {
        return None;
    }
    Some(GitLogEntry {
        hash: parts[0].to_string(),
        short_hash: parts[1].to_string(),
        author: parts[2].to_string(),
        author_email: parts[3].to_string(),
        date: parts[4].to_string(),
        iso_date: parts[5].to_string(),
        parents: parts[6].split_whitespace().map(|s| s.to_string()).collect(),
        refs: parts[7].to_string(),
        message: parts[8].to_string(),
    })
}

/// The history shown in the Git panel.
///
/// `rev` picks whose history: empty for the checked-out branch, `--all` for
/// every branch, remote and tag, or a ref name for just that one. Date order
/// rather than git's default, because the default can list a parent above one
/// of its children when clocks disagree — and the graph then has nowhere to
/// draw the line from.
#[tauri::command]
pub async fn git_log(path: String, count: Option<u32>, rev: Option<String>) -> Result<Vec<GitLogEntry>, String> {
    let count_str = count.unwrap_or(30).to_string();

    let mut args: Vec<String> = vec!["log".into(), LOG_FORMAT.into(), "--date-order".into(), "-n".into(), count_str];
    match rev.as_deref().map(str::trim) {
        None | Some("") => {}
        Some("--all") => args.push("--all".into()),
        // A ref can never start with '-', so this is a name, not an option;
        // the `--` keeps a ref that looks like a path from being read as one.
        Some(r) if !r.starts_with('-') => {
            args.push(r.to_string());
            args.push("--".into());
        }
        Some(r) => return Err(format!("git_log: not a revision: {}", r)),
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
    Ok(stdout.lines().filter_map(parse_log_line).collect())
}

/// Push the current branch.
///
/// A branch created locally has no upstream, and a bare `git push` fails on it
/// with "no upstream branch". Passing `remote`/`branch`/`set_upstream` performs
/// the `git push -u origin <branch>` that publishes it for the first time; with
/// all three omitted this is the plain push it always was.
#[tauri::command]
pub async fn git_push(
    path: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: Option<bool>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec!["push".into()];
    if set_upstream.unwrap_or(false) {
        args.push("--set-upstream".into());
    }
    if let Some(r) = remote.filter(|r| !r.is_empty()) {
        args.push(r);
        if let Some(b) = branch.filter(|b| !b.is_empty()) {
            args.push(b);
        }
    }

    let output = git_command()
        .args(&args)
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr);
    }

    // git reports a push on stderr, so returning stdout alone loses the summary.
    let mut out = decode_git_bytes(&output.stdout);
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    if !err.trim().is_empty() {
        if !out.trim().is_empty() {
            out.push('\n');
        }
        out.push_str(&err);
    }
    Ok(out)
}

/// The upstream of the current branch (e.g. `origin/master`), or `None` when it
/// has never been pushed.
#[tauri::command]
pub async fn git_upstream(path: String) -> Result<Option<String>, String> {
    let output = git_command()
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    // A missing upstream is the normal answer for a fresh branch, not an error.
    if !output.status.success() {
        return Ok(None);
    }
    let name = decode_git_bytes(&output.stdout).trim().to_string();
    Ok(if name.is_empty() { None } else { Some(name) })
}

/// The fetch URL of a remote, for building a web link to the forge.
#[tauri::command]
pub async fn git_remote_url(path: String, remote: Option<String>) -> Result<String, String> {
    let remote = remote.filter(|r| !r.is_empty()).unwrap_or_else(|| "origin".into());
    let output = git_command()
        .args(["remote", "get-url", &remote])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(decode_git_bytes(&output.stdout).trim().to_string())
}

/// The branch a pull request should target: whatever `origin/HEAD` points at.
///
/// Repositories that were cloned before the default branch was renamed, or that
/// were never cloned at all, may not have it — the caller falls back rather
/// than treating that as a failure.
#[tauri::command]
pub async fn git_default_branch(path: String) -> Result<Option<String>, String> {
    let output = git_command()
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Ok(None);
    }
    let name = decode_git_bytes(&output.stdout).trim().to_string();
    // "origin/main" -> "main"
    Ok(name.split_once('/').map(|(_, b)| b.to_string()).filter(|b| !b.is_empty()))
}

/// The GitHub CLI, if it is installed and signed in.
///
/// Both halves matter: `gh` on PATH but unauthenticated fails at PR creation
/// with a login prompt the app cannot answer, so the frontend needs to know to
/// fall back to the browser before it collects a title and body.
#[tauri::command]
pub async fn gh_available(path: String) -> Result<bool, String> {
    let mut cmd = Command::new("gh");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    match cmd.args(["auth", "status"]).current_dir(&path).output() {
        Ok(out) => Ok(out.status.success()),
        Err(_) => Ok(false),   // not installed
    }
}

/// Open a pull request through the GitHub CLI. Returns the new PR's URL.
///
/// The title and body are passed as process ARGUMENTS, never interpolated into
/// a shell command line, so a message containing quotes or `&` is safe.
#[tauri::command]
pub async fn gh_pr_create(
    path: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: Option<bool>,
) -> Result<String, String> {
    let mut cmd = Command::new("gh");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.args(["pr", "create", "--base", &base, "--head", &head,
              "--title", &title, "--body", &body]);
    if draft.unwrap_or(false) {
        cmd.arg("--draft");
    }

    let output = cmd
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Could not run gh: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = decode_git_bytes(&output.stdout);
        return Err(if stderr.trim().is_empty() { stdout } else { stderr });
    }
    Ok(decode_git_bytes(&output.stdout).trim().to_string())
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
    /// Where a renamed or copied file came from: the path to read on the
    /// older side. Absent for every other status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

/// One `--name-status` line: `M\tpath`, or `R100\told\tnew` for a rename.
///
/// The status keeps its first letter only (R100 becomes R). For a rename the
/// file is listed under its NEW path, and the old one is kept so the left side
/// can still be read — reading the new path at the old revision finds nothing.
fn parse_name_status(line: &str) -> Option<GitCommitFile> {
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() < 2 || parts[0].is_empty() {
        return None;
    }
    let status = parts[0].chars().next().unwrap_or('M').to_string();
    let path = parts[parts.len() - 1].to_string();
    let old_path = if parts.len() >= 3 { Some(parts[1].to_string()) } else { None };
    Some(GitCommitFile { status, path, old_path })
}

/// The files one commit changed, compared with its first parent.
///
/// --root makes the very first commit list its files as added; without it
/// diff-tree prints nothing for a commit that has no parent.
#[tauri::command]
pub async fn git_commit_files(path: String, hash: String) -> Result<Vec<GitCommitFile>, String> {
    let output = git_command()
        .args(["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "--root", &hash])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = decode_git_bytes(&output.stdout);
    Ok(stdout.lines().filter_map(parse_name_status).collect())
}

/// List files that differ between two revisions.
/// An empty to_rev means compare from_rev against the working tree.
#[tauri::command]
pub async fn git_diff_files(path: String, from_rev: String, to_rev: String) -> Result<Vec<GitCommitFile>, String> {
    let mut args: Vec<String> = vec!["diff".into(), "--name-status".into(), "-M".into(), from_rev.clone()];
    if !to_rev.is_empty() {
        args.push(to_rev.clone());
    }
    // Revisions end here: a file that happens to share a branch's name must
    // not turn the command into a path filter.
    args.push("--".into());
    let output = git_command()
        .args(&args)
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = decode_git_bytes(&output.stdout);
    Ok(stdout.lines().filter_map(parse_name_status).collect())
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


/// Run a git subcommand given as ARGUMENTS, and return its stdout.
///
/// This replaces the old `app::run_command`, which handed a whole command line
/// to `cmd /C` (Windows) or `sh -c`. That command was registered for the whole
/// webview, so any JavaScript running in the window — including script injected
/// through a rendered Markdown document — could execute arbitrary shell. Every
/// caller was running git, so the general shell was pure attack surface with no
/// user-visible benefit.
///
/// Arguments go through `Command::args`, so a branch or tag whose name contains
/// a space, a quote or `&` reaches git as exactly one argv entry. The quoting
/// that `cleanRef` was written to undo cannot happen here, because there is no
/// shell left to do the quoting.
#[tauri::command]
pub async fn git_exec(args: Vec<String>, cwd: String) -> Result<String, String> {
    if args.is_empty() {
        return Err("git_exec: no arguments given".into());
    }

    let output = git_command()
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    let stdout = decode_git_bytes(&output.stdout);
    if output.status.success() {
        return Ok(stdout);
    }

    // git writes the useful part to stderr; fall back to stdout when it is
    // silent, so the caller never gets an empty error message.
    let stderr = decode_git_bytes(&output.stderr);
    let detail = if stderr.trim().is_empty() { stdout } else { stderr };
    Err(format!("git {} failed: {}", args.join(" "), detail.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_subject_with_the_old_separator_stays_whole() {
        let line = "abc\x1fa\x1fPei\x1fp@x\x1f2 days ago\x1f2026-10-21T10:00:00+09:00\x1fp1 p2\x1fHEAD -> master\x1ffix: a | b";
        let e = parse_log_line(line).unwrap();
        assert_eq!(e.message, "fix: a | b");
        assert_eq!(e.author, "Pei");
        assert_eq!(e.parents, vec!["p1", "p2"]);
        assert_eq!(e.refs, "HEAD -> master");
        assert_eq!(e.iso_date, "2026-10-21T10:00:00+09:00");
    }

    #[test]
    fn a_root_commit_has_no_parents() {
        let e = parse_log_line("abc\x1fa\x1fPei\x1fp@x\x1fnow\x1f\x1f\x1f\x1finit").unwrap();
        assert!(e.parents.is_empty());
        assert_eq!(e.message, "init");
        assert!(parse_log_line("").is_none());
    }

    #[test]
    fn a_rename_keeps_where_it_came_from() {
        let r = parse_name_status("R087\told/a.js\tnew/a.js").unwrap();
        assert_eq!(r.status, "R");
        assert_eq!(r.path, "new/a.js");
        assert_eq!(r.old_path.as_deref(), Some("old/a.js"));
        let m = parse_name_status("M\tsrc/x.rs").unwrap();
        assert_eq!((m.status.as_str(), m.path.as_str(), m.old_path), ("M", "src/x.rs", None));
        assert!(parse_name_status("").is_none());
    }
}
