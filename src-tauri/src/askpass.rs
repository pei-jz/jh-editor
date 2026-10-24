//! Answering git's credential questions from the editor's own dialog.
//!
//! The Git panel runs git with no terminal, so when git needs a user name, a
//! password or an SSH key passphrase and no credential helper (Git Credential
//! Manager) supplies one, it used to fail with "could not read Username". Git
//! and ssh ask a program named in GIT_ASKPASS / SSH_ASKPASS instead of a
//! terminal; that program is this executable:
//!
//! ```text
//! git ──▶ JHEditor.exe "Password for 'https://u@host': "      (askpass mode)
//!              │  one JSON line over a named pipe: { token, window, prompt }
//!              ▼
//!         the running editor ──event "git-askpass"──▶ the window that ran git
//!              ◀── git_askpass_reply { id, answer, … }
//!              │  one JSON line back: { answer }
//!              ▼
//!         printed on stdout, exit 0 (cancel: exit 1, git gives up)
//! ```
//!
//! `run_client_if_requested` runs first thing in `main`, before Tauri and its
//! single-instance plugin, which would otherwise forward the launch to the
//! running editor and open a window. The pipe name and the token are random per
//! run and reach only the git processes the editor starts.
//!
//! Answers are never written to disk or to the log. "Remember for this
//! session" keeps them in memory until the editor exits.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const ENV_PIPE: &str = "JH_ASKPASS_PIPE";
pub const ENV_TOKEN: &str = "JH_ASKPASS_TOKEN";
pub const ENV_WINDOW: &str = "JH_ASKPASS_WINDOW";

/// How long a question waits for the user before git is told "no".
const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);
/// Git asks for the user name and the password in two calls; the dialog takes
/// both at once, and the password is held this long for the second call.
const PAIR_WINDOW: Duration = Duration::from_secs(30);

// ── What git asked ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// "username" | "password" | "passphrase" | "confirm" | "text"
    pub kind: String,
    pub prompt: String,
    /// `scheme://host` for username / password, without any user name.
    pub host: String,
    /// The user name git already has, for a password question.
    pub user: String,
    /// The key file, for a passphrase question.
    pub key: String,
}

/// Read git's or ssh's prompt.
///
///   Username for 'https://host':
///   Password for 'https://user@host':        (user percent-encoded)
///   Enter passphrase for key '/c/Users/x/.ssh/id_ed25519':
///   … Are you sure you want to continue connecting (yes/no/[fingerprint])?
pub fn classify(prompt: &str) -> Question {
    let p = prompt.trim();
    let quoted = || {
        let start = p.find('\'')? + 1;
        let end = p.rfind('\'')?;
        (end > start).then(|| p[start..end].to_string())
    };
    let mut q = Question {
        kind: "text".into(),
        prompt: p.to_string(),
        host: String::new(),
        user: String::new(),
        key: String::new(),
    };
    if p.starts_with("Username for ") {
        if let Some(url) = quoted() {
            q.kind = "username".into();
            q.host = url;
        }
    } else if p.starts_with("Password for ") {
        if let Some(url) = quoted() {
            q.kind = "password".into();
            let (host, user) = split_user(&url);
            q.host = host;
            q.user = user;
        }
    } else if p.to_ascii_lowercase().contains("passphrase for") {
        // ssh: Enter passphrase for key '/c/…/id_ed25519':
        // ssh-keygen and newer ssh: Enter passphrase for "C:\…\id":
        q.kind = "passphrase".into();
        let dq = || {
            let start = p.find('"')? + 1;
            let end = p.rfind('"')?;
            (end > start).then(|| p[start..end].to_string())
        };
        q.key = quoted().or_else(dq).unwrap_or_default();
    } else if p.contains("(yes/no") {
        q.kind = "confirm".into();
    }
    q
}

