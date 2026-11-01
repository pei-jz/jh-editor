// Folder Jump: a small search window that reaches a folder from anywhere, so
// finding one stops meaning another Explorer window and a walk through its tree.
//
// Off by default. Turned on, the app stays resident: a tray icon, a global
// hotkey and a hidden "folder-jump" window kept loaded so it appears at once.
// That hidden window is also what keeps the process alive once every editor
// window is closed, so nothing else has to change for the app to stay running,
// and turning the feature off (which destroys it) restores the old behaviour.
//
// The on/off state lives in a file rather than localStorage because the tray and
// the hotkey are installed in `setup`, before any webview can answer.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::commands::window::{focus_or_open_workspace, lock, WEBVIEW2_BROWSER_ARGS};

pub const WINDOW_LABEL: &str = "folder-jump";
const TRAY_ID: &str = "folder-jump-tray";
const CONFIG_FILE: &str = "folder-jump.json";
/// Next to Win+E on purpose: the habit this exists to replace.
const DEFAULT_HOTKEY: &str = "Super+Shift+KeyE";

/// Past either limit the list is cut and reported as partial. A registered
/// folder can be a whole drive or a slow share, and a search box that hangs on
/// one is worse than one that says it did not finish.
const MAX_FOLDERS: usize = 50_000;
const MAX_DEPTH: usize = 12;
const WALK_BUDGET: Duration = Duration::from_secs(20);

/// Generated, and never a place anyone means to go, in or out of a repository.
const SKIPPED_DIRS: [&str; 2] = ["node_modules", "__pycache__"];

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TrayLabels {
    pub jump: String,
    pub new_window: String,
    pub quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            jump: "Folder Jump".to_string(),
            new_window: "New Window".to_string(),
            quit: "Quit".to_string(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FolderJumpConfig {
    pub enabled: bool,
    pub hotkey: String,
    /// The tray menu is built before any webview has a language to offer, so the
    /// last labels the frontend sent are kept with the rest.
    pub labels: TrayLabels,
}

impl Default for FolderJumpConfig {
    fn default() -> Self {
        Self { enabled: false, hotkey: DEFAULT_HOTKEY.to_string(), labels: TrayLabels::default() }
    }
}

/// What the settings screen is told: the saved config, plus whether its hotkey
/// is actually held. Another app can take it between two runs.
#[derive(Serialize)]
pub struct FolderJumpStatus {
    pub enabled: bool,
    pub hotkey: String,
    pub hotkey_error: Option<String>,
}

#[derive(Default)]
pub struct FolderJumpState {
    config: Mutex<FolderJumpConfig>,
    active: Mutex<Option<Shortcut>>,
    hotkey_error: Mutex<Option<String>>,
    /// The tray's Quit is closing the editor windows. Each still asks about its
    /// unsaved tabs, so the process exits when the last one has really gone.
    quitting: AtomicBool,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(CONFIG_FILE))
}

fn load_config(app: &AppHandle) -> FolderJumpConfig {
    config_path(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &FolderJumpConfig) -> Result<(), String> {
    let path = config_path(app).ok_or("No configuration directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Called once from `setup`. A hotkey another app holds must not stop the app
/// from starting: the tray still works, and the settings screen reports it.
pub fn setup(app: &AppHandle) {
    let config = load_config(app);
    let state = FolderJumpState::default();
    *lock(&state.config) = config.clone();
    app.manage(state);
    if !config.enabled {
        return;
    }
    let state = app.state::<FolderJumpState>();
    match Shortcut::from_str(&config.hotkey).map_err(|e| e.to_string()).and_then(|shortcut| {
        app.global_shortcut().register(shortcut).map_err(|e| e.to_string())?;
        Ok(shortcut)
    }) {
        Ok(shortcut) => *lock(&state.active) = Some(shortcut),
        Err(e) => {
            log::warn!("Folder Jump: could not register {}: {e}", config.hotkey);
            *lock(&state.hotkey_error) = Some(e);
        }
    }
    if let Err(e) = install_tray(app, &config.labels) {
        log::error!("Folder Jump: could not create the tray icon: {e}");
    }
    spawn_window(app);
}

/// Handled by the plugin's own message loop, so show and hide only; building a
/// window there would deadlock (see `create_app_window`).
pub fn on_hotkey(app: &AppHandle) {
    toggle_window(app);
}

fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        spawn_window(app);
        return;
    };
    if window.is_visible().unwrap_or(false) && is_foreground(&window) {
        let _ = window.hide();
        return;
    }
    if let Some(state) = app.try_state::<FolderJumpState>() {
        state.quitting.store(false, Ordering::Relaxed);
    }
    place_on_cursor_monitor(app, &window);
    let _ = app.emit_to(WINDOW_LABEL, "folder-jump:opened", ());
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(windows)]
fn is_foreground(window: &tauri::WebviewWindow) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    // SAFETY: takes nothing and only reads which window is in front.
    let foreground = unsafe { GetForegroundWindow() };
    window.hwnd().map(|own| own.0 as isize == foreground.0 as isize).unwrap_or(false)
}

#[cfg(not(windows))]
fn is_foreground(window: &tauri::WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false)
}

