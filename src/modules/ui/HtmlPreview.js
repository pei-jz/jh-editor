import { convertFileSrc } from '@tauri-apps/api/core';
import * as FS from '../utils/FileSystem.js';

/**
 * HtmlPreview — render the HTML you are editing, beside the source.
 *
 * Uses a sandboxed <iframe srcdoc>. Relative CSS/images are resolved by
 * injecting a <base> pointing at the document's own folder, mapped through
 * Tauri's asset protocol (a plain file:// URL is blocked in the webview).
 *
 * Scripts are OFF by default: opening a file is not consent to execute the
 * JavaScript inside it. A toggle turns them on when the user actually wants a
 * live page. `allow-same-origin` is only granted together with scripts because
 * the two combined would let the frame out of the sandbox otherwise.
 */

const SCRIPTS_KEY = 'settings_htmlPreviewScripts';

export function scriptsEnabled() {
    return localStorage.getItem(SCRIPTS_KEY) === 'true';
}

export function setScriptsEnabled(on) {
    localStorage.setItem(SCRIPTS_KEY, on ? 'true' : 'false');
}

/** Asset-protocol URL for the folder holding `filePath`, usable as <base href>. */
function baseHrefFor(filePath) {
    if (!filePath) return '';
    try {
        const dir = FS.getParentDir(String(filePath).replace(/\\/g, '/'));
        if (!dir) return '';
        // Trailing slash matters: without it the last segment is treated as a
        // file name and relative paths resolve one level too high.
        return convertFileSrc(dir + '/');
    } catch (_) {
        return '';
    }
}

/**
 * Build the document to hand to the iframe: the user's HTML plus a <base> so
 * its relative assets load. Inserted right after <head> when there is one, so
 * it precedes every <link>/<script>/<img> that might use it.
 */
export function buildPreviewDocument(html, filePath) {
    const src = String(html == null ? '' : html);
    // Relative URLs are rewritten to absolute asset-protocol URLs rather than
    // left to a <base> tag. In a sandboxed srcdoc frame the document's origin is
    // opaque, so <base> resolution is unreliable — rewriting is deterministic
    // and works whether or not `allow-same-origin` is granted.
    const rewritten = rewriteRelativeUrls(src, filePath);
    const base = baseHrefFor(filePath);
    if (!base) return rewritten;
    // Keep <base> as a backstop for URLs built at runtime by scripts.
    const tag = `<base href="${base}">`;
    if (/<head[^>]*>/i.test(rewritten)) {
        return rewritten.replace(/<head[^>]*>/i, (m) => m + tag);
    }
    if (/<html[^>]*>/i.test(rewritten)) {
        return rewritten.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
    }
    return tag + rewritten;
}

/** Absolute asset URL for `url` resolved against the document's folder. */
export function resolveRelative(url, filePath) {
    const u = String(url || '').trim();
    // Leave absolute URLs, data/blob URIs, anchors and non-http schemes alone.
    if (!u || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u)) return u;
    if (!filePath) return u;
    try {
        const dir = FS.getParentDir(String(filePath).replace(/\\/g, '/'));
        // Strip any query/hash before joining, then put it back.
        const m = u.match(/^([^?#]*)([?#].*)?$/);
        const pathPart = m ? m[1] : u;
        const tail = (m && m[2]) || '';
        if (!pathPart) return u;
        const abs = _collapse(pathPart.startsWith('/') ? pathPart : `${dir}/${pathPart}`);
        return convertFileSrc(abs) + tail;
    } catch (_) {
        return u;
    }
}

function _collapse(p) {
    const parts = String(p).replace(/\\/g, '/').split('/');
    const out = [];
    for (const seg of parts) {
        if (seg === '.' || seg === '') { if (out.length === 0) out.push(seg); continue; }
        if (seg === '..') { if (out.length > 1) out.pop(); continue; }
        out.push(seg);
    }
    return out.join('/');
}

/**
 * Rewrite src/href (and srcset) attributes that point at files next to the
 * document, so images, stylesheets and scripts actually load in the preview.
 */
export function rewriteRelativeUrls(html, filePath) {
    if (!filePath || !html) return html;
    // Attribute-level regex rather than a DOM round-trip: re-serialising the
    // document through DOMParser would silently "fix" partial/invalid markup,
    // which is exactly what a live preview of half-typed HTML must not do.
    return String(html).replace(
        /\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi,
        (full, attr, _q, dq, sq) => {
            const val = dq !== undefined ? dq : sq;
            const next = resolveRelative(val, filePath);
            if (next === val) return full;
            return `${attr}="${next.replace(/"/g, '&quot;')}"`;
        },
    );
}

/** The sandbox attribute for the current script setting. */
export function sandboxFor(allowScripts) {
    // `allow-same-origin` is deliberately never combined with `allow-scripts` —
    // together they let the frame reach back out of the sandbox. Relative assets
    // still resolve in both modes because their URLs are rewritten to absolute
    // asset-protocol URLs up front (see rewriteRelativeUrls), rather than
    // depending on the frame's origin.
    return allowScripts ? 'allow-scripts' : 'allow-same-origin';
}

export function createPreviewFrame() {
    const frame = document.createElement('iframe');
    frame.className = 'html-preview-frame';
    frame.setAttribute('sandbox', sandboxFor(scriptsEnabled()));
    frame.style.cssText = 'width:100%; height:100%; border:0; background:#fff;';
    return frame;
}

/** Push new content into an existing preview frame. */
export function updatePreviewFrame(frame, html, filePath) {
    if (!frame) return;
    // The sandbox must be re-applied before the load, not after.
    frame.setAttribute('sandbox', sandboxFor(scriptsEnabled()));
    frame.srcdoc = buildPreviewDocument(html, filePath);
}
