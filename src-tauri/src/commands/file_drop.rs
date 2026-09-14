//! Real filesystem paths for files dropped onto the page from outside the app.
//!
//! Tauri's native drag-drop handler is off (tauri.conf.json): it replaces
//! WebView2's own drop target, and the tabs and explorer rely on HTML5
//! drag-and-drop. A DOM drop only carries File objects, which have no path, so
//! the page hands them to the host with
//! `chrome.webview.postMessageWithAdditionalObjects` and this reads each one's
//! path back out (ICoreWebView2File::Path).
//!
//! The same message also reaches Tauri's IPC handler, which cannot parse it and
//! prints one console error per drop. That is harmless and cannot be avoided
//! from here: both handlers see every web message.

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{Runtime, Webview};

/// Must match DROP_MESSAGE_PREFIX in src/modules/utils/DroppedFiles.js.
pub const DROP_MESSAGE_PREFIX: &str = "jh-editor:dropped-files:";
/// Must match DROP_RESULT_EVENT in src/modules/utils/DroppedFiles.js.
pub const DROP_RESULT_EVENT: &str = "jh-dropped-files";

/// Webviews that already have the handler. It lives on the WebView2 instance,
/// which survives reloads, so it must be added once per webview, not per load.
static INSTALLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[derive(Clone, serde::Serialize)]
struct DroppedPaths {
    id: String,
    paths: Vec<String>,
}

/// Listen for dropped-file messages on `webview`. Safe to call on every page load.
pub fn install<R: Runtime>(webview: &Webview<R>) {
    {
        let mut installed = INSTALLED.lock().unwrap();
        if !installed.get_or_insert_with(HashSet::new).insert(webview.label().to_string()) {
            return;
        }
    }
    #[cfg(windows)]
    platform::install(webview);
}

#[cfg(windows)]
mod platform {
    use super::{DroppedPaths, DROP_MESSAGE_PREFIX, DROP_RESULT_EVENT};
    use tauri::{Emitter, Runtime, Webview};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
        ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::{Interface, PWSTR};

    pub fn install<R: Runtime>(webview: &Webview<R>) {
        let emitter = webview.clone();
        let result = webview.with_webview(move |platform| {
            let core = match unsafe { platform.controller().CoreWebView2() } {
                Ok(core) => core,
                Err(e) => {
                    log::warn!("file drop: no CoreWebView2: {e}");
                    return;
                }
            };
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut raw = PWSTR::null();
                // Not a string message: certainly not ours.
                if unsafe { args.TryGetWebMessageAsString(&mut raw) }.is_err() {
                    return Ok(());
                }
                let message = take_pwstr(raw);
                let Some(id) = message.strip_prefix(DROP_MESSAGE_PREFIX) else {
                    return Ok(());
                };
                let payload = DroppedPaths { id: id.to_string(), paths: dropped_paths(&args) };
                let label = emitter.label().to_string();
                if let Err(e) = emitter.emit_to(label.as_str(), DROP_RESULT_EVENT, payload) {
                    log::warn!("file drop: could not report dropped paths: {e}");
                }
                Ok(())
            }));
            let mut token = 0i64;
            if let Err(e) = unsafe { core.add_WebMessageReceived(&handler, &mut token) } {
                log::warn!("file drop: could not listen for dropped files: {e}");
            }
        });
        if let Err(e) = result {
            log::warn!("file drop: webview unavailable: {e}");
        }
    }

    /// Paths of the File objects sent along with the message, in order.
    /// Objects that are not files (or have no path) are skipped.
    fn dropped_paths(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Vec<String> {
        let mut paths = Vec::new();
        // Needs a WebView2 runtime with additional-objects support; older ones
        // simply report no paths, and the page says it could not open them.
        let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else {
            return paths;
        };
        let Ok(objects) = (unsafe { args2.AdditionalObjects() }) else {
            return paths;
        };
        let mut count = 0u32;
        if unsafe { objects.Count(&mut count) }.is_err() {
            return paths;
        }
        for index in 0..count {
            let Ok(object) = (unsafe { objects.GetValueAtIndex(index) }) else { continue };
            let Ok(file) = object.cast::<ICoreWebView2File>() else { continue };
            let mut raw = PWSTR::null();
            if unsafe { file.Path(&mut raw) }.is_ok() {
                let path = take_pwstr(raw);
                if !path.is_empty() {
                    paths.push(path);
                }
            }
        }
        paths
    }
}
