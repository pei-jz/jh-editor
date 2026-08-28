/**
 * Icons.js — the app's icon set, as inline SVG.
 *
 * The UI used emoji as icons. That looks fine on the machine it was written on
 * and nowhere else: emoji are rendered by a font the OS supplies, so 📁 is flat
 * and grey on one Windows build, glossy and blue on another, and a different
 * shape again on macOS. They do not take `currentColor`, so every one of them
 * ignored the eleven themes — a 🌿 stayed green on the ink-brush theme and a ✅
 * stayed lime on paper. They also carry their own baseline and advance width,
 * which is why icon buttons never quite lined up.
 *
 * These are drawn instead: one 24×24 grid, `currentColor`, so an icon takes the
 * colour of the text around it and follows the theme for free.
 *
 * Geometry is deliberately uniform — 24×24 viewBox, 2px strokes, round caps and
 * joins — because the existing hand-written SVGs in the Markdown toolbar are
 * built that way and a mixed set reads as a mistake.
 *
 * WHAT IS NOT HERE, on purpose:
 *
 *  - `→` in prose ("Settings → General → Export"). That is punctuation inside a
 *    sentence, not an icon, and an SVG in the middle of a clause would break
 *    the line box.
 *  - `↵` `←` `→` in keyboard hints ("Send ↵", "Alt + ← / → : turn page").
 *    Those name a KEY. Redrawing them would say something different.
 *  - CodeMirror's whitespace and line-ending markers (`□` `→` `↵`). Those stand
 *    for characters in the document and belong to the editor's own rendering.
 */

/** Stroke-drawn icon bodies. Every one is authored on the same 24×24 grid. */
const STROKE = {
    // ── window chrome ────────────────────────────────────────────────
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    minimize: '<line x1="5" y1="12" x2="19" y2="12"/>',
    maximize: '<rect x="4" y="4" width="16" height="16" rx="1"/>',
    restore: '<rect x="8" y="3" width="13" height="13" rx="1"/><path d="M16 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h3"/>',

    // ── app identity / panels ────────────────────────────────────────
    logo: '<path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M15 4v5h5"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
    note: '<path d="M5 3h14a1 1 0 0 1 1 1v13l-4 4H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M20 16h-4v5"/><line x1="8" y1="8" x2="15" y2="8"/><line x1="8" y1="12" x2="13" y2="12"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><line x1="13" y1="15" x2="17" y2="15"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/>',

    // ── search / edit ────────────────────────────────────────────────
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>',
    swap: '<path d="M7 4L3 8l4 4"/><line x1="3" y1="8" x2="16" y2="8"/><path d="M17 20l4-4-4-4"/><line x1="21" y1="16" x2="8" y2="16"/>',
    replace: '<path d="M4 7h11a4 4 0 0 1 0 8h-3"/><path d="M15 12l-3 3 3 3"/><path d="M8 4L4 7l4 3"/>',
    filter: '<path d="M3 4h18l-7 8v7l-4 2v-9z"/>',

    // ── navigation ───────────────────────────────────────────────────
    'arrow-up': '<line x1="12" y1="19" x2="12" y2="5"/><path d="M5 12l7-7 7 7"/>',
    'arrow-down': '<line x1="12" y1="5" x2="12" y2="19"/><path d="M19 12l-7 7-7-7"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    'chevron-up': '<path d="M18 15l-6-6-6 6"/>',
    'chevron-left': '<path d="M15 6l-6 6 6 6"/>',

    // ── files ────────────────────────────────────────────────────────
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'folder-open': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z"/><path d="M3 10h18l-2 8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/>',
    'file-code': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M10 12l-2 2 2 2"/><path d="M14 12l2 2-2 2"/>',
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
    'file-style': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><circle cx="12" cy="15" r="2.5"/>',
    'file-globe': '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
    'file-table': '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="10" x2="9" y2="20"/>',
    'file-binary': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 12h2v5H9zm4 0h2v5h-2z"/>',

    // ── git ──────────────────────────────────────────────────────────
    branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
    commit: '<circle cx="12" cy="12" r="4"/><line x1="1.5" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="22.5" y2="12"/>',
    tag: '<path d="M20.6 13.4L12 4.8V2H4v8h2.8l8.6 8.6a2 2 0 0 0 2.8 0l2.4-2.4a2 2 0 0 0 0-2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    merge: '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 7.5v9"/><path d="M8.5 5H13a2 2 0 0 1 2 2v3"/><path d="M8.5 19H13a2 2 0 0 0 2-2v-3"/>',

    // ── status ───────────────────────────────────────────────────────
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    'x-circle': '<circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    warning: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    plug: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
    coin: '<ellipse cx="12" cy="7" rx="8" ry="3.5"/><path d="M4 7v10c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5V7"/><path d="M4 12c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    lightbulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2h5c0-.8.4-1.5 1-2A6 6 0 0 0 12 2z"/>',
    scroll: '<path d="M6 3h11a2 2 0 0 1 2 2v13a3 3 0 0 0 3 3H7a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2z"/><line x1="8" y1="8" x2="15" y2="8"/><line x1="8" y1="12" x2="13" y2="12"/>',
    export: '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    robot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1.4"/><line x1="1.5" y1="13" x2="4" y2="13"/><line x1="20" y1="13" x2="22.5" y2="13"/><circle cx="9" cy="13.5" r="1.3"/><circle cx="15" cy="13.5" r="1.3"/>',
    tool: '<path d="M14.5 6a4.5 4.5 0 0 0 5.9 5.9L21 21H10.2l-6-6a4.5 4.5 0 0 1 5.9-5.9z"/><line x1="3" y1="21" x2="9" y2="15"/>',
    sparkles: '<path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9z"/>',
    pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    // The palette's own mark: a prompt caret and a line, i.e. "type a command".
    command: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 9.5L10 12l-2.5 2.5"/><line x1="12" y1="15" x2="16.5" y2="15"/>',
};