/// Hide once the app has really gone to the background.
///
/// `Focused(false)` alone does not mean that: keyboard focus moving from the
/// window into the WebView2 inside it can report the same way, and hiding on
/// that would close the window as it opens. So look at which window is in front,
/// a moment later: during a real switch Windows may not have finished changing it.
fn hide_if_left_behind(window: tauri::WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        if !is_foreground(&window) {
            let _ = window.hide();
        }
    });
}

/// On the monitor the mouse is on, which is the one being worked on. A window
/// that always opens on the primary monitor is a trip to the wrong screen.
fn place_on_cursor_monitor(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Ok(cursor) = app.cursor_position() else { return };
    let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) else { return };
    let Ok(size) = window.outer_size() else { return };
    let (origin, area) = (monitor.position(), monitor.size());
    let x = origin.x + (area.width as i32 - size.width as i32) / 2;
    let y = origin.y + area.height as i32 / 5;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Off the calling thread, for the reason on `create_app_window`.
fn spawn_window(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = build_window(&app) {
            log::error!("Folder Jump: could not create its window: {e}");
        }
    });
}

fn build_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("folder-jump.html".into()))
        .title("Folder Jump")
        .inner_size(640.0, 460.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .additional_browser_args(WEBVIEW2_BROWSER_ARGS)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn build_tray_menu(app: &AppHandle, labels: &TrayLabels) -> tauri::Result<Menu<tauri::Wry>> {
    let jump = MenuItem::with_id(app, "jump", &labels.jump, true, None::<&str>)?;
    let new_window = MenuItem::with_id(app, "new-window", &labels.new_window, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&jump, &new_window, &quit])
}

fn install_tray(app: &AppHandle, labels: &TrayLabels) -> Result<(), String> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let menu = build_tray_menu(app, labels).map_err(|e| e.to_string())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("J.H Editor")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "jump" => toggle_window(app),
            "new-window" => {
                // This is the main thread, where building a webview deadlocks.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::commands::window::create_window(&app, "");
                });
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map(|_| ()).map_err(|e| e.to_string())
}

fn editor_labels(app: &AppHandle, except: Option<&str>) -> Vec<String> {
    app.webview_windows()
        .into_keys()
        .filter(|label| label != WINDOW_LABEL && Some(label.as_str()) != except)
        .collect()
}

/// Closes through each window's own close path, so unsaved tabs are still asked
/// about. Declining leaves that window open and the app running.
fn quit(app: &AppHandle) {
    let editors = editor_labels(app, None);
    if editors.is_empty() {
        app.exit(0);
        return;
    }
    if let Some(state) = app.try_state::<FolderJumpState>() {
        state.quitting.store(true, Ordering::Relaxed);
    }
    for label in editors {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
}

/// Returns true when the event was the jump window's and needs nothing further.
///
/// Runs inside a window procedure, so like the rest of `on_window_event` it must
/// not panic.
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) -> bool {
    let app = window.app_handle();
    if let tauri::WindowEvent::Destroyed = event {
        if let Some(state) = app.try_state::<FolderJumpState>() {
            if state.quitting.load(Ordering::Relaxed)
                && editor_labels(app, Some(window.label())).is_empty()
            {
                app.exit(0);
            }
        }
    }
    if window.label() != WINDOW_LABEL {
        return false;
    }
    match event {
        // Alt+F4 must not cost the loaded window, which is the process's reason
        // to stay alive. `destroy` from the settings does not come through here.
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
        }
        // A launcher left floating over whatever you moved on to is in the way.
        tauri::WindowEvent::Focused(false) => {
            if let Some(jump) = app.get_webview_window(WINDOW_LABEL) {
                hide_if_left_behind(jump);
            }
        }
        _ => {}
    }
    true
}

