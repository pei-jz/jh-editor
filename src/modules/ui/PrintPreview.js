/**
 * PrintPreview.js — Ctrl+P: see the document as it will print, then print it.
 *
 * The preview is an iframe holding exactly the document that gets printed —
 * not a picture of it — so what the pane shows and what the printer receives
 * cannot drift apart. "Print…" calls that iframe's own print(), which opens
 * WebView2's print dialog with its page-by-page preview, printer choice and
 * "Save as PDF".
 *
 * The one choice offered here is the colours:
 *
 *   keep theme   the iframe's <body> carries the app's theme class, so the page
 *                is the editor's own palette, background included. Chromium
 *                drops backgrounds when printing unless told otherwise, hence
 *                `print-color-adjust: exact`.
 *   white        no theme class: the bare `:root` palette, which is the Light
 *                theme — dark text on white, syntax colours still on.
 *
 * Page margins are zero and the padding lives on <body> with
 * `box-decoration-break: clone`. A real @page margin is never painted by the
 * document's background, so a dark theme would print as a dark sheet inside a
 * white frame; cloning the padding repeats it at the top and bottom of every
 * page instead.
 *
 * What gets printed comes from the view:
 *   - a view with getPrintContent() supplies its own HTML (MarkdownView: the
 *     rendered document, with math and diagrams materialised by prepare());
 *   - anything holding text prints that text, highlighted with the editor's
 *     own parsers, optionally with line numbers. CodeMirror only keeps the
 *     visible lines in the DOM, so printing the editor element itself would
 *     give one screenful.
 */

import { t } from '../utils/I18n.js';
import { highlightCode, escapeHtml } from '../utils/CMHighlighter.js';
import { themeClasses, LEGACY_DARK_CLASS } from '../utils/Themes.js';
import { installModalKeys, focusModal } from './ModalKeys.js';
import { Toast } from './Toast.js';

const PREF_KEEP_THEME = 'print_keepTheme';
const PREF_LINE_NUMBERS = 'print_lineNumbers';
const PREF_SCALE = 'print_scale';

/** Text sizes offered, in percent. Below 50 even 9pt code is unreadable. */
export const SCALES = [50, 60, 70, 80, 90, 100, 110, 125, 150];

/** A stored or requested scale, snapped to the nearest offered one. */
export function clampScale(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 100;
    return SCALES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), SCALES[0]);
}

/** The offered scale `steps` away from `current`, stopping at either end. */
export function stepScale(current, steps) {
    const i = SCALES.indexOf(clampScale(current));
    return SCALES[Math.max(0, Math.min(SCALES.length - 1, i + steps))];
}

/** Past this, a file prints as plain text: parsing it would stall the UI. */
const HIGHLIGHT_LIMIT = 1024 * 1024;

/** The preview that is open, if any — Ctrl+P while it is up prints it. */
let _open = null;

function readPref(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v === 'true';
    } catch (_) {
        return fallback;
    }
}

function writePref(key, value) {
    try { localStorage.setItem(key, value ? 'true' : 'false'); } catch (_) { /* private mode */ }
}

/**
 * Split highlighter output into one HTML string per source line.
 *
 * The highlighter's spans never nest, but a token can run across a newline —
 * a block comment, a template string. Such a span is closed at the end of the
 * line and reopened on the next, so every line stands alone and can be wrapped
 * in its own row.
 *
 * @param {string} html  output of highlightCode()
 * @returns {string[]}
 */
export function splitHighlightedLines(html) {
    const lines = [];
    let line = '';
    let openTag = null;
    const re = /(<span [^>]*>)|(<\/span>)|([^<]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (m[1]) {
            openTag = m[1];
            line += m[1];
        } else if (m[2]) {
            openTag = null;
            line += m[2];
        } else {
            const parts = m[3].split('\n');
            for (let i = 0; i < parts.length; i++) {
                if (i > 0) {
                    if (openTag) line += '</span>';
                    lines.push(line);
                    line = openTag || '';
                }
                line += parts[i];
            }
        }
    }
    lines.push(line);
    // A span reopened for a line and then closed with nothing in it.
    return lines.map((l) => l.replace(/<span [^>]*><\/span>/g, ''));
}

/**
 * The code sheet: one row per line, so a wrapped line keeps its number beside
 * its first row instead of pushing every later number out of step.
 */
