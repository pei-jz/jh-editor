// In-process multi-window management. Instead of spawning separate JHEditor
// processes per workspace, we open additional WebviewWindows in one process.
// The single process owns all windows, so "which window opens this file" is
// decided in-process (see route_open_in_process) — no cross-process IPC.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Lock without the `.unwrap()`.
///
/// A poisoned mutex means some other thread panicked while holding it.
/// `.unwrap()` turns that accident into a panic HERE, and every caller runs on
/// the main thread inside a window procedure, where a panic takes the whole
/// process down with it (see `route_second_launch`). What these locks guard are
/// small label -> path tables; a half-written entry in one is not worth every
/// window closing, so take the data as it stands.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Path a freshly-created window should open once its frontend boots. Keyed by
/// window label. An empty string means "show Welcome"; NO entry means the
/// window was never assigned one, which is a different answer (see
/// `take_launch_path`).
#[derive(Default)]
pub struct PendingLaunch {
    map: Mutex<HashMap<String, String>>,
}

static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(1);

/// WebView2 browser arguments. Must match `additionalBrowserArgs` in
/// tauri.conf.json exactly: webviews sharing a user data folder must be created
/// with identical environment options, or the later window fails to open.
///
/// The first three are wry's defaults, which any explicit value replaces.
/// CalculateNativeWinOcclusion is off because, with it on, a window fully
/// covered by another app counts as hidden and its rendered frames are
/// discarded; switching back then shows a blank window until a large document
/// has been repainted from scratch.
pub const WEBVIEW2_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion";

/// Case/slash-insensitive: is `file` located inside directory `dir`?
fn is_under(dir: &str, file: &str) -> bool {
    if dir.is_empty() {
        return false;
    }
    let norm = |s: &str| {
        let mut t = s.replace('\\', "/").trim_end_matches('/').to_string();
        if cfg!(windows) {
            t = t.to_lowercase();
        }
        t
    };
    let d = norm(dir);
    let f = norm(file);
    f == d || f.starts_with(&format!("{}/", d))
}

/// Create a new application window that will open `path` (folder → workspace,
/// file → single file, empty → Welcome). Returns the new window's label.
pub fn create_window(app: &AppHandle, path: &str) -> Result<String, String> {
    let label = format!("win-{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    if let Some(pending) = app.try_state::<PendingLaunch>() {
        lock(&pending.map).insert(label.clone(), path.to_string());
    }
    // Initial OS title (taskbar) reflects the folder/file name; the frontend
    // refines it once booted.
    let name = std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("");
    let title = if name.is_empty() { "J.H Editor".to_string() } else { format!("{} — J.H Editor", name) };
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(1000.0, 700.0)
        .decorations(false)
        .visible(false) // the frontend shows it after boot (matches window[0])
        .additional_browser_args(WEBVIEW2_BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

#[tauri::command]
pub fn create_app_window(app: AppHandle, path: Option<String>) -> Result<String, String> {
    create_window(&app, &path.unwrap_or_default())
}

/// Frontend calls this at startup to learn which path (if any) it should open.
///
/// `None` and `Some("")` are different answers and the caller depends on it:
/// `None` means this window was never assigned anything — it is the process's
/// first window, and the command line is that window's to read. `Some("")` is
/// an explicit "open nothing, show Welcome".
///
/// Returning "" for both is what made every window opened afterwards re-open
/// the file the process was LAUNCHED with: argv belongs to the process and is
/// never consumed, so right-click -> new window on an app started by
/// double-clicking a file landed on that same file, not on Welcome.
#[tauri::command]
pub fn take_launch_path(
    webview: tauri::WebviewWindow,
    pending: State<'_, PendingLaunch>,
) -> Option<String> {
    let label = webview.label().to_string();
    lock(&pending.map).remove(&label)
}

/// Find an existing window with no workspace (a "loose files" window). Used to
/// consolidate workspace-less files into one window instead of opening a new
/// window per file. Prefers the currently-focused such window.
fn find_workspaceless_window(app: &AppHandle) -> Option<WebviewWindow> {
    let with_ws: HashSet<String> = app
        .try_state::<crate::commands::fs::WorkspaceState>()
        .map(|s| lock(&s.roots).keys().cloned().collect())
        .unwrap_or_default();
    let mut candidates: Vec<WebviewWindow> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| !with_ws.contains(label))
        .map(|(_, w)| w)
        .collect();
    // Focused window first (stable, deterministic pick otherwise).
    candidates.sort_by_key(|w| !w.is_focused().unwrap_or(false));
    candidates.into_iter().next()
}

/// Route an externally-requested path (a second launch's argv, forwarded by the
/// single-instance plugin) to the right window in THIS process.
///
/// Called from inside a window procedure: the second process hands its argv
/// over with a blocking `SendMessage(WM_COPYDATA)`, and the plugin runs this on
/// the message. A panic on that stack unwinds across an `extern "system"`
/// boundary, which Rust answers by aborting — every window of every workspace
/// gone at once, no dialog, nothing in the log. `route_second_launch` is the
/// entry point the plugin gets, and it exists to make sure that a failure to
/// route one double-clicked file costs that file and nothing else.
pub fn route_second_launch(app: &AppHandle, target: &str) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        route_open_in_process(app, target);
    }));
    if result.is_err() {
        log::error!("could not route a second launch of {target:?}; ignoring it");
    }
}

fn route_open_in_process(app: &AppHandle, target: &str) {
    if target.is_empty() {
        // Launching the app with no path → open a NEW empty window (Welcome) so
        // the user can open another workspace, rather than focusing an existing
        // one. (Standard behavior, e.g. VS Code's "new window".)
        let _ = create_window(app, "");
        return;
    }

    let is_dir = std::path::Path::new(target).is_dir();
    if is_dir {
        // Folder: focus an existing window already rooted here, else open new.
        if let Some(state) = app.try_state::<crate::commands::fs::WorkspaceState>() {
            let roots = lock(&state.roots);
            for (label, root) in roots.iter() {
                if is_under(root, target) || root.eq_ignore_ascii_case(target) {
                    if let Some(w) = app.get_webview_window(label) {
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                        return;
                    }
                }
            }
        }
        let _ = create_window(app, target);
        return;
    }

    // File: hand to the window whose workspace contains it (deepest match).
    let mut best: Option<(usize, String)> = None; // (root len, label)
    if let Some(state) = app.try_state::<crate::commands::fs::WorkspaceState>() {
        let roots = lock(&state.roots);
        for (label, root) in roots.iter() {
            if is_under(root, target) {
                let len = root.len();
                if best.as_ref().map(|(bl, _)| len > *bl).unwrap_or(true) {
                    best = Some((len, label.clone()));
                }
            }
        }
    }
    if let Some((_, label)) = best {
        if let Some(w) = app.get_webview_window(&label) {
            emit_open_file(app, &label, target);
            let _ = w.unminimize();
            let _ = w.set_focus();
            return;
        }
    }
    // Nobody's workspace owns it → consolidate into an existing workspace-less
    // window (open as a new tab there), else open a fresh one.
    if let Some(w) = find_workspaceless_window(app) {
        let label = w.label().to_string();
        emit_open_file(app, &label, target);
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let _ = create_window(app, target);
}

/// Tell a specific window to open a file. The target label is carried IN the
/// payload so the frontend can ignore events meant for other windows — Tauri v2
/// global `listen` otherwise receives events regardless of the emit target.
fn emit_open_file(app: &AppHandle, label: &str, path: &str) {
    let _ = app.emit_to(
        label,
        "open-external-file",
        serde_json::json!({ "label": label, "path": path }),
    );
}