#[tauri::command(async)]
pub fn folder_jump_get_status(state: State<'_, FolderJumpState>) -> FolderJumpStatus {
    let config = lock(&state.config);
    FolderJumpStatus {
        enabled: config.enabled,
        hotkey: config.hotkey.clone(),
        hotkey_error: lock(&state.hotkey_error).clone(),
    }
}

/// Turn the feature on or off, or move it to another hotkey. A hotkey that cannot
/// be registered changes nothing: the old one is put back and the error returned.
#[tauri::command]
pub async fn folder_jump_set_config(
    app: AppHandle,
    enabled: bool,
    hotkey: String,
) -> Result<FolderJumpStatus, String> {
    let state = app.state::<FolderJumpState>();
    let shortcut = Shortcut::from_str(&hotkey).map_err(|e| e.to_string())?;
    let shortcuts = app.global_shortcut();

    let previous = lock(&state.active).take();
    if let Some(old) = previous {
        let _ = shortcuts.unregister(old);
    }
    if enabled {
        if let Err(e) = shortcuts.register(shortcut) {
            if let Some(old) = previous {
                let _ = shortcuts.register(old);
            }
            *lock(&state.active) = previous;
            return Err(e.to_string());
        }
        *lock(&state.active) = Some(shortcut);
    }
    *lock(&state.hotkey_error) = None;

    let config = {
        let mut config = lock(&state.config);
        config.enabled = enabled;
        config.hotkey = hotkey.clone();
        config.clone()
    };
    if enabled {
        install_tray(&app, &config.labels)?;
        build_window(&app)?;
    } else {
        let _ = app.remove_tray_by_id(TRAY_ID);
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.destroy();
        }
    }
    save_config(&app, &config)?;
    Ok(FolderJumpStatus { enabled, hotkey, hotkey_error: None })
}

/// The tray menu's words, in the language the editor is showing.
#[tauri::command]
pub async fn folder_jump_set_tray_labels(app: AppHandle, labels: TrayLabels) -> Result<(), String> {
    let state = app.state::<FolderJumpState>();
    let config = {
        let mut config = lock(&state.config);
        config.labels = labels;
        config.clone()
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_tray_menu(&app, &config.labels).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    save_config(&app, &config)
}

/// The window already on this folder if there is one, else a new one.
#[tauri::command]
pub async fn open_folder_as_workspace(app: AppHandle, path: String) -> Result<(), String> {
    focus_or_open_workspace(&app, &path)
}

/// Show a folder in Explorer. A window already showing it is brought forward
/// rather than joined by another, which is how Explorer windows pile up.
/// Returns whether an existing window was reused.
#[tauri::command]
pub async fn open_folder_in_explorer(path: String) -> Result<bool, String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("Folder not found: {path}"));
    }
    let target = path.clone();
    let reused = tauri::async_runtime::spawn_blocking(move || focus_explorer_on(&target))
        .await
        .unwrap_or(false);
    if !reused {
        crate::commands::app::reveal_in_file_manager(path)?;
    }
    Ok(reused)
}

#[cfg(not(windows))]
fn focus_explorer_on(_path: &str) -> bool {
    false
}

