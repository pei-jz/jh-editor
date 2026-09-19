import { t } from '../utils/I18n.js';

/**
 * LoadingOverlay.js — "this is taking a moment", said out loud.
 *
 * Opening a large file reads it, sniffs its encoding, decodes it and ships the
 * whole string across the IPC boundary. On a few hundred megabytes that is
 * seconds, and the editor showed nothing at all for the whole of it: the last
 * file still on screen, no caret movement, no sign anything was happening —
 * then the new text, all at once. That reads as a hang, and a hang is what
 * people report.
 *
 * The work itself is not on the UI thread (the read is a Tauri command, so it
 * runs on a worker), which is why a panel put up here really does animate
 * rather than freezing mid-spin. Nothing was showing one, that was all.
 *
 * Deliberately NOT a percentage. The time is split between a read, an encoding
 * detection pass over every byte, a decode, and a JSON hop across the IPC
 * boundary, and only the first of those could report progress without being
 * rebuilt. A bar that claims to know how far along it is and then sits at 40%
 * for four seconds is a worse answer than one that just says it is working. The
 * file's name and size are shown instead, which is the part the user can
 * actually act on ("right, it's the 900 MB one").
 */

/**
 * Nothing appears before this. Most files open in a few milliseconds and a
 * panel that flashes up and vanishes on every single open is worse than no
 * panel: it draws the eye to a thing that is already finished.
 */
const DEFAULT_DELAY_MS = 180;

let depth = 0;          // opens in flight; the last one out turns the light off
let showTimer = null;
let node = null;
/** The latest text, held so an update that arrives before the panel is not lost. */
const current = { title: '', detail: '' };

const isVisible = () => !!node && node.classList.contains('visible');

/**
 * The pane the file is opening into. Its tab bar is measured rather than
 * assumed: the left pane's is styled in layout.css and the right pane's inline
 * in index.html, so a hardcoded offset would be right in one pane and wrong in
 * the other the day either changes.
 */
function mount() {
    const pane = document.querySelector('.editor-pane.active')
        || document.getElementById('editor-container');
    if (!pane) return null;
    // .editor-pane carries no `position` of its own; the panel is placed
    // against it, so give it one.
    if (getComputedStyle(pane).position === 'static') pane.style.position = 'relative';
    return pane;
}

/** Build the panel once and keep it; opening files is a repeated act. */
function ensureNode() {
    if (!node) {
        node = document.createElement('div');
        node.className = 'file-loading';
        // A status region, not an alert: it must not steal focus, and a screen
        // reader should mention it rather than interrupt for it.
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        node.innerHTML = `
            <div class="file-loading-card">
                <div class="file-loading-title"></div>
                <div class="file-loading-detail"></div>
                <div class="file-loading-bar"><div class="file-loading-fill"></div></div>
            </div>`;
    }
    const pane = mount();
    if (pane && node.parentElement !== pane) pane.appendChild(node);
    if (pane) {
        const bar = pane.querySelector('#tab-bar, #tab-bar-right');
        node.style.top = `${(bar ? bar.offsetHeight : 35) + 12}px`;
    }
    return node;
}

function paint(title, detail) {
    const el = ensureNode();
    el.querySelector('.file-loading-title').textContent = title;
    el.querySelector('.file-loading-detail').textContent = detail || '';
}

/** A size a person can read. Bytes below 1 KB are noise here, so they round up. */
export function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = n / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Announce that something slow is under way, under `title` exactly as given.
 * Returns a handle; call `done()` on it exactly once, from a `finally`, or the
 * panel stays up for the rest of the session.
 *
 * `update(detail)` moves the panel on to the next phase. It is worth saying
 * which phase because they fail differently: a stall in "Reading" is the disk
 * or the file's size, a stall after it is the editor building the document.
 */
export function beginLoad(title, { detail = '', delayMs = DEFAULT_DELAY_MS } = {}) {
    depth++;
    // What the panel WOULD say, kept whether or not it is on screen yet.
    //
    // update() used to paint only when the panel was already visible and throw
    // the text away otherwise. Almost every update lands in that window: the
    // read starts immediately and the panel waits 180ms, so "Reading 912 MB…"
    // was written before there was anything to write it on, and the panel then
    // came up showing the empty detail it had been born with. The size never
    // appeared — which is the one thing on the panel the reader wanted.
    current.title = title;
    current.detail = detail;

    if (isVisible()) {
        // Already up (a second file in the same batch) — just relabel it.
        paint(current.title, current.detail);
    } else if (showTimer === null) {
        showTimer = setTimeout(() => {
            showTimer = null;
            paint(current.title, current.detail);
            ensureNode().classList.add('visible');
        }, delayMs);
    }

    let finished = false;
    return {
        /** True once the panel is actually on screen. */
        get shown() { return isVisible(); },
        update(nextDetail) {
            if (finished) return;
            current.title = title;
            current.detail = nextDetail;
            if (isVisible()) paint(current.title, current.detail);
        },
        done() {
            if (finished) return;
            finished = true;
            depth = Math.max(0, depth - 1);
            if (depth > 0) return;
            if (showTimer !== null) {
                clearTimeout(showTimer);
                showTimer = null;
            }
            if (node) node.classList.remove('visible');
        },
    };
}

/**
 * The same thing for one file, which is the common case: `name` is a file name
 * and the sentence around it is written here, once, rather than at each call.
 */
export function beginFileLoad(name, options) {
    return beginLoad(t('Opening {name}…', { name: name || '' }), options);
}

/**
 * Wait for the browser to actually put a frame on screen.
 *
 * The phases either side of this are synchronous — the editor builds the whole
 * document in one go — so setting the panel's text and then starting that work
 * in the same task means the text is never drawn. Two frames: the first lets
 * the style change take, the second lands after it has been painted.
 */
export function nextPaint() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}