/// `https://user@host/path` → (`https://host/path`, `user`).
fn split_user(url: &str) -> (String, String) {
    let (scheme, rest) = match url.find("://") {
        Some(i) => (&url[..i + 3], &url[i + 3..]),
        None => ("", url),
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => (format!("{}{}", scheme, &rest[at + 1..]), percent_decode(&rest[..at])),
        None => (url.to_string(), String::new()),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── The running editor's side ───────────────────────────────────────────────

/// What the dialog sends back.
#[derive(Debug, Default, Deserialize)]
pub struct Reply {
    /// The answer to the question asked; None cancels.
    pub answer: Option<String>,
    /// With a user name: the password too, for git's next question.
    pub password: Option<String>,
    /// Keep the answers in memory until the editor exits.
    pub remember: bool,
}

/// A question as the window receives it.
#[derive(Debug, Clone, Serialize)]
pub struct AskEvent {
    pub id: u64,
    pub window: String,
    #[serde(flatten)]
    pub question: Question,
}

type Present = Box<dyn Fn(AskEvent) + Send + Sync>;

pub struct Broker {
    pub pipe: String,
    pub token: String,
    next: Mutex<u64>,
    waiting: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Reply>>>,
    /// host or key → (user, secret), for "remember for this session".
    remembered: Mutex<HashMap<String, (String, String)>>,
    /// host → (user, password, when), the password given with a user name.
    paired: Mutex<HashMap<String, (String, String, Instant)>>,
    present: Present,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 128 random bits as hex. The standard library's hasher keys come from the
/// operating system's random source; nothing here needs more than that.
fn random_hex() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

impl Broker {
    pub fn new(present: Present) -> Self {
        Broker {
            pipe: format!(r"\\.\pipe\jh-askpass-{}-{}", std::process::id(), random_hex()),
            token: random_hex(),
            next: Mutex::new(1),
            waiting: Mutex::new(HashMap::new()),
            remembered: Mutex::new(HashMap::new()),
            paired: Mutex::new(HashMap::new()),
            present,
        }
    }

    /// Answer one question: from memory when it can, else from the dialog.
    pub async fn answer(&self, window: &str, prompt: &str) -> Option<String> {
        let q = classify(prompt);
        if let Some(known) = self.known(&q) {
            return Some(known);
        }
        let id = {
            let mut n = lock(&self.next);
            *n += 1;
            *n
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        lock(&self.waiting).insert(id, tx);
        (self.present)(AskEvent { id, window: window.to_string(), question: q.clone() });
        let reply = match tokio::time::timeout(ANSWER_TIMEOUT, rx).await {
            Ok(Ok(reply)) => reply,
            _ => {
                lock(&self.waiting).remove(&id);
                return None;
            }
        };
        self.keep(&q, &reply);
        reply.answer
    }

    /// The dialog answered question `id`. False when nothing was waiting.
    pub fn reply(&self, id: u64, reply: Reply) -> bool {
        match lock(&self.waiting).remove(&id) {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    fn known(&self, q: &Question) -> Option<String> {
        match q.kind.as_str() {
            "username" => lock(&self.remembered).get(&q.host).map(|(u, _)| u.clone()),
            "password" => {
                let mut paired = lock(&self.paired);
                if let Some((user, pw, at)) = paired.remove(&q.host) {
                    if at.elapsed() < PAIR_WINDOW && (q.user.is_empty() || q.user == user) {
                        return Some(pw);
                    }
                }
                drop(paired);
                lock(&self.remembered).get(&q.host)
                    .filter(|(u, _)| q.user.is_empty() || *u == q.user)
                    .map(|(_, p)| p.clone())
            }
            "passphrase" => lock(&self.remembered).get(&format!("key:{}", q.key)).map(|(_, p)| p.clone()),
            _ => None,
        }
    }

    fn keep(&self, q: &Question, reply: &Reply) {
        let Some(answer) = reply.answer.clone() else { return };
        match q.kind.as_str() {
            "username" => {
                if let Some(pw) = reply.password.clone() {
                    lock(&self.paired).insert(q.host.clone(), (answer.clone(), pw.clone(), Instant::now()));
                    if reply.remember {
                        lock(&self.remembered).insert(q.host.clone(), (answer, pw));
                    }
                }
            }
            "password" if reply.remember => {
                lock(&self.remembered).insert(q.host.clone(), (q.user.clone(), answer));
            }
            "passphrase" if reply.remember => {
                lock(&self.remembered).insert(format!("key:{}", q.key), (String::new(), answer));
            }
            _ => {}
        }
    }

    /// Git said the credentials were wrong: remembering them would only repeat it.
    pub fn forget_all(&self) {
        lock(&self.remembered).clear();
        lock(&self.paired).clear();
    }
}

static BROKER: OnceLock<std::sync::Arc<Broker>> = OnceLock::new();

pub fn broker() -> Option<&'static std::sync::Arc<Broker>> {
    BROKER.get()
}

/// Start answering questions: one pipe server for the life of the editor.
pub fn start(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        let present: Present = Box::new(move |ev: AskEvent| {
            let _ = app.emit("git-askpass", ev);
        });
        let broker = std::sync::Arc::new(Broker::new(present));
        if BROKER.set(broker.clone()).is_ok() {
            tauri::async_runtime::spawn(serve(broker));
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// Accept connections until the editor exits.
#[cfg(windows)]
pub async fn serve(broker: std::sync::Arc<Broker>) {
    use tokio::net::windows::named_pipe::ServerOptions;
    // first_pipe_instance: if the name were somehow taken, fail rather than
    // share it with whoever took it.
    let mut server = match ServerOptions::new().first_pipe_instance(true).create(&broker.pipe) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("askpass: cannot create the pipe: {}", e);
            return;
        }
    };
    loop {
        if server.connect().await.is_err() {
            continue;
        }
        let client = server;
        server = match ServerOptions::new().create(&broker.pipe) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("askpass: cannot create the next pipe instance: {}", e);
                return;
            }
        };
        let b = broker.clone();
        tokio::spawn(async move { handle(b, client).await });
    }
}

#[derive(Deserialize)]
struct Request {
    token: String,
    window: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Response {
    answer: Option<String>,
}

#[cfg(windows)]
async fn handle(broker: std::sync::Arc<Broker>, pipe: tokio::net::windows::named_pipe::NamedPipeServer) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (read, mut write) = tokio::io::split(pipe);
    let mut line = String::new();
    if BufReader::new(read).read_line(&mut line).await.is_err() {
        return;
    }
    let Ok(req) = serde_json::from_str::<Request>(line.trim()) else { return };
    // Only the git processes this editor started know the token.
    if req.token != broker.token {
        return;
    }
    let answer = broker.answer(&req.window, &req.prompt).await;
    let mut out = serde_json::to_string(&Response { answer }).unwrap_or_default();
    out.push('\n');
    let _ = write.write_all(out.as_bytes()).await;
    let _ = write.flush().await;
}

// ── The askpass side: this executable, started by git ───────────────────────

/// If git started this executable to ask a question, answer it and exit.
/// Returns (does nothing) for an ordinary launch.
pub fn run_client_if_requested() {
    let Ok(pipe) = std::env::var(ENV_PIPE) else { return };
    let token = std::env::var(ENV_TOKEN).unwrap_or_default();
    let window = std::env::var(ENV_WINDOW).unwrap_or_default();
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let code = match ask(&pipe, &token, &window, &prompt) {
        Some(answer) => {
            use std::io::Write;
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{}", answer);
            let _ = out.flush();
            0
        }
        None => 1,
    };
    std::process::exit(code);
}

/// One question over the pipe. None when cancelled or unreachable.
pub fn ask(pipe: &str, token: &str, window: &str, prompt: &str) -> Option<String> {
    use std::io::{BufRead, BufReader, Write};
    // All instances busy answers "pipe busy"; another question is being
    // asked, and the server makes a new instance as soon as it is accepted.
    let mut file = None;
    for _ in 0..50 {
        match std::fs::OpenOptions::new().read(true).write(true).open(pipe) {
            Ok(f) => {
                file = Some(f);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    let mut file = file?;
    let req = serde_json::json!({ "token": token, "window": window, "prompt": prompt });
    writeln!(file, "{}", req).ok()?;
    file.flush().ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    serde_json::from_str::<Response>(line.trim()).ok()?.answer
}

/// Make `cmd` (a git command the editor runs for `window`) ask its questions
/// here. Leaves alone a user's own GIT_ASKPASS / SSH_ASKPASS, and does
/// nothing before the server is running.
pub fn configure(cmd: &mut std::process::Command, window: &str, user_askpass: bool) {
    let Some(b) = broker() else { return };
    let Ok(exe) = std::env::current_exe() else { return };
    configure_with(cmd, window, user_askpass, b, &exe);
}

fn configure_with(cmd: &mut std::process::Command, window: &str, user_askpass: bool, b: &Broker, exe: &std::path::Path) {
    // Git Credential Manager reads GIT_TERMINAL_PROMPT too, and must stay free
    // to show its own sign-in window: it answers before askpass is asked.
    cmd.env_remove("GIT_TERMINAL_PROMPT");
    cmd.env(ENV_PIPE, &b.pipe).env(ENV_TOKEN, &b.token).env(ENV_WINDOW, window);
    if !user_askpass && std::env::var_os("GIT_ASKPASS").is_none() {
        cmd.env("GIT_ASKPASS", exe);
    }
    if std::env::var_os("SSH_ASKPASS").is_none() {
        cmd.env("SSH_ASKPASS", exe).env("SSH_ASKPASS_REQUIRE", "force");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_and_ssh_prompts_are_recognised() {
        let u = classify("Username for 'https://git.example.com': ");
        assert_eq!((u.kind.as_str(), u.host.as_str()), ("username", "https://git.example.com"));

        let p = classify("Password for 'https://pei%40corp@git.example.com/team/repo.git': ");
        assert_eq!(p.kind, "password");
        assert_eq!(p.host, "https://git.example.com/team/repo.git");
        assert_eq!(p.user, "pei@corp");

        let k = classify("Enter passphrase for key '/c/Users/x/.ssh/id_ed25519': ");
        assert_eq!((k.kind.as_str(), k.key.as_str()), ("passphrase", "/c/Users/x/.ssh/id_ed25519"));
        let k2 = classify("Enter passphrase for \"C:\\Users\\x\\.ssh\\id\": ");
        assert_eq!((k2.kind.as_str(), k2.key.as_str()), ("passphrase", "C:\\Users\\x\\.ssh\\id"));

        let c = classify("The authenticity of host 'h' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ");
        assert_eq!(c.kind, "confirm");

        assert_eq!(classify("Something else? ").kind, "text");
    }

    #[test]
    fn a_password_without_a_user_keeps_the_url() {
        let p = classify("Password for 'https://git.example.com': ");
        assert_eq!((p.host.as_str(), p.user.as_str()), ("https://git.example.com", ""));
        assert_eq!(percent_decode("a%20b%zz%4"), "a b%zz%4");
    }

    /// A broker whose "dialog" answers at once with `reply`.
    fn auto(reply: fn(&AskEvent) -> Reply) -> std::sync::Arc<Broker> {
        let slot: std::sync::Arc<OnceLock<std::sync::Weak<Broker>>> = std::sync::Arc::new(OnceLock::new());
        let s = slot.clone();
        let b = std::sync::Arc::new(Broker::new(Box::new(move |ev| {
            let b = s.get().and_then(|w| w.upgrade()).unwrap();
            b.reply(ev.id, reply(&ev));
        })));
        let _ = slot.set(std::sync::Arc::downgrade(&b));
        b
    }

    #[test]
    fn one_dialog_answers_both_halves_of_a_login() {
        tauri::async_runtime::block_on(async {
            let b = auto(|ev| {
                assert_eq!(ev.question.kind, "username", "the password must not be asked again");
                Reply { answer: Some("me".into()), password: Some("secret".into()), remember: false }
            });
            assert_eq!(b.answer("main", "Username for 'https://h': ").await.as_deref(), Some("me"));
            assert_eq!(b.answer("main", "Password for 'https://me@h': ").await.as_deref(), Some("secret"));
        });
    }

    #[test]
    fn remembered_answers_are_used_until_forgotten() {
        tauri::async_runtime::block_on(async {
            let b = auto(|_| Reply { answer: Some("me".into()), password: Some("pw".into()), remember: true });
            b.answer("main", "Username for 'https://h': ").await;
            b.answer("main", "Password for 'https://me@h': ").await;
            assert_eq!(b.known(&classify("Password for 'https://me@h': ")).as_deref(), Some("pw"));
            assert!(b.known(&classify("Password for 'https://other@h': ")).is_none());
            b.forget_all();
            assert!(b.known(&classify("Username for 'https://h': ")).is_none());
        });
    }

    #[test]
    fn cancelling_answers_nothing() {
        tauri::async_runtime::block_on(async {
            let b = auto(|_| Reply::default());
            assert!(b.answer("main", "Username for 'https://h': ").await.is_none());
            assert!(!b.reply(999, Reply::default()));
        });
    }

    /// Real git and real ssh-keygen asking through the built editor.
    ///
    /// Needs the executable, so it runs only when given one:
    ///   JH_ASKPASS_TEST_EXE=<path to jh_editor.exe> cargo test --lib real_ -- --ignored
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_git_and_ssh_ask_through_the_editor() {
        let exe = std::path::PathBuf::from(std::env::var("JH_ASKPASS_TEST_EXE").expect("JH_ASKPASS_TEST_EXE"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let b = auto(|ev| match ev.question.kind.as_str() {
            "username" => Reply { answer: Some("me".into()), password: Some("s3cret".into()), remember: false },
            "passphrase" => Reply { answer: Some("phrase 1".into()), ..Default::default() },
            other => panic!("unexpected question: {}", other),
        });
        rt.spawn(serve(b.clone()));
        std::thread::sleep(Duration::from_millis(100));

        // git: no credential helper, so it asks GIT_ASKPASS for both halves.
        let mut git = std::process::Command::new("git");
        git.args(["-c", "credential.helper=", "credential", "fill"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        configure_with(&mut git, "main", false, &b, &exe);
        let mut child = git.spawn().unwrap();
        {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(b"protocol=https\nhost=example.invalid\n\n").unwrap();
        }
        let out = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap();
        assert!(out.contains("username=me\n"), "{}", out);
        assert!(out.contains("password=s3cret\n"), "{}", out);

        // ssh (Git for Windows' own): a key with a passphrase.
        let dir = std::env::temp_dir().join(format!("jh-askpass-ssh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let key = dir.join("id");
        let keygen = r"C:\Program Files\Git\usr\bin\ssh-keygen.exe";
        let made = std::process::Command::new(keygen)
            .args(["-q", "-t", "ed25519", "-N", "phrase 1", "-f"]).arg(&key)
            .output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        let mut read = std::process::Command::new(keygen);
        read.args(["-y", "-f"]).arg(&key).stdin(std::process::Stdio::null());
        configure_with(&mut read, "main", false, &b, &exe);
        let public = read.output().unwrap();
        assert!(public.status.success(), "ssh-keygen: {}", String::from_utf8_lossy(&public.stderr));
        assert!(String::from_utf8_lossy(&public.stdout).starts_with("ssh-ed25519 "));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole trip: a client on the pipe, the server, the "dialog".
    #[cfg(windows)]
    #[test]
    fn a_question_crosses_the_pipe_and_back() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let b = auto(|ev| Reply { answer: Some(format!("{}:{}", ev.window, ev.question.kind)), ..Default::default() });
        rt.spawn(serve(b.clone()));
        std::thread::sleep(Duration::from_millis(100));
        let got = ask(&b.pipe, &b.token, "main", "Username for 'https://h': ");
        assert_eq!(got.as_deref(), Some("main:username"));
        // A wrong token is not answered at all.
        assert!(ask(&b.pipe, "wrong", "main", "Username for 'https://h': ").is_none());
        // Several at once each get their own answer.
        let threads: Vec<_> = (0..4).map(|i| {
            let (pipe, token) = (b.pipe.clone(), b.token.clone());
            std::thread::spawn(move || ask(&pipe, &token, &format!("w{}", i), "Password for 'https://h': "))
        }).collect();
        for (i, t) in threads.into_iter().enumerate() {
            assert_eq!(t.join().unwrap(), Some(format!("w{}:password", i)));
        }
    }
}
