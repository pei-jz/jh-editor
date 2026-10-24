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
    // There is no terminal to ask on. Without this, a git that wants a
    // password and has no askpass may wait for one that never comes.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// A git command that may need credentials. Its questions (user name,
/// password, SSH passphrase) go to the dialog in `window` — see askpass.rs —
/// unless the user has an askpass program of their own configured.
fn git_command_interactive(window: &str, repo: &str) -> Command {
    let own = git_command()
        .args(["config", "--get", "core.askPass"])
        .current_dir(repo)
        .output()
        .map(|o| o.status.success() && !o.stdout.trim_ascii().is_empty())
        .unwrap_or(false);
    let mut cmd = git_command();
    crate::askpass::configure(&mut cmd, window, own);
    cmd
}

/// Git refused the credentials: whatever was remembered for this session is
/// wrong, and using it again would only fail again.
fn note_auth_failure(stderr: &str) {
    if is_auth_failure(stderr) {
        if let Some(b) = crate::askpass::broker() {
            b.forget_all();
        }
    }
}

pub fn is_auth_failure(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    ["authentication failed", "could not read username", "could not read password",
        "permission denied (publickey", "http 401", "error: 403", "returned error: 403",
        "invalid username or password", "terminal prompts disabled"]
        .iter()
        .any(|needle| s.contains(needle))
}

/// Subcommands that talk to a remote and may be asked for credentials.
fn needs_credentials(args: &[String]) -> bool {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "-c" || a == "-C" {
            it.next();
            continue;
        }
        if a.starts_with('-') {
            continue;
        }
        return matches!(a.as_str(), "fetch" | "pull" | "push" | "clone" | "ls-remote" | "remote" | "submodule");
    }
    false
}

/// The editor's dialog answered a credential question (see askpass.rs).
#[tauri::command]
pub async fn git_askpass_reply(
    id: u64,
    answer: Option<String>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<bool, String> {
    let b = crate::askpass::broker().ok_or("askpass is not running")?;
    Ok(b.reply(id, crate::askpass::Reply { answer, password, remember: remember.unwrap_or(false) }))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub staged: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
    pub untracked: Vec<String>,
    /// Unmerged paths. They used to be spread over `modified` and `deleted`,
    /// where nothing told them apart from an ordinary change.
    pub conflicted: Vec<GitConflict>,
    /// A merge, rebase, cherry-pick or revert that stopped half way.
    pub operation: Option<GitOperation>,
}

/// One unmerged path and its two-letter porcelain code: `UU` both modified,
/// `AA` both added, `DD` both deleted, `AU`/`UA` added by us/them, `DU`/`UD`
/// deleted by us/them.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct GitConflict {
    pub path: String,
    pub code: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct GitOperation {
    /// "merge", "rebase", "cherry-pick" or "revert".
    pub kind: String,
    /// What is being brought in: the merged branch, the picked commit.
    pub name: String,
    /// The message git prepared for the commit that will finish it
    /// (MERGE_MSG), without its comment lines. Empty when there is none.
    pub message: String,
}

const CONFLICT_CODES: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

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

    let mut status = parse_porcelain(&decode_git_bytes(&output.stdout));
    status.operation = detect_operation(&path);
    Ok(status)
}

/// Sort `git status --porcelain -b` output into the panel's groups.
fn parse_porcelain(stdout: &str) -> GitStatus {
    let mut lines = stdout.lines();

    let mut branch = String::from("unknown");
    let mut staged = Vec::new();
    let mut modified = Vec::new();
    let mut deleted = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicted = Vec::new();

    if let Some(first_line) = lines.next() {
        if first_line.starts_with("## ") {
            branch = first_line[3..].split("...").next().unwrap_or("unknown").to_string();
        }
    }

    for line in lines {
        if line.len() < 3 { continue; }
        let status = &line[0..2];
        let file = line[3..].to_string();

        // Before the deletion test below, which "UD" and "DD" would also pass.
        if CONFLICT_CODES.contains(&status) {
            conflicted.push(GitConflict { path: file, code: status.to_string() });
            continue;
        }

        // Worktree-deleted: " D" (space then D) → the file is gone on disk but
        // still in HEAD, so we can diff HEAD→empty.
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
            _ => {
                if status.starts_with('M') || status.starts_with('A') {
                    staged.push(file);
                } else {
                    modified.push(file);
                }
            }
        }
    }

    GitStatus { branch, staged, modified, deleted, untracked, conflicted, operation: None }
}

