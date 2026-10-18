/**
 * The key that fills the window with a dialog, and puts it back.
 *
 * Ctrl+Alt+F has done this in the block editor and the Mermaid helper, but it
 * is three keys and nothing suggests it. F11 is what "full screen" means
 * everywhere else, so it does the same here.
 *
 * Both keys are checked on `e.code` too. Holding Alt changes the reported
 * character on several layouts (Ctrl+Alt is AltGr on some Windows keyboards),
 * and WebView2 on some Japanese setups reports the function keys as
 * 'Unidentified' — keyCode 122 is F11 whatever e.key says.
 */
export function isFullScreenKey(e) {
    if (!e) return false;
    const isF11 = e.key === 'F11' || e.code === 'F11' || e.keyCode === 122;
    if (isF11 && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return true;
    return !!e.altKey && !!(e.ctrlKey || e.metaKey)
        && (e.code === 'KeyF' || String(e.key).toLowerCase() === 'f');
}