/// Find an Explorer tab on `path` through the Shell's window list, and bring its
/// window forward. Any failure is only a missed reuse: the caller opens a window.
///
/// A tab sitting behind another in its window does not count. There is no API to
/// switch to it, so raising that window would show some other folder.
#[cfg(windows)]
fn focus_explorer_on(path: &str) -> bool {
    use windows::core::{Interface, GUID, HSTRING, PWSTR};
    use windows::Win32::Foundation::{HWND, MAX_PATH};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IServiceProvider, CLSCTX_LOCAL_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Shell::{
        IShellBrowser, IShellWindows, IWebBrowser2, PathCreateFromUrlW, ShellWindows,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    // SID_STopLevelBrowser, from shlguid.h.
    const TOP_LEVEL_BROWSER: GUID = GUID::from_u128(0x4c96be40_915c_11cf_99d3_00aa004ae837);

    fn normalize(path: &str) -> String {
        path.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    }

    // SAFETY: COM stays initialised on this thread for the whole block (the
    // pool thread may have it already, which only makes the pair a refcount),
    // every interface is released before CoUninitialize, and the out-buffer
    // handed to PathCreateFromUrlW is sized by its `len` argument.
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let found = (|| -> Option<isize> {
            let wanted = normalize(path);
            let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER).ok()?;
            for i in 0..windows.Count().ok()? {
                let Ok(item) = windows.Item(&VARIANT::from(i)) else { continue };
                let Ok(browser) = item.cast::<IWebBrowser2>() else { continue };
                let Ok(url) = browser.LocationURL() else { continue };
                if url.is_empty() {
                    continue; // Home, This PC and the like have no path.
                }
                let mut buffer = [0u16; MAX_PATH as usize * 4];
                let mut len = buffer.len() as u32;
                if PathCreateFromUrlW(&HSTRING::from(url.to_string()), PWSTR(buffer.as_mut_ptr()), &mut len, 0).is_err() {
                    continue; // Not a file location: FTP, a search result.
                }
                if normalize(&String::from_utf16_lossy(&buffer[..len as usize])) != wanted {
                    continue;
                }
                // Each tab is its own entry here, all naming the same top-level
                // window. Its own child window is shown only while it is in front.
                let shown = browser
                    .cast::<IServiceProvider>()
                    .and_then(|sp| sp.QueryService::<IShellBrowser>(&TOP_LEVEL_BROWSER))
                    .and_then(|tab| tab.GetWindow())
                    .map(|tab| IsWindowVisible(tab).as_bool())
                    .unwrap_or(true);
                if !shown {
                    continue;
                }
                if let Ok(handle) = browser.HWND() {
                    return Some(handle.0 as isize);
                }
            }
            None
        })();
        let raised = found.map(|handle| {
            let window = HWND(handle as *mut _);
            if IsIconic(window).as_bool() {
                let _ = ShowWindow(window, SW_RESTORE);
            }
            SetForegroundWindow(window).as_bool()
        });
        if init.is_ok() {
            CoUninitialize();
        }
        raised.unwrap_or(false)
    }
}