/// The operation git is in the middle of, read from the marker files it leaves
/// in the git directory.
///
/// The paths come from `rev-parse --git-path`, because in a linked worktree
/// `.git` is a file and the markers live elsewhere.
fn detect_operation(repo: &str) -> Option<GitOperation> {
    const MARKERS: [&str; 6] = [
        "MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_MSG",
    ];
    let mut args = vec!["rev-parse"];
    for m in MARKERS {
        args.push("--git-path");
        args.push(m);
    }
    let output = git_command().args(&args).current_dir(repo).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let base = std::path::Path::new(repo);
    let paths: Vec<std::path::PathBuf> = decode_git_bytes(&output.stdout)
        .lines()
        .map(|p| base.join(p.trim()))
        .collect();
    if paths.len() != MARKERS.len() {
        return None;
    }
    let read = |p: &std::path::Path| std::fs::read(p).ok().map(|b| decode_git_bytes(&b));
    let message = read(&paths[5]).map(|m| strip_comment_lines(&m)).unwrap_or_default();

    let kind = if paths[0].is_file() {
        "merge"
    } else if paths[1].is_dir() || paths[2].is_dir() {
        "rebase"
    } else if paths[3].is_file() {
        "cherry-pick"
    } else if paths[4].is_file() {
        "revert"
    } else {
        return None;
    };

    let name = match kind {
        "merge" => merged_name(&message)
            .or_else(|| read(&paths[0]).map(|h| short_hash(&h)))
            .unwrap_or_default(),
        "rebase" => [&paths[1], &paths[2]]
            .iter()
            .find_map(|d| read(&d.join("head-name")))
            .map(|h| h.trim().trim_start_matches("refs/heads/").to_string())
            .unwrap_or_default(),
        "cherry-pick" => read(&paths[3]).map(|h| short_hash(&h)).unwrap_or_default(),
        _ => read(&paths[4]).map(|h| short_hash(&h)).unwrap_or_default(),
    };
    Some(GitOperation { kind: kind.to_string(), name, message })
}

/// Everything the three-way merge view needs for one conflicted file.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConflictVersions {
    /// Stage 1, the common ancestor. None when the file did not exist there
    /// (both sides added it).
    pub base: Option<String>,
    /// Stage 2: HEAD's version. None when HEAD deleted the file.
    pub ours: Option<String>,
    /// Stage 3: the version being brought in. None when it deleted the file.
    pub theirs: Option<String>,
    /// `git merge-file --diff3` over the three, with markers MARKER_SIZE long:
    /// git's own result, conflicts and all. Empty when a side is missing.
    pub merged: String,
    /// What is on disk now, if anything — the text saving will replace.
    pub worktree: Option<String>,
    pub encoding: String,
    pub eol: String,
    /// A NUL byte in any version: there is no text to merge.
    pub binary: bool,
}

/// Longer than any marker a person would type, so text in the file that
/// happens to look like a conflict is never read as one.
pub const MARKER_SIZE: usize = 32;

/// The three versions of a conflicted file and git's merge of them.
///
/// Every version is decoded with ONE encoding — the one the working-tree file
/// is in — so a Shift_JIS file does not come back as three different guesses.
/// The merge runs on temporary copies: the working-tree file is left alone,
/// whatever the user has already done to it.
#[tauri::command]
pub async fn git_conflict_versions(path: String, file: String) -> Result<ConflictVersions, String> {
    let stage = |n: u8| -> Option<Vec<u8>> {
        let out = git_command()
            .args(["show", &format!(":{}:{}", n, file)])
            .current_dir(&path)
            .output()
            .ok()?;
        out.status.success().then_some(out.stdout)
    };
    let base = stage(1);
    let ours = stage(2);
    let theirs = stage(3);
    let worktree = std::fs::read(std::path::Path::new(&path).join(&file)).ok();

    let has_nul = |b: &Option<Vec<u8>>| b.as_ref().map_or(false, |b| b.contains(&0));
    let binary = has_nul(&base) || has_nul(&ours) || has_nul(&theirs) || has_nul(&worktree);

    let sample = worktree.as_ref().or(ours.as_ref()).or(theirs.as_ref());
    let encoding = match sample {
        Some(bytes) if !binary => {
            let mut detector = EncodingDetector::new();
            detector.feed(bytes, true);
            detector.guess(None, true)
        }
        _ => encoding_rs::UTF_8,
    };
    let eol = if sample.map_or(false, |b| b.windows(2).any(|w| w == b"\r\n")) { "\r\n" } else { "\n" };
    let decode = |b: &[u8]| encoding.decode(b).0.to_string();

    let merged = match (&ours, &theirs) {
        (Some(o), Some(t)) if !binary => {
            let empty = Vec::new();
            decode(&merge_file(&path, o, base.as_ref().unwrap_or(&empty), t)?)
        }
        _ => String::new(),
    };

    Ok(ConflictVersions {
        base: base.as_deref().map(decode),
        ours: ours.as_deref().map(decode),
        theirs: theirs.as_deref().map(decode),
        merged,
        worktree: worktree.as_deref().filter(|_| !binary).map(decode),
        encoding: encoding.name().to_string(),
        eol: eol.to_string(),
        binary,
    })
}

