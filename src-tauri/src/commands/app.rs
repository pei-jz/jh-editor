use tauri::command;

#[command]
pub fn get_launch_args() -> Vec<String> {
    std::env::args().collect()
}

/// True when `path` points at an existing directory. Used at startup to decide
/// whether a launch argument should open as a workspace (folder) or a file.
#[command]
pub fn path_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// Expand shell-style environment placeholders in a path so the frontend can
/// pass platform-portable strings like "%APPDATA%/JH/ai-connection.json" or
/// "$HOME/.config/JH/ai-connection.json" and get back an absolute, resolved
/// filesystem path.
///
/// Used by ConnectionConfig.js to auto-discover the JH AI Agent connection
/// settings written by JH AI Agent's "Export Connection" button.
///
/// Supports:
///   - %NAME%   (Windows)
///   - $NAME    (Unix, simple form)
///   - ${NAME}  (Unix, braced form)
///
/// Unknown variables are left as-is; the caller (JS) treats unresolved
/// placeholders as "skip this candidate path".
#[command]
pub fn expand_env_path(path: String) -> String {
    let mut out = String::with_capacity(path.len() + 32);
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // Windows: %NAME%
        if c == b'%' {
            if let Some(end) = bytes[i + 1..].iter().position(|&b| b == b'%') {
                let name = &path[i + 1..i + 1 + end];
                if let Ok(val) = std::env::var(name) {
                    out.push_str(&val);
                    i += end + 2;
                    continue;
                }
            }
        }
        // Unix: ${NAME}
        if c == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(end) = bytes[i + 2..].iter().position(|&b| b == b'}') {
                let name = &path[i + 2..i + 2 + end];
                if let Ok(val) = std::env::var(name) {
                    out.push_str(&val);
                    i += end + 3;
                    continue;
                }
            }
        }
        // Unix: $NAME (alphanumeric + underscore until non-name char)
        if c == b'$' && i + 1 < bytes.len()
            && (bytes[i + 1].is_ascii_alphabetic() || bytes[i + 1] == b'_') {
            let mut end = i + 1;
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                end += 1;
            }
            let name = &path[i + 1..end];
            if let Ok(val) = std::env::var(name) {
                out.push_str(&val);
                i = end;
                continue;
            }
        }
        out.push(c as char);
        i += 1;
    }
    out
}

/// Open the webview's developer tools.
///
/// The window has to ask for these itself. F12 is bound to Go to Definition in
/// the editor, and a matched shortcut calls preventDefault() — which also
/// swallows WebView2's own DevTools hotkey, so the only way in was gone.
/// Ctrl+Shift+I now routes here instead of relying on the runtime.
///
/// This stays available in release builds (the `devtools` feature on the tauri
/// crate). A shipped build fails differently from a dev one — the assets are
/// bundled and served from `tauri://`, and the configured CSP is only injected
/// there, so a whole class of problem first appears in the packaged app and
/// nowhere else. Without this the only report from such a build is whatever the
/// user can describe from a screenshot.
#[command]
pub fn open_devtools(webview: tauri::WebviewWindow) -> Result<(), String> {
    webview.open_devtools();
    Ok(())
}

/// Whether this build is the copy the installer put on disk.
///
/// The updater downloads an NSIS installer and runs it with `/UPDATE` and no
/// `/D`, so the new version always lands in the registered install directory.
/// Run a portable copy of the exe and accept an update and it "succeeds": the
/// installer writes a fresh install somewhere else, the exe still running is
/// untouched, and the next launch is the same old build. No error is raised,
/// so nothing tells the user their update went to another folder.
///
/// The installer records where it put things (src-tauri/nsis/hooks.nsh). If
/// that value is missing, or names a different directory than the one this exe
/// is sitting in, this is not the installed copy and the update path must stay
/// closed.
///
/// Anywhere but Windows this is meaningless — there is no portable build to
/// tell apart — so it answers yes and nothing gets disabled.
#[command]
pub fn is_installed() -> bool {
    #[cfg(not(windows))]
    {
        true
    }

    #[cfg(windows)]
    {
        use std::path::Path;

        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let Some(dir) = exe.parent() else {
            return false;
        };

        // Compare canonical paths: the recorded value and the running exe can
        // disagree over a trailing separator, 8.3 short names or case, and all
        // three would read as "not installed" on a plain string compare.
        let Ok(dir) = dir.canonicalize() else {
            return false;
        };

        const KEY: &str = r"Software\io.github.pei-jz.jheditor";

        // Which hive depends on the install mode the user picked, so try both.
        [
            windows_registry::CURRENT_USER,
            windows_registry::LOCAL_MACHINE,
        ]
        .iter()
        .filter_map(|hive| hive.open(KEY).ok())
        .filter_map(|key| key.get_string("InstallLocation").ok())
        .any(|recorded| {
            Path::new(&recorded)
                .canonicalize()
                .map(|p| p == dir)
                .unwrap_or(false)
        })
    }
}

/// Reveal a path in the OS file manager (Explorer / Finder / the desktop's
/// default). For a file the item itself is selected; for a directory the folder
/// is opened.
///
/// The path is passed as a process ARGUMENT, never interpolated into a shell
/// command line, so names containing spaces, quotes or `&` are safe.
#[command]
pub fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path not found: {}", path));
    }
    let is_dir = p.is_dir();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Explorer wants backslashes; `/select,` highlights the item.
        let native = path.replace('/', "\\");
        let mut cmd = std::process::Command::new("explorer");
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if is_dir {
            cmd.arg(&native);
        } else {
            cmd.arg(format!("/select,{}", native));
        }
        // explorer.exe returns a non-zero exit code even on success, so only a
        // spawn failure counts as an error here.
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if is_dir { cmd.arg(&path); } else { cmd.arg("-R").arg(&path); }
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        // No portable "select the file" on Linux — open the containing folder.
        let target = if is_dir { p } else { p.parent().unwrap_or(p) };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
