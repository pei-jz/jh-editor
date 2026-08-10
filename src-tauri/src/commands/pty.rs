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

/// Per-window terminals, keyed by the calling webview's label. One process can
/// host several windows, each with its own independent terminal.
pub struct PtyState {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl Default for PtyState {
    fn default() -> Self {
        PtyState { sessions: Arc::new(Mutex::new(HashMap::new())) }
    }
}

#[tauri::command]
pub async fn spawn_pty(
    webview: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, PtyState>,
    workspace_state: State<'_, crate::commands::fs::WorkspaceState>,
) -> Result<(), String> {
    let label = webview.label().to_string();

    // This window's workspace root (if any) becomes the shell's cwd.
    let cwd = workspace_state.roots.lock().unwrap().get(&label).cloned();

    let pty_system = NativePtySystem::default();
    let pty_pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    let mut cmd = CommandBuilder::new("powershell.exe");
    #[cfg(target_os = "windows")]
    cmd.args(&["-NoProfile", "-ExecutionPolicy", "Bypass"]);

    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new("bash");

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
        sessions.get(&label).map(|s| s.generation.clone())
    }
    .unwrap_or_else(|| Arc::new(AtomicUsize::new(0)));
    let my_gen = gen_arc.fetch_add(1, Ordering::SeqCst) + 1;

    println!("Spawning PTY [{}] in CWD: {:?}", label, cwd);
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
    let exit_closed_ev = format!("pty_closed::{}", label);
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
            label.clone(),
            PtySession { master: pty_pair.master, writer, generation: gen_arc.clone() },
        );
    }

    // Read output → this window only. Per-window event names guarantee no other
    // window's terminal receives it (Tauri v2 global `listen` otherwise sees
    // events regardless of emit target).
    let output_ev = format!("pty_output::{}", label);
    let closed_ev = format!("pty_closed::{}", label);
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
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&label) {
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_pty(
    webview: tauri::WebviewWindow,
    cols: u16,
    rows: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&label) {
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
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&label) {
        // Invalidate this window's threads so their close event is ignored,
        // then drop the session (closes master/writer).
        session.generation.fetch_add(1, Ordering::SeqCst);
    }
    sessions.remove(&label);
    Ok(())
}

/// Best-effort teardown for a window that is closing (called from the window
/// close handler). Same as stop_pty but takes the label directly.
pub fn stop_pty_for_label(state: &PtyState, label: &str) {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(label) {
        session.generation.fetch_add(1, Ordering::SeqCst);
    }
    sessions.remove(label);
}