/// `git merge-file -p --diff3` over three byte strings, through temp files.
/// Its exit code is the number of conflicts, so only a failure to run or a
/// negative code (an error) is an error.
fn merge_file(repo: &str, ours: &[u8], base: &[u8], theirs: &[u8]) -> Result<Vec<u8>, String> {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("jh-merge-{}-{}", std::process::id(), n));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let run = || -> Result<Vec<u8>, String> {
        let files = [("ours", ours), ("base", base), ("theirs", theirs)];
        for (name, bytes) in files {
            std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
        }
        let output = git_command()
            .args(["merge-file", "-p", "--diff3", &format!("--marker-size={}", MARKER_SIZE),
                "-L", "ours", "-L", "base", "-L", "theirs"])
            .arg(dir.join("ours"))
            .arg(dir.join("base"))
            .arg(dir.join("theirs"))
            .current_dir(repo)
            .output()
            .map_err(|e| e.to_string())?;
        match output.status.code() {
            Some(c) if (0..128).contains(&c) => Ok(output.stdout),
            _ => Err(format!("git merge-file failed: {}", String::from_utf8_lossy(&output.stderr).trim())),
        }
    };
    let result = run();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// MERGE_MSG as the commit will carry it: git drops the `#` lines itself.
fn strip_comment_lines(msg: &str) -> String {
    msg.lines()
        .filter(|l| !l.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// The branch named in "Merge branch 'x'" / "Merge remote-tracking branch 'origin/x'".
fn merged_name(message: &str) -> Option<String> {
    let first = message.lines().next()?;
    let start = first.find('\'')? + 1;
    let len = first[start..].find('\'')?;
    Some(first[start..start + len].to_string()).filter(|s| !s.is_empty())
}

fn short_hash(h: &str) -> String {
    h.trim().chars().take(7).collect()
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
    window: tauri::WebviewWindow,
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

    let output = git_command_interactive(window.label(), &path)
        .args(&args)
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        note_auth_failure(&stderr);
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
pub async fn git_pull(window: tauri::WebviewWindow, path: String) -> Result<String, String> {
    let output = git_command_interactive(window.label(), &path)
        .args(["pull"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        note_auth_failure(&stderr);
        return Err(stderr);
    }

    Ok(decode_git_bytes(&output.stdout))
}

#[tauri::command]
pub async fn git_fetch(window: tauri::WebviewWindow, path: String) -> Result<String, String> {
    let output = git_command_interactive(window.label(), &path)
        .args(["fetch", "--all"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        note_auth_failure(&stderr);
        return Err(stderr);
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
pub async fn git_exec(window: tauri::WebviewWindow, args: Vec<String>, cwd: String) -> Result<String, String> {
    if args.is_empty() {
        return Err("git_exec: no arguments given".into());
    }

    let mut cmd = if needs_credentials(&args) {
        git_command_interactive(window.label(), &cwd)
    } else {
        git_command()
    };
    let output = cmd
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
    note_auth_failure(&stderr);
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

    #[test]
    fn only_remote_commands_may_ask_for_credentials() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(needs_credentials(&v(&["fetch", "--all"])));
        assert!(needs_credentials(&v(&["-c", "x=y", "push", "origin"])));
        assert!(needs_credentials(&v(&["ls-remote", "origin"])));
        assert!(!needs_credentials(&v(&["-c", "core.editor=true", "rebase", "main"])));
        assert!(!needs_credentials(&v(&["status"])));
        assert!(!needs_credentials(&v(&["log", "push"])));
    }

    #[test]
    fn refused_credentials_are_recognised() {
        assert!(is_auth_failure("remote: Invalid username or password.
fatal: Authentication failed for 'https://h/'"));
        assert!(is_auth_failure("fatal: could not read Username for 'https://h': terminal prompts disabled"));
        assert!(is_auth_failure("git@h: Permission denied (publickey)."));
        assert!(!is_auth_failure("fatal: refusing to merge unrelated histories"));
    }

    #[test]
    fn every_unmerged_code_is_a_conflict() {
        let out = "## master\nUU both.txt\nAA added.txt\nDD gone.txt\nAU au.txt\nUA ua.txt\nDU du.txt\nUD ud.txt\n";
        let s = parse_porcelain(out);
        let codes: Vec<&str> = s.conflicted.iter().map(|c| c.code.as_str()).collect();
        assert_eq!(codes, ["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);
        assert_eq!(s.conflicted[0], GitConflict { path: "both.txt".into(), code: "UU".into() });
        // None of them leaks into the ordinary groups.
        assert!(s.modified.is_empty() && s.deleted.is_empty() && s.staged.is_empty());
    }

    #[test]
    fn ordinary_changes_sort_as_before() {
        let s = parse_porcelain("## main...origin/main [ahead 1]\nM  staged.rs\n M work.rs\n D gone.rs\nD  removed.rs\n?? 新規.md\n");
        assert_eq!(s.branch, "main");
        assert_eq!(s.staged, ["staged.rs", "removed.rs"]);
        assert_eq!(s.modified, ["work.rs"]);
        assert_eq!(s.deleted, ["gone.rs"]);
        assert_eq!(s.untracked, ["新規.md"]);
        assert!(s.conflicted.is_empty());
        assert!(s.operation.is_none());
    }

    #[test]
    fn the_merged_branch_comes_from_merge_msg() {
        assert_eq!(merged_name("Merge branch 'feature-x'").as_deref(), Some("feature-x"));
        assert_eq!(merged_name("Merge remote-tracking branch 'origin/main' into dev").as_deref(), Some("origin/main"));
        assert_eq!(merged_name("Merge commit 'abc1234'").as_deref(), Some("abc1234"));
        assert!(merged_name("no quotes").is_none());
        assert_eq!(strip_comment_lines("Merge branch 'x'\n\n# Conflicts:\n#\tfile.txt\n"), "Merge branch 'x'");
    }

    /// A real repository stopped on a conflict, so the marker files and
    /// `--git-path` are exercised the way the panel meets them.
    #[test]
    fn a_stopped_merge_is_detected() {
        let dir = std::env::temp_dir().join(format!("jh-git-conflict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_str().unwrap();
        let git = |args: &[&str]| {
            git_command()
                .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(&dir)
                .output()
                .unwrap()
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        git(&["add", "f.txt"]);
        git(&["commit", "-q", "-m", "base"]);
        git(&["checkout", "-q", "-b", "feature-x"]);
        std::fs::write(dir.join("f.txt"), "theirs\n").unwrap();
        git(&["commit", "-q", "-am", "theirs"]);
        git(&["checkout", "-q", "main"]);
        std::fs::write(dir.join("f.txt"), "ours\n").unwrap();
        git(&["commit", "-q", "-am", "ours"]);

        assert!(detect_operation(repo).is_none());
        let merged = git(&["merge", "feature-x"]);
        assert!(!merged.status.success());

        let op = detect_operation(repo).expect("merge in progress");
        assert_eq!(op.kind, "merge");
        assert_eq!(op.name, "feature-x");
        assert!(op.message.starts_with("Merge branch 'feature-x'"));
        assert!(!op.message.contains('#'));

        let out = git(&["status", "--porcelain", "-b", "-uall"]);
        let s = parse_porcelain(&decode_git_bytes(&out.stdout));
        assert_eq!(s.conflicted, vec![GitConflict { path: "f.txt".into(), code: "UU".into() }]);

        let v = tauri::async_runtime::block_on(git_conflict_versions(repo.into(), "f.txt".into())).unwrap();
        assert_eq!(v.base.as_deref(), Some("base\n"));
        assert_eq!(v.ours.as_deref(), Some("ours\n"));
        assert_eq!(v.theirs.as_deref(), Some("theirs\n"));
        let m = |c: char| c.to_string().repeat(MARKER_SIZE);
        assert_eq!(v.merged, format!("{} ours\nours\n{} base\nbase\n{}\ntheirs\n{} theirs\n", m('<'), m('|'), m('='), m('>')));
        assert!(v.worktree.as_deref().unwrap().contains("<<<<<<< HEAD"));
        assert!(!v.binary);

        git(&["merge", "--abort"]);
        assert!(detect_operation(repo).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
