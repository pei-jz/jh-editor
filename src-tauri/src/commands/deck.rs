//! jh-presentation decks (single-file HTML slides) shown in Deck View.

use tauri::command;

/// True for an `.html` / `.htm` file whose text carries jh-presentation's
/// generator meta — the same test the frontend uses to pick Deck View.
fn is_deck(path: &str) -> bool {
    let lower = path.to_lowercase();
    if !(lower.ends_with(".html") || lower.ends_with(".htm")) {
        return false;
    }
    match std::fs::read_to_string(path) {
        Ok(text) => text.contains("<meta name=\"generator\" content=\"jh-presentation"),
        Err(_) => false,
    }
}

/// Open a deck in the default browser, where it can be presented with its own
/// presenter view in a second window (projector + laptop).
///
/// Narrow on purpose, like `open_office_file`: opening a path with its default
/// handler is a shell execute, so this takes only a saved file that really is a
/// jh-presentation deck.
#[command]
pub fn open_deck_in_browser(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("File not found: {}", path));
    }
    if !is_deck(&path) {
        return Err(format!("Not a jh-presentation deck: {}", path));
    }
    open::that_detached(&path).map_err(|e| e.to_string())
}

/// Label of the presentation window that Deck View opens on a second monitor.
pub const AUDIENCE_LABEL: &str = "deck-audience";

/// Open the presentation window (`deck-audience.html`) full screen at the given
/// spot — the second monitor, worked out by the frontend.
///
/// It is built here rather than from JS for one reason: on Windows every
/// WebView2 in the app has to start with the same browser arguments, and the
/// main window sets `additionalBrowserArgs` in tauri.conf.json. The JS window
/// API cannot pass those, so a window made there came up empty and white. This
/// copies them from the configured window.
///
/// Async on purpose: creating a window from a synchronous command deadlocks on
/// Windows.
#[command]
pub async fn open_deck_audience(
    app: tauri::AppHandle,
    owner: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if let Some(old) = app.get_webview_window(AUDIENCE_LABEL) {
        let _ = old.destroy();
    }
    let args = app
        .config()
        .app
        .windows
        .iter()
        .find_map(|w| w.additional_browser_args.clone());
    // Which window to report back to — the presenter view that opened this one.
    let owner_js = serde_json::to_string(&owner).map_err(|e| e.to_string())?;
    let mut builder = WebviewWindowBuilder::new(
        &app,
        AUDIENCE_LABEL,
        WebviewUrl::App("deck-audience.html".into()),
    )
    .title("J.H Editor — Slides")
    .position(x, y)
    .inner_size(width, height)
    .decorations(false)
    .focused(false)
    .disable_drag_drop_handler()
    .initialization_script(format!("window.__JH_DECK_OWNER__ = {};", owner_js));
    if let Some(args) = args.as_deref() {
        builder = builder.additional_browser_args(args);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_decks_are_opened() {
        let dir = std::env::temp_dir().join(format!("jh-deck-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let deck = dir.join("talk.html");
        std::fs::write(&deck, "<meta name=\"generator\" content=\"jh-presentation 0.5.2\">").unwrap();
        let page = dir.join("page.html");
        std::fs::write(&page, "<html></html>").unwrap();
        let exe = dir.join("tool.exe");
        std::fs::write(&exe, "<meta name=\"generator\" content=\"jh-presentation 0.5.2\">").unwrap();

        assert!(is_deck(deck.to_str().unwrap()));
        assert!(!is_deck(page.to_str().unwrap()));
        assert!(!is_deck(exe.to_str().unwrap()));
        assert!(open_deck_in_browser(dir.join("missing.html").to_string_lossy().into_owned()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
