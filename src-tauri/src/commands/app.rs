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

#[command]
pub async fn run_command(command: String, cwd: Option<String>) -> Result<String, String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("cmd");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        c.arg("/C").arg(&command);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg(&command);
        c
    };

    if let Some(c) = cwd {
        cmd.current_dir(c);
    }

    let output = cmd.output().map_err(|e| e.to_string())?;
    
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    
    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!("Command failed with exit code: {:?}\nStdout: {}\nStderr: {}", 
            output.status.code(), stdout, stderr))
    }
}

/// Open the webview's developer tools.
///
/// The window has to ask for these itself. F12 is bound to Go to Definition in
/// the editor, and a matched shortcut calls preventDefault() — which also
/// swallows WebView2's own DevTools hotkey, so the only way in was gone.
/// Ctrl+Shift+I now routes here instead of relying on the runtime.
#[command]
pub fn open_devtools(webview: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        webview.open_devtools();
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = webview;
        Err("DevTools are only built into a development build.".into())
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
