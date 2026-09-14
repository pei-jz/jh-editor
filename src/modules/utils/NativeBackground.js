/**
 * NativeBackground.js — paint the native window in the theme's colour.
 *
 * WebView2 fills any area it has no rendered frame for with its own default
 * background, which is white. That shows whenever the page has to be
 * repainted from scratch — most visibly on returning to the app after another
 * window covered it, where a large document can take a noticeable moment —
 * and on a dark theme it is a white flash across the whole editor.
 *
 * Giving the window and webview the theme's background means that gap, when
 * it happens, is the colour the page is about to be anyway.
 */

/**
 * Parse a computed CSS colour ("rgb(r, g, b)" / "rgba(r, g, b, a)") into the
 * opaque [r, g, b, 255] tuple Tauri takes. WebView2 only accepts fully opaque
 * or fully transparent, and transparent would bring the white back, so alpha
 * is dropped. Returns null for anything unparseable.
 */
export function parseCssColor(value) {
    const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?/i.exec(String(value || '').trim());
    if (!m) return null;
    // Fully transparent is how a computed style says "no colour" (a body with
    // no background reads rgba(0, 0, 0, 0)); forcing it opaque would paint the
    // window black.
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    const rgb = [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)));
    return [...rgb, 255];
}

/** Match the native window/webview background to <body>'s current colour. */
export async function syncNativeBackground() {
    if (typeof document === 'undefined' || !document.body) return;
    const color = parseCssColor(getComputedStyle(document.body).backgroundColor);
    if (!color) return;
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setBackgroundColor(color);
    } catch (_) { /* not running under Tauri, or not permitted */ }
    try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        await getCurrentWebview().setBackgroundColor(color);
    } catch (_) { /* same */ }
}
