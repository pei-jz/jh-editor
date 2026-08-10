import { convertFileSrc } from '@tauri-apps/api/core';
import * as FS from './FileSystem.js';
import { State } from '../core/Store.js';

/**
 * MarkdownAssets.js — the "rich" half of Markdown: pasted images, math and
 * wiki-links.
 *
 * IMAGES: a Markdown file stays plain text. A pasted image is written next to
 * the document as a real file and referenced with a relative link — the same
 * convention Obsidian/Typora use:
 *
 *     ![clip-20260806-153012](assets/clip-20260806-153012.png)
 *
 * (The alternative, a base64 `data:` URI inline, keeps everything in one file
 * but multiplies its size, destroys `git diff`, and many renderers choke on it.
 * It is offered only as an opt-in.)
 */

const ASSET_DIR_KEY = 'settings_mdAssetDir';
const EMBED_KEY = 'settings_mdEmbedImages';

export function getAssetDirName() {
    return localStorage.getItem(ASSET_DIR_KEY) || 'assets';
}

export function setAssetDirName(name) {
    localStorage.setItem(ASSET_DIR_KEY, String(name || 'assets').replace(/[\\/:*?"<>|]/g, ''));
}

/** When true, images are inlined as data: URIs instead of written to disk. */
export function isEmbedMode() {
    return localStorage.getItem(EMBED_KEY) === 'true';
}

export function setEmbedMode(on) {
    localStorage.setItem(EMBED_KEY, on ? 'true' : 'false');
}

function _timestampName(ext) {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `clip-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
        + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

function _extFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('gif')) return 'gif';
    if (m.includes('webp')) return 'webp';
    if (m.includes('svg')) return 'svg';
    return 'png';
}

/**
 * Persist a pasted/dropped image and return the Markdown to insert.
 *
 * @param {Blob} blob      the image
 * @param {string|null} docPath  path of the .md being edited (null = untitled)
 * @returns {Promise<string>} markdown snippet, e.g. `![name](assets/name.png)`
 */
export async function saveImageForDocument(blob, docPath) {
    const ext = _extFromMime(blob.type);
    const buf = new Uint8Array(await blob.arrayBuffer());

    // Untitled documents have nowhere to put a sibling folder, and embed mode is
    // an explicit user choice → inline the bytes instead.
    if (isEmbedMode() || !docPath) {
        const b64 = _toBase64(buf);
        return `![image](data:${blob.type || 'image/png'};base64,${b64})`;
    }

    const fileName = _timestampName(ext);
    const dir = FS.getParentDir(docPath);
    const assetDir = getAssetDirName();
    const target = `${dir}/${assetDir}/${fileName}`.replace(/\\/g, '/');

    await FS.writeFileBytes(target, buf);
    // Relative link so the document stays portable if the folder is moved.
    return `![${fileName.replace(/\.\w+$/, '')}](${assetDir}/${fileName})`;
}

function _toBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000; // avoid "too many arguments" on large images
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/** Pull an image out of a paste/drop event, or null when there isn't one. */
export function extractImageBlob(e) {
    const dt = e.clipboardData || e.dataTransfer;
    if (!dt) return null;
    const items = dt.items ? Array.from(dt.items) : [];
    for (const it of items) {
        if (it.kind === 'file' && String(it.type || '').startsWith('image/')) {
            const f = it.getAsFile();
            if (f) return f;
        }
    }
    const files = dt.files ? Array.from(dt.files) : [];
    for (const f of files) {
        if (String(f.type || '').startsWith('image/')) return f;
    }
    return null;
}

// ── Rendering support ────────────────────────────────────────────────────────

/**
 * Rewrite a relative image src so the webview can actually load it.
 * Tauri blocks plain `file://`; `convertFileSrc` maps it to the asset protocol.
 */
export function resolveImageSrc(src, docPath) {
    const s = String(src || '');
    if (!s || /^(https?:|data:|asset:|blob:)/i.test(s)) return s;
    let abs = s.replace(/\\/g, '/');
    if (!/^([a-zA-Z]:\/|\/)/.test(abs)) {
        const base = docPath ? FS.getParentDir(docPath) : (State.currentDir || '.');
        abs = `${base}/${abs}`.replace(/\\/g, '/');
    }
    try {
        return convertFileSrc(abs);
    } catch (_) {
        return s;
    }
}

// ── Wiki links ───────────────────────────────────────────────────────────────

// [[Note]] or [[Note|shown text]] — Obsidian-style. Escaped \[[ is ignored.
const WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;

/**
 * Convert [[wiki links]] to normal Markdown links BEFORE marked runs, so the
 * existing link renderer (and its data-file-link click handling) applies.
 */
export function expandWikiLinks(text) {
    if (!text || text.indexOf('[[') === -1) return text;
    return text.replace(WIKILINK_RE, (m, target, label) => {
        const t = String(target).trim();
        const shown = (label || t).trim();
        const href = /\.[a-z0-9]+$/i.test(t) ? t : `${t}.md`;
        return `[${shown}](${href})`;
    });
}

/** All wiki-link targets in a document (normalised to file names). */
export function extractWikiLinks(text) {
    const out = [];
    if (!text) return out;
    WIKILINK_RE.lastIndex = 0;
    let m;
    while ((m = WIKILINK_RE.exec(text)) !== null) {
        const t = String(m[1]).trim();
        if (t) out.push(/\.[a-z0-9]+$/i.test(t) ? t : `${t}.md`);
    }
    return out;
}

// ── Math (KaTeX) ─────────────────────────────────────────────────────────────

let _katex = null;
let _katexLoading = null;

/** Lazily pull in KaTeX — it's sizable and most documents have no math. */
export async function ensureKatex() {
    if (_katex) return _katex;
    if (!_katexLoading) {
        _katexLoading = (async () => {
            const mod = await import('katex');
            await import('katex/dist/katex.min.css');
            _katex = mod.default || mod;
            return _katex;
        })();
    }
    return _katexLoading;
}

export function hasMath(text) {
    return !!text && (/\$\$[\s\S]+?\$\$/.test(text) || /(^|[^\\$])\$[^$\n]+\$/.test(text));
}

/**
 * Render $inline$ and $$display$$ math inside an already-rendered container.
 * Walks text nodes only, so it can't disturb the surrounding HTML — and skips
 * code/pre, where `$` is just a dollar sign.
 */
export async function renderMath(container) {
    if (!container) return;
    const katex = await ensureKatex().catch(() => null);
    if (!katex) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
            if (node.parentElement && node.parentElement.closest('code, pre, .katex, .mermaid')) {
                return NodeFilter.FILTER_REJECT;
            }
            return /\$/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);

    // $$…$$ first so a display block isn't chopped up by the inline pattern.
    const RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
    for (const node of targets) {
        const text = node.nodeValue;
        RE.lastIndex = 0;
        if (!RE.test(text)) continue;
        RE.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let last = 0, m;
        while ((m = RE.exec(text)) !== null) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const display = m[1] !== undefined;
            const src = (display ? m[1] : m[2]) || '';
            const span = document.createElement('span');
            try {
                katex.render(src, span, { displayMode: display, throwOnError: false });
            } catch (_) {
                span.textContent = m[0]; // leave the raw text on failure
            }
            frag.appendChild(span);
            last = m.index + m[0].length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }
}
