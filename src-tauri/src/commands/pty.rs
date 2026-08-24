use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use std::io::{Read, Write};

/// One window's terminal. `generation` is bumped on every (re)spawn/stop for
/// this window; reader/wait threads capture the generation they started under
/// and only emit `pty_closed` while it is still current — so a previous
/// session's delayed EOF (common on Windows ConPTY) can't close a freshly
/// reopened terminal.
struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    generation: Arc<AtomicUsize>,
}

/// Terminals, keyed by "<window label>::<terminal id>". One process can host
/// several windows, and each window several terminals, all independent.
pub struct PtyState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

/// The key a terminal is stored and addressed under.
///
/// `id` is the frontend's handle for one terminal within a window. It defaults
/// to "1" so a call that omits it keeps addressing the single terminal a
/// one-terminal frontend would have opened.
fn session_key(label: &str, id: &Option<String>) -> String {
    let id = id.as_deref().filter(|s| !s.is_empty()).unwrap_or("1");
    format!("{}::{}", label, id)
}

impl Default for PtyState {
    fn default() -> Self {
        PtyState { sessions: Arc::new(Mutex::new(HashMap::new())) }
    }
}

/// A shell the user can pick for the terminal.
#[derive(serde::Serialize, Clone)]
pub struct ShellInfo {
    /// Stable key stored in the frontend's settings.
    pub id: String,
    /// What to show in the picker.
    pub name: String,
    /// Absolute path to the executable.
    pub path: String,
}

/// Which shells exist on this machine.
///
/// Probed by looking for the executables rather than shelling out: the answer
/// feeds a settings dropdown, so it has to be quick and side-effect free.
#[tauri::command]
pub async fn list_shells() -> Result<Vec<ShellInfo>, String> {
    let mut found: Vec<ShellInfo> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let program_files = std::env::var("ProgramFiles").unwrap_or_default();
        let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());

        // (id, display name, candidate paths) — first existing path wins.
        let candidates: Vec<(&str, &str, Vec<String>)> = vec![
            ("powershell", "Windows PowerShell", vec![
                format!("{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", system_root),
            ]),
            ("pwsh", "PowerShell 7", vec![
                format!("{}\\PowerShell\\7\\pwsh.exe", program_files),
                format!("{}\\Microsoft\\WindowsApps\\pwsh.exe", local_app_data),
            ]),
            ("cmd", "Command Prompt", vec![
                format!("{}\\System32\\cmd.exe", system_root),
            ]),
            ("git-bash", "Git Bash", vec![
                format!("{}\\Git\\bin\\bash.exe", program_files),
                format!("{}\\Git\\bin\\bash.exe", program_files_x86),
                format!("{}\\Programs\\Git\\bin\\bash.exe", local_app_data),
            ]),
            ("wsl", "WSL", vec![
                format!("{}\\System32\\wsl.exe", system_root),
            ]),
        ];

        for (id, name, paths) in candidates {
            if let Some(hit) = paths.into_iter().find(|p| std::path::Path::new(p).exists()) {
                found.push(ShellInfo { id: id.into(), name: name.into(), path: hit });
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let candidates: Vec<(&str, &str, &str)> = vec![
            ("bash", "Bash", "/bin/bash"),
            ("zsh", "Zsh", "/bin/zsh"),
            ("fish", "Fish", "/usr/bin/fish"),
            ("sh", "sh", "/bin/sh"),
        ];
        for (id, name, path) in candidates {
            if std::path::Path::new(path).exists() {
                found.push(ShellInfo { id: id.into(), name: name.into(), path: path.into() });
            }
        }
    }

    Ok(found)
}

/// Arguments the shell needs to start clean (no profile banner where it matters).
fn shell_args(id: &str) -> Vec<&'static str> {
    match id {
        "powershell" | "pwsh" => vec!["-NoProfile", "-ExecutionPolicy", "Bypass"],
        // Login + interactive, so the user's ~/.bashrc and PATH are in effect.
        "git-bash" | "bash" | "zsh" => vec!["-l", "-i"],
        _ => vec![],
    }
}