export function codeToHtml(text, ext, { lineNumbers = true } = {}) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const html = src.length > HIGHLIGHT_LIMIT ? escapeHtml(src) : highlightCode(src, ext);
    const lines = splitHighlightedLines(html);
    // A trailing newline is the end of the last line, not a line of its own.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const width = String(lines.length).length;
    const rows = lines.map((l, i) => {
        const num = lineNumbers ? `<span class="pp-ln">${i + 1}</span>` : '';
        // A single space keeps an empty line one line tall.
        return `<div class="pp-line">${num}<span class="pp-lc">${l || ' '}</span></div>`;
    }).join('');
    return `<div class="pp-code${lineNumbers ? ' pp-with-ln' : ''}" style="--pp-ln-width:${width}ch">${rows}</div>`;
}

function fileTitle(file) {
    const name = file && (file.name || file.path);
    return name ? String(name).split(/[\\/]/).pop() : t('Untitled');
}

function fileExt(file) {
    const name = fileTitle(file);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * What the current view would print, or null when it holds nothing printable
 * (an image, an Office file, an empty pane).
 *
 * @returns {null | { title: string, kind: 'html'|'code', html?: string,
 *   text?: string, ext?: string, prepare?: (doc: Document) => Promise<void> }}
 */
export function printSourceFor(view, file) {
    if (view && typeof view.getPrintContent === 'function') {
        const content = view.getPrintContent();
        if (content) return { title: fileTitle(file), ...content, kind: 'html' };
    }
    let text = null;
    const cm = view && view.editorView;
    if (cm && cm.state && cm.state.doc) text = cm.state.doc.toString();
    else if (file && typeof file.content === 'string') text = file.content;
    if (text === null) return null;
    return { title: fileTitle(file), kind: 'code', text, ext: fileExt(file) };
}

/** The theme classes the app's <body> has right now. */
function currentThemeClasses() {
    const known = themeClasses().concat(LEGACY_DARK_CLASS);
    return known.filter((c) => document.body.classList.contains(c));
}

const SHEET_CSS = `
  @page { margin: 0; }
  /* The app's body is a 100vh × 100vw, overflow:hidden shell. Printed like
     that, a document stops after its first page — and 100vw counts the
     preview's scrollbar, so every line ran 10px past the sheet. */
  html, body {
    height: auto !important; min-height: 0 !important;
    width: auto !important; max-width: none !important;
    overflow: visible !important; display: block !important;
    position: static !important;
  }
  html { background: transparent !important; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0;
    padding: 14mm 15mm;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
    background: var(--pp-bg);
    color: var(--pp-fg);
    font-size: 10.5pt;
  }
  body.pp-keep-theme { --pp-bg: var(--bg-color); --pp-fg: var(--text-color); }
  body.pp-white { --pp-bg: #ffffff; --pp-fg: #111111; }

  .md-body { max-width: none; padding: 0; margin: 0; }
  .md-body img { max-width: 100%; }
  pre, blockquote, table, img, svg, .katex-display, .mermaid { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }

  .pp-code {
    font-family: var(--editor-font-family, var(--font-mono, monospace));
    font-size: 9pt;
    line-height: 1.45;
    tab-size: 4;
  }
  .pp-line { display: flex; break-inside: avoid; }
  .pp-ln {
    flex: 0 0 auto;
    width: var(--pp-ln-width);
    padding-right: 1.2em;
    text-align: right;
    color: var(--gutter-color, #888);
    user-select: none;
  }
  .pp-lc { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }

  /* On screen the frame is ONE sheet of A4, and the document is cut into
     pages as columns of the sheet's height: column N sits exactly one page
     width to the right of column N-1, so showing page N is a matter of
     scrolling the frame sideways — nothing to scroll by hand, no scrollbar.
     The sizes are divided by the zoom because they are set inside it; on
     paper they come out at 269mm × 180mm whatever the text size. Print media
     never sees any of this and paginates the ordinary flow. */
  @media screen {
    html, body { width: 210mm !important; height: 297mm !important; }
    /* Only the root clips. A body with overflow of its own becomes the scroll
       container, and the root then reports one page's width. */
    html { overflow: hidden !important; }
    .pp-sheet {
      height: calc(269mm / var(--pp-z, 1));
      column-count: 1;
      column-gap: calc(30mm / var(--pp-z, 1));
      column-fill: auto;
    }
  }
`;

/** A4 in CSS pixels (96 per inch), as the preview frame lays it out. */
const MM = 96 / 25.4;
export const PAGE_W = 210 * MM;
export const PAGE_H = 297 * MM;

/** How many sheets the paginated frame holds. */
export function pageCountOf(scrollWidth) {
    return Math.max(1, Math.ceil((scrollWidth - 1) / PAGE_W));
}

/**
 * The whole printable document as a string.
 *
 * Scripts are switched off inside it. Everything in the body is already
 * sanitised or escaped, and math and diagrams are drawn into it from this
 * window, so nothing in the frame ever needs to run code of its own.
 */
export function buildPrintDocument({ title, body, keepTheme, themeClassList = [], styles = '', scale = 100 }) {
    const bodyClass = (keepTheme ? themeClassList.concat('pp-keep-theme') : ['pp-white']).join(' ');
    return '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">'
        + `<title>${escapeHtml(title)}</title>${styles}<style>${SHEET_CSS}</style>`
        + `</head><body class="${escapeHtml(bodyClass)}">`
        + `<div class="pp-sheet" style="${sheetStyle(scale)}">${body}</div></body></html>`;
}

function sheetStyle(scale) {
    const z = clampScale(scale) / 100;
    return `zoom:${z};--pp-z:${z}`;
}

/**
 * Text size is CSS `zoom` on the sheet inside the page padding, not a smaller
 * font-size: zoom scales everything a document is made of alike — headings,
 * code, tables, KaTeX, Mermaid's SVG — and re-flows it, so 70% puts more on
 * each line and more lines on each page. The paper margins stay the same.
 * It is applied in place, so a change does not re-render diagrams.
 */
function applyScale(doc, scale) {
    const sheet = doc && doc.querySelector('.pp-sheet');
    if (sheet) sheet.setAttribute('style', sheetStyle(scale));
}

function waitForImages(doc) {
    const imgs = Array.from(doc.images || []);
    if (!imgs.length) return Promise.resolve();
    return new Promise((resolve) => {
        let left = imgs.length;
        const done = () => { if (--left <= 0) resolve(); };
        imgs.forEach((img) => {
            if (img.complete) return done();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
        });
        setTimeout(resolve, 3000); // a broken asset must not hold the preview
    });
}

let _styleInjected = false;
function injectStyles() {
    if (_styleInjected) return;
    _styleInjected = true;
    const style = document.createElement('style');
    style.id = 'print-preview-styles';
    style.textContent = `
    .print-preview-overlay {
        position: fixed; inset: 0; z-index: 2147482000;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.42);
    }
    .print-preview {
        display: flex; flex-direction: column;
        width: min(1080px, 94vw); height: 90vh;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color);
        border-radius: var(--radius, 6px);
        box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.35));
        font-family: var(--font-main);
        overflow: hidden;
    }
    .print-preview-head {
        padding: 11px 16px;
        background: var(--bg-color-secondary);
        border-bottom: 1px solid var(--border-color);
        font-weight: 600; font-size: 13px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .print-preview-main { flex: 1; display: flex; min-height: 0; }
    /* The stage shows one whole sheet, scaled to fit, so nothing in the
       preview ever scrolls: pages are turned instead. */
    .print-preview-stage {
        flex: 1; min-width: 0; min-height: 0;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 12px; padding: 18px; overflow: hidden;
        background: var(--sidebar-bg, rgba(127,127,127,0.12));
    }
    .print-preview-page {
        position: relative; flex: 0 0 auto; overflow: hidden;
        border-radius: 2px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.18), 0 6px 22px rgba(0,0,0,0.22);
    }
    /* The frame is laid out at true A4 and scaled down as a picture, so line
       and page breaks are those of the paper whatever the window size. It
       takes no pointer input: the wheel over it turns pages. */
    .print-preview-frame {
        position: absolute; left: 0; top: 0;
        width: ${PAGE_W}px; height: ${PAGE_H}px;
        border: 0; transform-origin: 0 0;
        pointer-events: none;
    }
    .print-preview-nav { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
    .print-preview-pageno {
        min-width: 64px; text-align: center;
        font-size: 12px; font-variant-numeric: tabular-nums;
        color: var(--text-color);
    }

    .print-preview-side {
        width: 250px; flex: 0 0 auto;
        display: flex; flex-direction: column; gap: 18px;
        padding: 16px; border-left: 1px solid var(--border-color);
        font-size: 13px; overflow: hidden;
    }
    .print-preview-side fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; min-width: 0; }
    .print-preview-side legend {
        padding: 0; margin-bottom: 8px;
        font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
        opacity: 0.7;
    }
    .print-preview-side label { display: flex; gap: 8px; align-items: center; cursor: pointer; line-height: 1.4; }
    .print-preview-side input[type="radio"],
    .print-preview-side input[type="checkbox"] {
        margin: 0; width: 15px; height: 15px; flex: 0 0 auto;
        accent-color: var(--primary-color);
        cursor: pointer;
    }

    /* Buttons drawn from the theme, like Dialog.js's — the native grey ones
       ignored every palette. */
    .pp-btn {
        height: 30px; padding: 0 14px;
        font: inherit; font-size: 12.5px;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 4px;
        cursor: pointer;
    }
    .pp-btn:hover:not(:disabled) { background: var(--hover-color); }
    .pp-btn:focus-visible, .pp-btn:focus { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    .pp-btn:disabled { opacity: 0.4; cursor: default; }
    .pp-btn.primary {
        background: var(--primary-color); border-color: var(--primary-color);
        color: var(--text-on-primary, var(--active-tab-bg, #fff));
        font-weight: 600;
    }
    .pp-btn.primary:hover:not(:disabled) { background: var(--primary-color); filter: brightness(1.1); }
    .pp-icon-btn { width: 30px; padding: 0; font-size: 15px; line-height: 1; }

    /* − 80% + as one segmented control. */
    .print-preview-scale {
        display: flex; align-items: stretch; align-self: flex-start;
        border: 1px solid var(--border-color); border-radius: 4px;
        overflow: hidden;
    }
    .print-preview-scale .pp-btn { border: 0; border-radius: 0; height: 28px; }
    .print-preview-scale .pp-btn:focus, .print-preview-scale .pp-btn:focus-visible { outline-offset: -2px; }
    .print-preview-scale .pp-scale-value {
        width: 64px; padding: 0;
        border-left: 1px solid var(--border-color); border-right: 1px solid var(--border-color);
        font-variant-numeric: tabular-nums;
    }

    .print-preview-note { font-size: 12px; line-height: 1.5; opacity: 0.65; }
    .print-preview-actions { margin-top: auto; display: flex; gap: 8px; justify-content: flex-end; }
    @media (max-width: 720px) {
        .print-preview-main { flex-direction: column; }
        .print-preview-side { width: auto; border-left: 0; border-top: 1px solid var(--border-color); }
    }
    `;
    document.head.appendChild(style);
}

/**
 * Open the preview for a view and its file.
 * @returns {boolean} false when there was nothing to print.
 */
export function showPrintPreview({ view, file } = {}) {
    if (_open) { _open.print(); return true; }

    const source = printSourceFor(view, file);
    if (!source) {
        Toast.info(t('This view has nothing to print'));
        return false;
    }

    injectStyles();
    let keepTheme = readPref(PREF_KEEP_THEME, true);
    let lineNumbers = readPref(PREF_LINE_NUMBERS, true);
    let scale = 100;
    try { scale = clampScale(localStorage.getItem(PREF_SCALE) || 100); } catch (_) { /* private mode */ }
    const isCode = source.kind === 'code';

    const overlay = document.createElement('div');
    // `app-dialog-overlay` is what ShortcutManager looks for to stand aside:
    // without it Ctrl+S and friends would act on the editor behind the preview.
    overlay.className = 'app-dialog-overlay print-preview-overlay';
    const box = document.createElement('div');
    box.className = 'print-preview';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', t('Print Preview'));

    const head = document.createElement('div');
    head.className = 'print-preview-head';
    head.textContent = `${t('Print Preview')} — ${source.title}`;

    const main = document.createElement('div');
    main.className = 'print-preview-main';
    const stage = document.createElement('div');
    stage.className = 'print-preview-stage';
    const page = document.createElement('div');
    page.className = 'print-preview-page';
    const frame = document.createElement('iframe');
    frame.className = 'print-preview-frame';
    frame.title = t('Print Preview');
    frame.tabIndex = -1;
    page.appendChild(frame);

    const button = (label, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `pp-btn ${cls}`.trim();
        b.textContent = label;
        return b;
    };
    const nav = document.createElement('div');
    nav.className = 'print-preview-nav';
    const prevBtn = button('‹', 'pp-icon-btn');
    prevBtn.title = `${t('Previous page')} (PageUp)`;
    const pageNo = document.createElement('span');
    pageNo.className = 'print-preview-pageno';
    pageNo.setAttribute('aria-live', 'polite');
    const nextBtn = button('›', 'pp-icon-btn');
    nextBtn.title = `${t('Next page')} (PageDown)`;
    nav.append(prevBtn, pageNo, nextBtn);
    stage.append(page, nav);

    const side = document.createElement('div');
    side.className = 'print-preview-side';

    const colours = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = t('Colours');
    colours.appendChild(legend);
    const radio = (value, label, checked) => {
        const l = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'print-colours';
        input.value = value;
        input.checked = checked;
        const span = document.createElement('span');
        span.textContent = label;
        l.append(input, span);
        colours.appendChild(l);
        return input;
    };
    const keepInput = radio('theme', t('Keep the theme colours'), keepTheme);
    const whiteInput = radio('white', t('White background (saves ink)'), !keepTheme);
    side.appendChild(colours);

    const size = document.createElement('fieldset');
    const sizeLegend = document.createElement('legend');
    sizeLegend.textContent = t('Text size');
    const sizeRow = document.createElement('div');
    sizeRow.className = 'print-preview-scale';
    const smallerBtn = button('−', 'pp-icon-btn');
    smallerBtn.title = `${t('Zoom out')} (Ctrl+-)`;
    // The value itself is a button: clicking it goes back to 100%.
    const scaleValue = button('100%', 'pp-scale-value');
    scaleValue.title = `${t('Reset to 100%')} (Ctrl+0)`;
    const largerBtn = button('+', 'pp-icon-btn');
    largerBtn.title = `${t('Zoom in')} (Ctrl+=)`;
    sizeRow.append(smallerBtn, scaleValue, largerBtn);
    size.append(sizeLegend, sizeRow);
    side.appendChild(size);

    let lnInput = null;
    if (isCode) {
        const opts = document.createElement('fieldset');
        const lg = document.createElement('legend');
        lg.textContent = t('Options');
        const l = document.createElement('label');
        lnInput = document.createElement('input');
        lnInput.type = 'checkbox';
        lnInput.checked = lineNumbers;
        const span = document.createElement('span');
        span.textContent = t('Line numbers');
        l.append(lnInput, span);
        opts.append(lg, l);
        side.appendChild(opts);
    }

    const note = document.createElement('div');
    note.className = 'print-preview-note';
    note.textContent = t('Paper size, margins and "Save as PDF" are chosen in the next dialog.');
    side.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'print-preview-actions';
    const cancelBtn = button(t('Cancel'));
    const printBtn = button(t('Print…'), 'primary');
    actions.append(cancelBtn, printBtn);
    side.appendChild(actions);

    main.append(stage, side);
    box.append(head, main);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
        .filter((el) => el.id !== 'print-preview-styles')
        .map((el) => el.outerHTML).join('\n');
    const themeClassList = currentThemeClasses();

    // Each option change rewrites the frame. Mermaid and math render
    // asynchronously, so an older render that finishes late must not print
    // into the newer document.
    let generation = 0;
    let ready = Promise.resolve();

    // ── pages ──────────────────────────────────────────────────────────
    let pageIndex = 0;
    let pageCount = 1;
    const showPage = (i) => {
        pageIndex = Math.max(0, Math.min(pageCount - 1, i));
        const root = frame.contentDocument && frame.contentDocument.documentElement;
        if (root) root.scrollLeft = Math.round(pageIndex * PAGE_W);
        pageNo.textContent = `${pageIndex + 1} / ${pageCount}`;
        prevBtn.disabled = pageIndex === 0;
        nextBtn.disabled = pageIndex >= pageCount - 1;
    };
    // Layout moves under anything that changes the document — a re-render,
    // a text size, a diagram or a web font arriving late — so the page count
    // is re-read after each, and the page shown kept where it still exists.
    const updatePages = () => {
        const root = frame.contentDocument && frame.contentDocument.documentElement;
        pageCount = root ? pageCountOf(root.scrollWidth) : 1;
        showPage(pageIndex);
    };
    const fit = () => {
        const w = stage.clientWidth - 36;
        const h = stage.clientHeight - 36 - nav.offsetHeight - 12;
        if (w <= 0 || h <= 0) return;
        const s = Math.min(w / PAGE_W, h / PAGE_H);
        page.style.width = `${Math.floor(PAGE_W * s)}px`;
        page.style.height = `${Math.floor(PAGE_H * s)}px`;
        frame.style.transform = `scale(${s})`;
    };
    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(stage);
    }

    // One notch, one page; a trackpad's stream of small deltas is collected
    // until it amounts to a notch, then held off briefly so a flick does not
    // run through the whole document.
    let wheelAcc = 0;
    let wheelHold = 0;
    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const now = Date.now();
        if (now < wheelHold) return;
        wheelAcc += e.deltaY || e.deltaX;
        if (Math.abs(wheelAcc) < 40) return;
        showPage(pageIndex + (wheelAcc > 0 ? 1 : -1));
        wheelAcc = 0;
        wheelHold = now + 180;
    }, { passive: false });

    const render = () => {
        const gen = ++generation;
        const body = isCode
            ? codeToHtml(source.text, source.ext, { lineNumbers })
            : source.html;
        const doc = frame.contentDocument;
        doc.open();
        doc.write(buildPrintDocument({ title: source.title, body, keepTheme, themeClassList, styles, scale }));
        doc.close();
        updatePages();
        ready = (async () => {
            if (source.prepare) {
                try { await source.prepare(doc); } catch (e) { console.warn('print prepare failed', e); }
            }
            if (gen === generation) await waitForImages(doc);
            if (gen === generation && doc.fonts && doc.fonts.ready) {
                try { await doc.fonts.ready; } catch (_) { /* layout as it stands */ }
            }
            if (gen === generation) updatePages();
        })();
    };

    let disposeKeys = null;
    const close = () => {
        if (!_open) return;
        _open = null;
        if (disposeKeys) disposeKeys();
        document.removeEventListener('keydown', onKey, true);
        if (resizeObserver) resizeObserver.disconnect();
        overlay.remove();
    };

    const print = async () => {
        printBtn.disabled = true;
        try {
            await ready;
            const win = frame.contentWindow;
            if (!win) return;
            // The frame must outlive the system dialog: removing it while that
            // dialog is up cancels the job. Close once printing is over.
            win.addEventListener('afterprint', () => setTimeout(close, 0), { once: true });
            win.focus();
            win.print();
        } catch (e) {
            console.error('print failed', e);
            Toast.error(t('Printing failed'));
        } finally {
            printBtn.disabled = false;
        }
    };

    const setScale = (next) => {
        scale = clampScale(next);
        scaleValue.textContent = `${scale}%`;
        smallerBtn.disabled = scale === SCALES[0];
        largerBtn.disabled = scale === SCALES[SCALES.length - 1];
        try { localStorage.setItem(PREF_SCALE, String(scale)); } catch (_) { /* private mode */ }
        applyScale(frame.contentDocument, scale);
        updatePages();
    };

    // Ctrl+P inside the preview prints rather than reopening it, and Ctrl+- /
    // Ctrl+= / Ctrl+0 size the text. None of them may reach WebView2: its own
    // Ctrl+P prints the whole application window, and its Ctrl+- zooms it.
    // PageUp / PageDown turn the page.
    const onKey = (e) => {
        if ((e.key === 'PageDown' || e.key === 'PageUp') && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            showPage(pageIndex + (e.key === 'PageDown' ? 1 : -1));
            return;
        }
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const k = e.key.toLowerCase();
        let act = null;
        if (k === 'p' && !e.shiftKey) act = print;
        else if (k === '-' || k === '_') act = () => setScale(stepScale(scale, -1));
        else if (k === '=' || k === '+') act = () => setScale(stepScale(scale, 1));
        else if (k === '0') act = () => setScale(100);
        if (!act) return;
        e.preventDefault();
        e.stopPropagation();
        act();
    };

    keepInput.addEventListener('change', () => { keepTheme = true; writePref(PREF_KEEP_THEME, true); render(); });
    whiteInput.addEventListener('change', () => { keepTheme = false; writePref(PREF_KEEP_THEME, false); render(); });
    if (lnInput) {
        lnInput.addEventListener('change', () => {
            lineNumbers = lnInput.checked;
            writePref(PREF_LINE_NUMBERS, lineNumbers);
            render();
        });
    }
    smallerBtn.addEventListener('click', () => setScale(stepScale(scale, -1)));
    largerBtn.addEventListener('click', () => setScale(stepScale(scale, 1)));
    scaleValue.addEventListener('click', () => setScale(100));
    prevBtn.addEventListener('click', () => showPage(pageIndex - 1));
    nextBtn.addEventListener('click', () => showPage(pageIndex + 1));
    cancelBtn.addEventListener('click', close);
    printBtn.addEventListener('click', print);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    _open = { print, close };
    disposeKeys = installModalKeys(box, { onCancel: close, onDefault: print });
    document.addEventListener('keydown', onKey, true);

    render();
    setScale(scale);
    fit();
    focusModal(box, printBtn);
    return true;
}

/** Close an open preview. For tests and for callers tearing the UI down. */
export function closePrintPreview() {
    if (_open) _open.close();
}

export default { show: showPrintPreview, close: closePrintPreview };