/** Icons that read better as a filled shape than an outline. */
const FILLED = {
    'caret-down': '<path d="M7 10l5 5 5-5z"/>',
    'caret-right': '<path d="M10 7l5 5-5 5z"/>',
    'triangle-up': '<path d="M12 8l5 8H7z"/>',
    'triangle-down': '<path d="M12 16L7 8h10z"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    'pin-filled': '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
};

/** Names that are the same drawing under another word. */
const ALIAS = {
    'folder-closed': 'folder',
    error: 'x-circle',
    success: 'check-circle',
    diff: 'merge',
    compare: 'swap',
    ai: 'robot',
    generate: 'sparkles',
    delete: 'trash',
    ok: 'check',
};

const FALLBACK = 'dot';

/**
 * An icon as an SVG string, ready for a template literal.
 *
 * @param {string} name  key from the set above
 * @param {{size?:number, cls?:string, label?:string, strokeWidth?:number}} [opts]
 *   `label` gives the icon an accessible name; without one it is marked
 *   `aria-hidden`, which is correct when adjacent text already says what the
 *   control does and wrong when the icon is the only content.
 */
export function icon(name, opts = {}) {
    const { size = 16, cls = '', label = '', strokeWidth = 2 } = opts;
    const key = ALIAS[name] || name;

    const filled = Object.prototype.hasOwnProperty.call(FILLED, key);
    let body = filled ? FILLED[key] : STROKE[key];
    if (!body) {
        // A typo must not blank a button. Draw the fallback and say so once, so
        // it surfaces in development instead of shipping as an invisible gap.
        console.warn(`Icons: unknown icon "${name}"`);
        body = FILLED[FALLBACK];
        return wrap(FILLED[FALLBACK], size, cls, label, strokeWidth, true);
    }
    return wrap(body, size, cls, label, strokeWidth, filled);
}

function wrap(body, size, cls, label, strokeWidth, filled) {
    const paint = filled
        ? 'fill="currentColor" stroke="none"'
        : `fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`;
    const a11y = label
        ? `role="img" aria-label="${String(label).replace(/"/g, '&quot;')}"`
        : 'aria-hidden="true" focusable="false"';
    return `<svg class="jh-icon${cls ? ' ' + cls : ''}" width="${size}" height="${size}"`
        + ` viewBox="0 0 24 24" ${paint} ${a11y}>${body}</svg>`;
}

/**
 * The same icon as a live element, for the many call sites that were assigning
 * to `textContent`. Those cannot take an HTML string, and rewriting each one to
 * `innerHTML` would be trading an emoji for an injection surface.
 */
export function iconEl(name, opts = {}) {
    const tpl = document.createElement('template');
    tpl.innerHTML = icon(name, opts);
    return tpl.content.firstElementChild;
}

/**
 * Replace an element's contents with an icon, keeping any text that follows.
 * `setIcon(btn, 'refresh', { text: 'Refresh Connection' })`
 */
export function setIcon(el, name, opts = {}) {
    if (!el) return el;
    el.replaceChildren();
    el.appendChild(iconEl(name, opts));
    if (opts.text) {
        const span = document.createElement('span');
        span.textContent = opts.text;
        el.appendChild(span);
    }
    return el;
}

/** Icon name for a file, chosen from its extension. */
export function iconForFile(name, isDirectory = false, expanded = false) {
    if (isDirectory) return expanded ? 'folder-open' : 'folder';
    const ext = String(name || '').split('.').pop().toLowerCase();
    switch (ext) {
        case 'js': case 'jsx': case 'ts': case 'tsx': case 'mjs': case 'cjs':
            return 'file-code';
        case 'md': case 'markdown': return 'file-text';
        case 'css': case 'scss': case 'less': return 'file-style';
        case 'html': case 'htm': case 'xml': case 'jsp': return 'file-globe';
        case 'rs': case 'go': case 'java': case 'c': case 'cpp': case 'h':
            return 'file-code';
        case 'py': case 'rb': case 'sh': case 'ps1': return 'file-code';
        case 'csv': case 'tsv': case 'xlsx': return 'file-table';
        case 'json': case 'yaml': case 'yml': case 'toml': return 'file-binary';
        default: return 'file';
    }
}

/**
 * Hydrate `data-icon="name"` markup in static HTML.
 *
 * index.html declares which icon a control wants and this puts the drawing in,
 * so the icon set stays defined in exactly one place instead of being pasted
 * into the markup as raw path data.
 *
 * The usual objection to hydrating icons — a flash of missing content before
 * the script runs — cannot happen here: the window is created with
 * `visible: false` and only shown once boot finishes, so nothing is on screen
 * to flash. Icons are inserted BEFORE existing children, so a control that
 * also has a label keeps it.
 *
 * `data-icon-size` overrides the default 16px.
 * Idempotent, so it is safe to call again after re-rendering a region.
 */
export function applyIcons(root = document) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('[data-icon]').forEach((el) => {
        if (el.querySelector(':scope > svg.jh-icon')) return;
        const name = el.getAttribute('data-icon');
        if (!name) return;
        const size = parseInt(el.getAttribute('data-icon-size') || '16', 10);
        el.insertBefore(iconEl(name, { size }), el.firstChild);
    });
}

/** Every icon name, for tests and for the icon audit. */
export function iconNames() {
    return [...Object.keys(STROKE), ...Object.keys(FILLED), ...Object.keys(ALIAS)].sort();
}

export default { icon, iconEl, setIcon, iconForFile, applyIcons, iconNames };