/// Start this window's shell.
///
/// `shell` is an id from `list_shells`; `None` keeps the platform default, so an
/// older frontend — or a first run with nothing saved — behaves as before.
#[tauri::command]
pub async fn spawn_pty(
    webview: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, PtyState>,
    workspace_state: State<'_, crate::commands::fs::WorkspaceState>,
    shell: Option<String>,
    id: Option<String>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let key = session_key(&label, &id);

    // This window's workspace root (if any) becomes the shell's cwd.
    let cwd = workspace_state.roots.lock().unwrap().get(&label).cloned();

    let pty_system = NativePtySystem::default();
    let pty_pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // The chosen shell, if it is one we know about and it still exists.
    let chosen = match shell.as_deref() {
        Some(id) if !id.is_empty() => list_shells()
            .await
            .unwrap_or_default()
            .into_iter()
            .find(|s| s.id == id),
        _ => None,
    };

    let mut cmd = match &chosen {
        Some(info) => {
            let mut c = CommandBuilder::new(&info.path);
            c.args(&shell_args(&info.id));
            c
        }
        None => {
            #[cfg(target_os = "windows")]
            {
                let mut c = CommandBuilder::new("powershell.exe");
                c.args(&["-NoProfile", "-ExecutionPolicy", "Bypass"]);
                c
            }
            #[cfg(not(target_os = "windows"))]
            {
                CommandBuilder::new("bash")
            }
        }
    };

    if let Some(ref path) = cwd {
        if std::path::Path::new(path).exists() {
            cmd.cwd(path);
        } else {
            println!("Warning: CWD does not exist: {}, using default", path);
        }
    }

    // Reuse this window's persistent generation counter across respawns, so old
    // threads (which hold a clone) observe the bump and suppress stale closes.
    let gen_arc = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&key).map(|s| s.generation.clone())
    }
    .unwrap_or_else(|| Arc::new(AtomicUsize::new(0)));
    let my_gen = gen_arc.fetch_add(1, Ordering::SeqCst) + 1;

    println!("Spawning PTY [{}] in CWD: {:?}", key, cwd);
    let mut child = pty_pair.slave.spawn_command(cmd).map_err(|e| {
        println!("Error spawning PTY command: {}", e);
        e.to_string()
    })?;

    // Drop the slave now that the shell owns it, so the master read gets EOF
    // once the child exits (an open slave handle keeps the PTY alive).
    drop(pty_pair.slave);

    // Wait on the child and emit `pty_closed` (to THIS window) as soon as the
    // shell exits — Windows ConPTY read-EOF can lag well behind `exit`.
    let exit_app = app.clone();
    let exit_closed_ev = format!("pty_closed::{}", key);
    let exit_gen = gen_arc.clone();
    thread::spawn(move || {
        let _ = child.wait();
        if exit_gen.load(Ordering::SeqCst) == my_gen {
            let _ = exit_app.emit(&exit_closed_ev, ());
        }
    });

    let mut reader = pty_pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty_pair.master.take_writer().map_err(|e| e.to_string())?;

    // Register (replaces any previous session for this window; dropping the old
    // master is what finally unblocks the old reader thread).
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(
            key.clone(),
            PtySession { master: pty_pair.master, writer, generation: gen_arc.clone() },
        );
    }

    // Read output → this window only. Per-window event names guarantee no other
    // window's terminal receives it (Tauri v2 global `listen` otherwise sees
    // events regardless of emit target).
    let output_ev = format!("pty_output::{}", key);
    let closed_ev = format!("pty_closed::{}", key);
    thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let text = String::from_utf8_lossy(&buf[0..n]).to_string();
                    let _ = app.emit(&output_ev, text);
                }
                _ => {
                    // EOF/error → terminal closed. Suppress a stale reader whose
                    // EOF only arrived when a newer spawn dropped the old master.
                    if gen_arc.load(Ordering::SeqCst) == my_gen {
                        let _ = app.emit(&closed_ev, ());
                    }
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn write_to_pty(
    webview: tauri::WebviewWindow,
    data: String,
    id: Option<String>,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let key = session_key(webview.label(), &id);
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&key) {
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_pty(
    webview: tauri::WebviewWindow,
    cols: u16,
    rows: u16,
    id: Option<String>,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let key = session_key(webview.label(), &id);
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&key) {
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_pty(
    webview: tauri::WebviewWindow,
    id: Option<String>,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let key = session_key(webview.label(), &id);
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&key) {
        // Invalidate this session's threads so their close event is ignored,
        // then drop the session (closes master/writer).
        session.generation.fetch_add(1, Ordering::SeqCst);
    }
    sessions.remove(&key);
    Ok(())
}

/// Best-effort teardown for a window that is closing (called from the window
/// close handler). Same as stop_pty but takes the label directly.
pub fn stop_pty_for_label(state: &PtyState, label: &str) {
    let mut sessions = state.sessions.lock().unwrap();
    // Every terminal in the window, not just the first: the keys are
    // "<label>::<id>".
    let prefix = format!("{}::", label);
    let keys: Vec<String> = sessions
        .keys()
        .filter(|k| k.starts_with(&prefix) || k.as_str() == label)
        .cloned()
        .collect();
    for k in keys {
        if let Some(session) = sessions.get(&k) {
            session.generation.fetch_add(1, Ordering::SeqCst);
        }
        sessions.remove(&k);
    }
}