/// A terminal in the folder: Windows Terminal, else a plain console. The folder
/// is the process's working directory, never part of a command line, so a name
/// with `;` or `&` in it means nothing to `wt` or `cmd`.
#[tauri::command(async)]
pub fn open_terminal_at(path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("Folder not found: {path}"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let terminal = std::process::Command::new("wt.exe").current_dir(&path).args(["-d", "."]).spawn();
        if terminal.is_ok() {
            return Ok(());
        }
        std::process::Command::new("cmd.exe")
            .current_dir(&path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("Opening a terminal is only implemented on Windows".to_string())
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FolderList {
    pub folders: Vec<String>,
    /// A limit stopped the walk, so the list is not the whole tree.
    pub partial: bool,
}

#[cfg(windows)]
fn hidden_or_system(entry: &ignore::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
    entry.metadata().map(|m| m.file_attributes() & HIDDEN_OR_SYSTEM != 0).unwrap_or(false)
}

#[cfg(not(windows))]
fn hidden_or_system(_entry: &ignore::DirEntry) -> bool {
    false
}

/// Every folder below `roots`, not the roots themselves. Honours `.gitignore`
/// like the file search, and skips hidden and system folders, which is what keeps
/// `AppData` and `$RECYCLE.BIN` out when someone registers their home or a drive.
fn walk_folders(roots: &[String], max_folders: usize, budget: Duration) -> FolderList {
    let found = Arc::new(Mutex::new(Vec::new()));
    let count = Arc::new(AtomicUsize::new(0));
    let partial = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + budget;

    for root in roots {
        if !Path::new(root).is_dir() {
            continue; // A registered folder that has gone is not an error here.
        }
        let walker = ignore::WalkBuilder::new(root)
            .threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
            .max_depth(Some(MAX_DEPTH))
            .follow_links(false)
            .hidden(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .ignore(true)
            .filter_entry(|entry| {
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if !is_dir || entry.depth() == 0 {
                    return true;
                }
                let skipped = SKIPPED_DIRS
                    .iter()
                    .any(|name| entry.file_name().eq_ignore_ascii_case(name));
                !skipped && !hidden_or_system(entry)
            })
            .build_parallel();
        walker.run(|| {
            let (found, count, partial) = (found.clone(), count.clone(), partial.clone());
            Box::new(move |entry| {
                if Instant::now() > deadline {
                    partial.store(true, Ordering::Relaxed);
                    return ignore::WalkState::Quit;
                }
                let Ok(entry) = entry else { return ignore::WalkState::Continue };
                if entry.depth() == 0 || !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    return ignore::WalkState::Continue;
                }
                // Claim the slot first: the walk runs on several threads.
                if count.fetch_add(1, Ordering::Relaxed) >= max_folders {
                    partial.store(true, Ordering::Relaxed);
                    return ignore::WalkState::Quit;
                }
                lock(&found).push(entry.path().to_string_lossy().to_string());
                ignore::WalkState::Continue
            })
        });
        if partial.load(Ordering::Relaxed) {
            break;
        }
    }
    let folders = std::mem::take(&mut *lock(&found));
    FolderList { folders, partial: partial.load(Ordering::Relaxed) }
}

#[tauri::command]
pub async fn list_subfolders(roots: Vec<String>) -> Result<FolderList, String> {
    tauri::async_runtime::spawn_blocking(move || walk_folders(&roots, MAX_FOLDERS, WALK_BUDGET))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A directory under the system temp folder, removed when dropped.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("jh-folder-jump-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn mkdir(&self, rel: &str) {
            fs::create_dir_all(self.0.join(rel)).unwrap();
        }
        fn root(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
        fn names(&self, list: &FolderList) -> Vec<String> {
            let mut names: Vec<String> = list
                .folders
                .iter()
                .map(|f| Path::new(f).strip_prefix(&self.0).unwrap().to_string_lossy().replace('\\', "/"))
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_folders_below_the_root_but_not_files_or_the_root() {
        let tree = TempTree::new("basic");
        tree.mkdir("docs/設計");
        tree.mkdir("src");
        fs::write(tree.0.join("docs/readme.txt"), "x").unwrap();
        let list = walk_folders(&[tree.root()], 100, WALK_BUDGET);
        assert_eq!(tree.names(&list), vec!["docs", "docs/設計", "src"]);
        assert!(!list.partial);
    }

    #[test]
    fn leaves_out_generated_and_dot_folders() {
        let tree = TempTree::new("skips");
        tree.mkdir("app/node_modules/left-pad");
        tree.mkdir("NODE_MODULES");
        tree.mkdir(".git/objects");
        tree.mkdir("app/__pycache__");
        let list = walk_folders(&[tree.root()], 100, WALK_BUDGET);
        assert_eq!(tree.names(&list), vec!["app"]);
    }

    #[test]
    fn says_so_when_the_limit_cuts_the_list() {
        let tree = TempTree::new("limit");
        for i in 0..20 {
            tree.mkdir(&format!("d{i}"));
        }
        let list = walk_folders(&[tree.root()], 5, WALK_BUDGET);
        assert!(list.partial);
        assert!(list.folders.len() <= 5);
    }

    #[test]
    fn an_empty_time_budget_reports_a_partial_list() {
        let tree = TempTree::new("budget");
        tree.mkdir("a");
        let list = walk_folders(&[tree.root()], 100, Duration::ZERO);
        assert!(list.partial);
    }

    #[test]
    fn a_registered_folder_that_has_gone_is_skipped() {
        let tree = TempTree::new("gone");
        tree.mkdir("a");
        let missing = tree.0.join("nope").to_string_lossy().to_string();
        let list = walk_folders(&[missing, tree.root()], 100, WALK_BUDGET);
        assert_eq!(tree.names(&list), vec!["a"]);
    }

    #[test]
    fn the_default_hotkey_parses() {
        assert!(Shortcut::from_str(DEFAULT_HOTKEY).is_ok());
    }

    #[test]
    fn a_config_from_an_older_build_fills_in_what_it_lacks() {
        let config: FolderJumpConfig = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(config.enabled);
        assert_eq!(config.hotkey, DEFAULT_HOTKEY);
        assert_eq!(config.labels.quit, "Quit");
    }
}
