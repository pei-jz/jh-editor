import { invoke } from '@tauri-apps/api/core';
import { t } from '../utils/I18n.js';

/**
 * PdfView — a read-only look at a PDF, drawn by pdf.js.
 *
 * Like the Office preview, the point is not having to leave the editor to see
 * what a file says: a spec beside the code that implements it, a report in the
 * other pane. Pages are drawn as they come into view and dropped again when they
 * scroll well away, so a 600-page manual costs what the visible pages cost. The
 * text layer over each page is pdf.js's own, so selecting and copying work, and
 * Ctrl+F searches the text of every page through the same protocol the Office
 * preview answers (isCellGrid / collectCellMatches / gotoCellMatch).
 *
 * The bytes arrive on the tab as `file.pdf` (read by commands/pdf.rs in
 * Editor.openFile). pdf.js itself is imported the first time a PDF is shown —
 * it is a megabyte nobody who never opens one should pay for.
 */

/** pdf.js's own CSS pixels per PDF point: 96 / 72. */
const PDF_TO_CSS = 96 / 72;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
/** Steps the zoom buttons walk through, as browsers' PDF viewers do. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const PAGE_GAP = 12;
/** Room left either side of a page fitted to the width. */
const FIT_PADDING = 32;
/** A canvas larger than this is drawn at a lower resolution instead: WebView2
 *  gives up on canvases past about 16 megapixels and draws nothing at all. */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

let pdfjsPromise = null;

/**
 * pdf.js and its worker, loaded once. The worker is a separate file pdf.js
 * starts itself; `?url` makes Vite publish it and hand back where.
 */
export function loadPdfjs() {
    if (!pdfjsPromise) {
        pdfjsPromise = Promise.all([
            import('pdfjs-dist'),
            import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]).then(([pdfjs, worker]) => {
            pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
            return pdfjs;
        }).catch((err) => {
            pdfjsPromise = null; // let the next PDF try again
            throw err;
        });
    }
    return pdfjsPromise;
}

/** Where scripts/pdfjs-assets.js publishes pdf.js's data files. */
function assetBase(dir) {
    return new URL(`pdfjs/${dir}/`, document.baseURI).href;
}

/** The zoom step after (dir > 0) or before (dir < 0) the given scale. */
export function nextZoom(scale, dir) {
    if (dir > 0) return ZOOM_STEPS.find((s) => s > scale + 1e-6) ?? MAX_SCALE;
    return [...ZOOM_STEPS].reverse().find((s) => s < scale - 1e-6) ?? MIN_SCALE;
}

export function clampScale(scale) {
    if (!Number.isFinite(scale)) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The index of the page at a scroll position: the last page whose top is at or
 * above the point a third of the way down the view, which is where the eye is
 * when someone says "the page I am on".
 */
export function pageAt(tops, y) {
    let lo = 0;
    let hi = tops.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

export class PdfView {
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.doc = null;
        this.loadingTask = null;
        this.destroyed = false;
        this.pages = [];        // { el, width, height (in PDF points at scale 1), rendered, task, textLayer }
        this.pageTexts = [];    // per page: the strings of its text items, in TextLayer order
        this.pageItems = [];    // per page: those items themselves (width, transform, font)
        this.glyphWidths = [];  // per page: Map font -> Map(char -> advance in em), once read
        this._widthJobs = new Set();
        this.currentPage = 0;
        this.searchHits = null; // Map page -> Set(item index)
        this.searchActive = null;
    }

    render(content, file) {
        this.file = file;
        // Zoom and position survive switching tabs: the view is rebuilt every
        // time the tab is shown, and starting a long document over at page 1
        // with a different zoom each time would be losing the reader's place.
        const firstShow = !file._pdfView;
        this.state = file._pdfView || (file._pdfView = { fit: true, scale: 1, page: 0, offset: 0 });
        injectStyles();

        this.container.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'pdf-view';

        this.headEl = document.createElement('div');
        this.headEl.className = 'pdf-head';
        root.appendChild(this.headEl);

        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'pdf-body';
        this.bodyEl.tabIndex = 0;
        root.appendChild(this.bodyEl);

        this.pagesEl = document.createElement('div');
        this.pagesEl.className = 'pdf-pages';
        this.bodyEl.appendChild(this.pagesEl);

        this.container.appendChild(root);
        this._renderHead();
        this._bindEvents();
        this._load();
        if (firstShow) this._takeFocusFromExplorer();
    }

    // -- header ------------------------------------------------------------

    _renderHead() {
        const head = this.headEl;
        head.innerHTML = '';

        const badge = document.createElement('span');
        badge.className = 'pdf-badge';
        badge.textContent = t('Preview · read-only');
        badge.title = t('Read-only PDF preview — forms and annotations are not editable.');
        head.appendChild(badge);

        const nav = document.createElement('span');
        nav.className = 'pdf-nav';
        this.pageInput = document.createElement('input');
        this.pageInput.className = 'pdf-page-input';
        this.pageInput.type = 'text';
        this.pageInput.inputMode = 'numeric';
        this.pageInput.title = t('Page number — type one and press Enter');
        this.pageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const n = parseInt(this.pageInput.value, 10);
                if (Number.isFinite(n)) this.goToPage(n - 1);
                this.bodyEl.focus();
            } else if (e.key === 'Escape') {
                this._syncPageInput();
                this.bodyEl.focus();
            }
            e.stopPropagation();
        });
        this.pageInput.addEventListener('blur', () => this._syncPageInput());
        nav.appendChild(this.pageInput);
        this.pageCountEl = document.createElement('span');
        this.pageCountEl.className = 'pdf-page-count';
        nav.appendChild(this.pageCountEl);
        head.appendChild(nav);

        const zoom = document.createElement('span');
        zoom.className = 'pdf-zoom';
        zoom.appendChild(this._button('−', t('Zoom out'), () => this.zoomBy(-1)));
        this.zoomLabel = document.createElement('span');
        this.zoomLabel.className = 'pdf-zoom-label';
        zoom.appendChild(this.zoomLabel);
        zoom.appendChild(this._button('+', t('Zoom in'), () => this.zoomBy(1)));
        this.fitBtn = this._button(t('Fit width'), t('Fit the page to the width of the pane'), () => this.fitWidth());
        zoom.appendChild(this.fitBtn);
        head.appendChild(zoom);

        const spacer = document.createElement('span');
        spacer.className = 'pdf-spacer';
        head.appendChild(spacer);

        this.noteEl = document.createElement('span');
        this.noteEl.className = 'pdf-note';
        head.appendChild(this.noteEl);

        if (this.file && this.file.path) {
            head.appendChild(this._button(t('Open with Default App'), '', () => {
                invoke('open_with_default_app', { path: this.file.path }).catch((err) => {
                    console.warn('Could not open the file:', err);
                    if (window.showToast) window.showToast(t('Could not open this file in its default app.'));
                });
            }));
        }
        this._syncHead();
    }

    _button(label, title, onClick) {
        const btn = document.createElement('button');
        btn.className = 'pdf-btn';
        btn.textContent = label;
        if (title) btn.title = title;
        btn.addEventListener('click', onClick);
        return btn;
    }

    _syncHead() {
        this._syncPageInput();
        if (this.pageCountEl) this.pageCountEl.textContent = this.doc ? `/ ${this.doc.numPages}` : '';
        if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(this.state.scale * 100)}%`;
        if (this.fitBtn) this.fitBtn.classList.toggle('active', !!this.state.fit);
    }

    _syncPageInput() {
        if (!this.pageInput || document.activeElement === this.pageInput) return;
        this.pageInput.value = this.doc ? String(this.currentPage + 1) : '';
    }

    _setNote(text) {
        if (this.noteEl) this.noteEl.textContent = text || '';
    }

    // -- loading -----------------------------------------------------------

    async _load() {
        const bytes = this.file && this.file.pdf;
        if (!bytes || !bytes.byteLength) {
            this._empty(t('This PDF is empty.'));
            return;
        }
        this._empty(t('Loading…'));
        let pdfjs;
        try {
            pdfjs = await loadPdfjs();
        } catch (err) {
            console.error('pdf.js failed to load:', err);
            if (!this.destroyed) this._empty(t('The PDF viewer could not be loaded.'));
            return;
        }
        if (this.destroyed) return;

        // pdf.js hands the buffer to its worker and detaches it here. The tab
        // keeps the original, so the next time it is shown there is something
        // left to show.
        const data = new Uint8Array(bytes);
        this.loadingTask = pdfjs.getDocument({
            data,
            cMapUrl: assetBase('cmaps'),
            cMapPacked: true,
            standardFontDataUrl: assetBase('standard_fonts'),
            wasmUrl: assetBase('wasm'),
            useWasm: false,
            isEvalSupported: false,
            enableXfa: false,
        });
        // No password box: a preview that asks for credentials is a preview
        // pretending to be a viewer. The real application is one click away.
        this.loadingTask.onPassword = () => {
            this._empty(t('This PDF is password-protected. Open it in its default app to read it.'));
            this.loadingTask.destroy().catch(() => {});
        };

        try {
            this.doc = await this.loadingTask.promise;
        } catch (err) {
            if (this.destroyed) return;
            if (err && err.name === 'PasswordException') return;
            console.warn('PDF preview failed:', this.file.path, err);
            this._empty(t('Could not read this PDF — it may be damaged.'));
            return;
        }
        if (this.destroyed) { this.doc.destroy(); return; }

        // Every placeholder takes the first page's size until its own is known:
        // asking every page for its size up front would read a 600-page file
        // before the first one is drawn. Documents of mixed sizes settle as
        // the background pass below reaches each page.
        const first = await this.doc.getPage(1);
        if (this.destroyed) return;
        const [w, h] = pageSize(first);
        this.pagesEl.innerHTML = '';
        this.pages = [];
        for (let i = 0; i < this.doc.numPages; i++) {
            const el = document.createElement('div');
            el.className = 'pdf-page';
            el.dataset.page = String(i);
            this.pagesEl.appendChild(el);
            this.pages.push({ el, width: w, height: h, rendered: false, gen: 0, task: null, textLayer: null, sized: i === 0 });
        }
        this._applyScale();
        this._restorePosition();
        this._observe();
        this._syncHead();
        this._notifyStatus();
        this._scanPages();
    }

    /**
     * Learn each page's real size and its text, one page at a time and off
     * the critical path. The text is what Ctrl+F searches; reading it all here
     * rather than at search time keeps the search panel's call synchronous,
     * which is what its protocol is.
     */
    async _scanPages() {
        const n = this.doc.numPages;
        for (let i = 0; i < n; i++) {
            if (this.destroyed || !this.doc) return;
            try {
                const page = await this.doc.getPage(i + 1);
                if (this.destroyed) return;
                const info = this.pages[i];
                if (info && !info.sized) {
                    const [w, h] = pageSize(page);
                    info.sized = true;
                    if (w !== info.width || h !== info.height) {
                        // Keep the page being read where it is while the ones
                        // above it change height.
                        const anchor = this._anchor();
                        info.width = w;
                        info.height = h;
                        this._sizePage(info);
                        this._restoreAnchor(anchor);
                    }
                }
                const text = await page.getTextContent();
                if (this.destroyed) return;
                const items = text.items.filter((it) => it.str !== undefined);
                this.pageItems[i] = items;
                this.pageTexts[i] = items.map((it) => it.str);
                if (info) info.textContent = text;
            } catch (err) {
                this.pageTexts[i] = [];
                this.pageItems[i] = [];
            }
            if (n > 50 && i % 25 === 24) this._setNote(t('Reading text… {done} / {total}', { done: i + 1, total: n }));
        }
        this._setNote('');
    }

    // -- layout ------------------------------------------------------------

    _fitScale() {
        const width = (this.bodyEl.clientWidth || 800) - FIT_PADDING;
        const widest = Math.max(...this.pages.map((p) => p.width), 1);
        return clampScale(width / (widest * PDF_TO_CSS));
    }

    _applyScale() {
        if (this.state.fit) this.state.scale = this._fitScale();
        this.state.scale = clampScale(this.state.scale);
        this.pagesEl.style.setProperty('--scale-factor', String(this.state.scale * PDF_TO_CSS));
        for (const info of this.pages) {
            this._release(info);
            this._sizePage(info);
        }
        this._measure();
        this._syncHead();
        // Every page was released above; the observer only reports changes,
        // so the ones still on screen would stay blank without asking again.
        if (this.observer) this._observe();
    }

    _sizePage(info) {
        const s = this.state.scale * PDF_TO_CSS;
        info.el.style.width = `${Math.floor(info.width * s)}px`;
        info.el.style.height = `${Math.floor(info.height * s)}px`;
        this.tops = null;
    }

    /** Top of each page in the scroller's coordinates, for pageAt(). */
    _measure() {
        this.tops = this.pages.map((p) => p.el.offsetTop - this.pagesEl.offsetTop);
        return this.tops;
    }

    /** Where the reader is, as page + fraction into it, which survives a zoom. */
    _anchor() {
        const tops = this.tops || this._measure();
        const y = this.bodyEl.scrollTop;
        const i = pageAt(tops, y);
        const h = this.pages[i] ? this.pages[i].el.offsetHeight || 1 : 1;
        return { page: i, offset: (y - (tops[i] || 0)) / h };
    }

    _restoreAnchor({ page, offset }) {
        const tops = this._measure();
        const info = this.pages[page];
        if (!info) return;
        this.bodyEl.scrollTop = (tops[page] || 0) + offset * (info.el.offsetHeight || 0);
    }

    _restorePosition() {
        const page = Math.min(Math.max(this.state.page || 0, 0), this.pages.length - 1);
        this._restoreAnchor({ page, offset: this.state.offset || 0 });
        this.currentPage = page;
    }

    // -- drawing -----------------------------------------------------------

    _observe() {
        if (this.observer) this.observer.disconnect();
        // A screen ahead and behind, so scrolling at reading speed finds the
        // next page already drawn; anything further away gives its canvas back.
        this.observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const info = this.pages[Number(entry.target.dataset.page)];
                if (!info) continue;
                if (entry.isIntersecting) this._draw(info);
                else this._release(info);
            }
        }, { root: this.bodyEl, rootMargin: '100% 0px' });
        for (const info of this.pages) this.observer.observe(info.el);
    }

    async _draw(info) {
        if (info.rendered || !this.doc) return;
        info.rendered = true;
        // Each draw and each release bumps the generation, so a draw that was
        // overtaken (scrolled away and back, or zoomed) while it awaited stops
        // instead of painting over the one that replaced it.
        const gen = ++info.gen;
        const stale = () => this.destroyed || gen !== info.gen;
        const index = Number(info.el.dataset.page);
        try {
            const page = await this.doc.getPage(index + 1);
            if (stale()) return;
            const scale = this.state.scale;
            const viewport = page.getViewport({ scale: scale * PDF_TO_CSS });

            const ratio = window.devicePixelRatio || 1;
            const area = viewport.width * viewport.height * ratio * ratio;
            const output = area > MAX_CANVAS_PIXELS ? ratio * Math.sqrt(MAX_CANVAS_PIXELS / area) : ratio;

            const canvas = document.createElement('canvas');
            canvas.className = 'pdf-canvas';
            canvas.width = Math.floor(viewport.width * output);
            canvas.height = Math.floor(viewport.height * output);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;

            const textDiv = document.createElement('div');
            textDiv.className = 'textLayer';

            info.el.replaceChildren(canvas, textDiv);
            info.task = page.render({
                canvasContext: canvas.getContext('2d'),
                viewport,
                transform: output !== 1 ? [output, 0, 0, output, 0, 0] : null,
            });
            const pdfjs = await loadPdfjs();
            const source = info.textContent || await page.getTextContent();
            if (stale()) return;
            info.textLayer = new pdfjs.TextLayer({ textContentSource: source, container: textDiv, viewport });
            await Promise.all([info.task.promise, info.textLayer.render()]);
            if (stale()) return;
            info.task = null;
            this._paintHits(index);
        } catch (err) {
            // A render cancelled by scrolling away or zooming is not a failure.
            if (err && err.name === 'RenderingCancelledException') return;
            if (this.destroyed) return;
            console.warn('PDF page failed to draw:', index + 1, err);
        }
    }

    _release(info) {
        info.gen++;
        if (!info.rendered) return;
        info.rendered = false;
        if (info.task) { try { info.task.cancel(); } catch (_) { /* already done */ } }
        if (info.textLayer) { try { info.textLayer.cancel(); } catch (_) { /* already done */ } }
        info.task = null;
        info.textLayer = null;
        // Zeroing the canvas hands its memory back now rather than at the next
        // collection — with a dozen large pages that is the difference.
        const canvas = info.el.querySelector('canvas');
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        info.el.replaceChildren();
    }

    // -- navigation and zoom -----------------------------------------------

    goToPage(index) {
        if (!this.pages.length) return;
        const i = Math.min(Math.max(index, 0), this.pages.length - 1);
        this._restoreAnchor({ page: i, offset: 0 });
        this.currentPage = i;
        this._syncHead();
        this._notifyStatus();
    }

    setScale(scale) {
        if (!this.pages.length) return;
        const anchor = this._anchor();
        this.state.fit = false;
        this.state.scale = clampScale(scale);
        this._applyScale();
        this._restoreAnchor(anchor);
    }

    zoomBy(dir) {
        this.setScale(nextZoom(this.state.scale, dir));
    }

    fitWidth() {
        if (!this.pages.length) return;
        const anchor = this._anchor();
        this.state.fit = true;
        this._applyScale();
        this._restoreAnchor(anchor);
    }

    _bindEvents() {
        this._onScroll = () => {
            if (!this.pages.length) return;
            const tops = this.tops || this._measure();
            const i = pageAt(tops, this.bodyEl.scrollTop + this.bodyEl.clientHeight / 3);
            const anchor = this._anchor();
            this.state.page = anchor.page;
            this.state.offset = anchor.offset;
            if (i !== this.currentPage) {
                this.currentPage = i;
                this._syncHead();
                this._notifyStatus();
            }
        };
        this.bodyEl.addEventListener('scroll', this._onScroll, { passive: true });

        // Ctrl+wheel zooms the document, as in every PDF viewer, instead of the
        // whole window.
        this._onWheel = (e) => {
            if (!e.ctrlKey || !this.pages.length) return;
            e.preventDefault();
            this.zoomBy(e.deltaY < 0 ? 1 : -1);
        };
        this.bodyEl.addEventListener('wheel', this._onWheel, { passive: false });

        // Clicking anywhere in the document, text included, gives the scroller
        // the keyboard, so the arrows, PageUp/PageDown and Home/End move
        // through it. The browser does this for a click on a focusable
        // element's child too, but saying so does not depend on that.
        this.bodyEl.addEventListener('mousedown', () => {
            if (document.activeElement !== this.bodyEl) this.bodyEl.focus({ preventScroll: true });
        });

        // A pane resized with "fit width" on keeps fitting it. Debounced: a
        // drag of the splitter fires this per frame, and each call redraws.
        if (typeof ResizeObserver !== 'undefined') {
            let timer = null;
            let lastWidth = 0;
            this.resizeObserver = new ResizeObserver(() => {
                const width = this.bodyEl.clientWidth;
                if (!width || width === lastWidth) return;
                lastWidth = width;
                clearTimeout(timer);
                timer = setTimeout(() => {
                    if (!this.destroyed && this.state.fit && this.pages.length) this.fitWidth();
                }, 150);
            });
            this.resizeObserver.observe(this.bodyEl);
        }
    }

    _notifyStatus() {
        if (typeof this.options.updateStatusBar === 'function') this.options.updateStatusBar();
    }

    /** What the status bar shows where a text file shows Ln / Col. */
    getSelectionSummary() {
        if (!this.doc) return '';
        return t('Page {page} / {total}', { page: this.currentPage + 1, total: this.doc.numPages });
    }

    // -- search ------------------------------------------------------------
    //
    // A match is one occurrence inside a text item — a run of text pdf.js
    // reports as one piece, usually a line or part of one. The text layer
    // draws each item as one transparent span over the page.
    //
    // The mark is an empty box placed inside that span, not the span's own
    // characters wrapped. The span is laid out in a browser font and then
    // stretched as a whole to the item's width in the PDF, so only its two
    // ends are where the PDF put them: a word in the middle sits wherever the
    // browser font's widths put it. Wrapping the characters (as pdf.js's own
    // viewer does) drifted by up to a character in a PDF whose punctuation is
    // half-width. The box is placed by the PDF's own glyph widths instead
    // (_ensureWidths).

    isCellGrid() {
        return true;
    }

    /**
     * Every occurrence as {r: page, c: item, s: start, e: end}, start and end
     * being character offsets into the item's text.
     *
     * `regex` is what the search panel built from the query. Without one only
     * `pred` is known, and an item that passes is one match over its whole
     * text.
     */
    collectCellMatches(pred, regex) {
        const hits = [];
        // The last search's pages are repainted too, or a page with no hits
        // this time keeps its old marks.
        const before = this.searchHits ? [...this.searchHits.keys()] : [];
        this.searchHits = new Map();
        this.searchActive = null;
        const re = regex instanceof RegExp
            ? new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
            : null;
        for (let p = 0; p < this.pageTexts.length; p++) {
            const items = this.pageTexts[p];
            if (!items) continue;
            for (let c = 0; c < items.length; c++) {
                const text = items[c];
                if (!text || !pred(text)) continue;
                const ranges = re ? occurrences(re, text) : [[0, text.length]];
                if (!ranges.length) continue;
                if (!this.searchHits.has(p)) this.searchHits.set(p, new Map());
                this.searchHits.get(p).set(c, ranges);
                for (const [s, e] of ranges) hits.push({ r: p, c, s, e });
            }
        }
        for (const p of new Set([...before, ...this.searchHits.keys()])) this._paintHits(p);
        return hits;
    }

    gotoCellMatch(m) {
        if (!m || !this.pages[m.r]) return;
        const prev = this.searchActive;
        this.searchActive = { r: m.r, c: m.c, s: m.s || 0 };
        if (prev && prev.r !== m.r) this._paintHits(prev.r);
        // Bring the page in first, then the line once it is drawn: the item's
        // position is only known after the text layer exists.
        const info = this.pages[m.r];
        const tops = this._measure();
        const view = this.bodyEl.clientHeight || 0;
        const span = info.textLayer && info.textLayer.textDivs[m.c];
        if (span && span.isConnected) {
            const pageRect = info.el.getBoundingClientRect();
            const spanRect = span.getBoundingClientRect();
            const y = tops[m.r] + (spanRect.top - pageRect.top);
            this.bodyEl.scrollTop = Math.max(0, y - view / 2);
        } else {
            this.bodyEl.scrollTop = Math.max(0, tops[m.r] - PAGE_GAP);
            this._pendingReveal = { r: m.r, c: m.c, s: m.s, e: m.e };
        }
        // Said here rather than left to the scroll handler: a jump to a hit
        // that is already in view scrolls nothing, and the header would go on
        // naming the page the reader just left.
        if (this.currentPage !== m.r) {
            this.currentPage = m.r;
            this._syncHead();
            this._notifyStatus();
        }
        this._paintHits(m.r);
    }

    renderSearchHighlights(matches) {
        if (matches && matches.length) return;
        const pages = this.searchHits ? [...this.searchHits.keys()] : [];
        this.searchHits = null;
        this.searchActive = null;
        this._pendingReveal = null;
        for (const p of pages) this._paintHits(p);
    }

    /** Mark the occurrences on a drawn page. Pages drawn later are marked
     *  by _draw, since a released page's text layer is gone. */
    _paintHits(p) {
        const info = this.pages[p];
        if (!info || !info.textLayer) return;
        const divs = info.textLayer.textDivs || [];
        const hits = this.searchHits ? this.searchHits.get(p) : null;
        const active = this.searchActive && this.searchActive.r === p ? this.searchActive : null;
        if (hits && hits.size) this._ensureWidths(p);
        const widths = this.glyphWidths[p] || null;
        const items = this.pageItems[p] || [];
        divs.forEach((div, c) => {
            for (const old of div.querySelectorAll(':scope > mark.pdf-hit')) old.remove();
            const ranges = hits ? hits.get(c) : null;
            if (!ranges) return;
            const item = items[c];
            const text = (this.pageTexts[p] || [])[c] || div.textContent;
            const at = runOffsets(text, item, widths && item ? widths.get(item.fontName) : null);
            for (const [s, e] of ranges) {
                const mark = document.createElement('mark');
                mark.className = 'pdf-hit';
                if (active && active.c === c && active.s === s) mark.classList.add('pdf-hit-active');
                mark.style.left = `${(at[s] * 100).toFixed(3)}%`;
                mark.style.width = `${((at[e] - at[s]) * 100).toFixed(3)}%`;
                div.appendChild(mark);
            }
        });
        const pending = this._pendingReveal;
        if (pending && pending.r === p && divs[pending.c]) {
            this._pendingReveal = null;
            this.gotoCellMatch(pending);
        }
    }

    /**
     * Read how wide each character is in the PDF's own fonts on page `p`, and
     * mark the page again once known.
     *
     * pdf.js does not put this in the text content; the operator list has it,
     * glyph by glyph, under the same font names the text items carry. Read
     * only for a page with hits, and kept: it is a second pass over the page.
     */
    _ensureWidths(p) {
        if (this.glyphWidths[p] || this._widthJobs.has(p) || !this.doc) return;
        this._widthJobs.add(p);
        const doc = this.doc;
        (async () => {
            let map = new Map();
            try {
                const pdfjs = await loadPdfjs();
                const page = await doc.getPage(p + 1);
                if (typeof page.getOperatorList === 'function') {
                    map = glyphWidthsFrom(await page.getOperatorList(), pdfjs.OPS);
                }
            } catch (err) {
                // The marks stay where the browser font puts them.
            }
            this._widthJobs.delete(p);
            if (this.destroyed || this.doc !== doc) return;
            this.glyphWidths[p] = map;
            if (map.size && this.searchHits && this.searchHits.has(p)) this._paintHits(p);
        })();
    }

    /** Ctrl+2 and the other ways back to the editor land on the scroller. */
    focus() {
        if (this.bodyEl) this.bodyEl.focus({ preventScroll: true });
    }

    /**
     * A PDF opened from the file tree takes the keyboard.
     *
     * The explorer keeps the focus after a click on purpose, so that Delete
     * and F2 still act on the row, and with a text file that costs nothing:
     * the next thing anyone does is click into the text. A PDF is read with
     * the keyboard instead, and PageDown pressed right after opening one
     * walked the tree behind it.
     *
     * Only the first time a tab is shown, and only away from the explorer or
     * from nowhere: a reload from disk or a tab switch must not pull the
     * keyboard out of wherever it was. Asked again after the explorer's own
     * delayed refocus (50 ms after the click), which would otherwise win.
     */
    _takeFocusFromExplorer() {
        const take = () => {
            if (this.destroyed || !this.bodyEl || !this.bodyEl.isConnected) return;
            const pane = this.container.closest('.editor-pane');
            if (pane && !pane.classList.contains('active')) return;
            const el = document.activeElement;
            const idle = !el || el === document.body || el === document.documentElement;
            const inExplorer = el && typeof el.closest === 'function'
                && !!el.closest('#file-list, #explorer-list-container, #explorer-files-panel');
            if (idle || inExplorer) this.focus();
        };
        take();
        this._focusTimer = setTimeout(take, 80);
    }

    // -- housekeeping ------------------------------------------------------

    _empty(message) {
        this.pagesEl.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'pdf-empty';
        el.textContent = message;
        this.pagesEl.appendChild(el);
    }

    destroy() {
        this.destroyed = true;
        clearTimeout(this._focusTimer);
        if (this.observer) this.observer.disconnect();
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.bodyEl) {
            this.bodyEl.removeEventListener('scroll', this._onScroll);
            this.bodyEl.removeEventListener('wheel', this._onWheel);
        }
        for (const info of this.pages) this._release(info);
        this.pages = [];
        // Ends the worker's copy of the document. The worker itself is shared
        // and stays for the next PDF.
        if (this.loadingTask) this.loadingTask.destroy().catch(() => {});
        this.doc = null;
        this.loadingTask = null;
        if (this.container) this.container.innerHTML = '';
    }
}

/**
 * Where a global regex matches in `text`, as [start, end] pairs. An empty
 * match (a pattern like `a*`) is stepped over: it marks nothing, and taken as
 * a match it would loop forever.
 */
export function occurrences(re, text) {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        out.push([m.index, m.index + m[0].length]);
    }
    return out;
}

/**
 * Per font, the advance of each character in em, from a page's operator list.
 * The text items name the same fonts (the loaded name setFont carries).
 */
export function glyphWidthsFrom(opList, OPS) {
    const out = new Map();
    if (!opList || !OPS) return out;
    let font = null;
    const { fnArray, argsArray } = opList;
    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        if (fn === OPS.setFont) {
            const name = argsArray[i] && argsArray[i][0];
            font = out.get(name) || new Map();
            out.set(name, font);
        } else if (font && (fn === OPS.showText || fn === OPS.showSpacedText)) {
            const glyphs = argsArray[i] && argsArray[i][0];
            if (!Array.isArray(glyphs)) continue;
            for (const g of glyphs) {
                if (!g || typeof g !== 'object') continue;
                if (typeof g.unicode !== 'string' || !g.unicode || typeof g.width !== 'number') continue;
                if (!font.has(g.unicode)) font.set(g.unicode, g.width / 1000);
            }
        }
    }
    return out;
}

/** CJK and full-width forms: one em in almost every font that has them. */
function isWide(ch) {
    const c = ch.codePointAt(0);
    return (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF)
        || (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF)
        || (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFF60)
        || (c >= 0xFFE0 && c <= 0xFFE6) || c >= 0x20000;
}

/**
 * Where each character of a text item starts, as a fraction of the item's
 * width: n + 1 values from 0 to 1, indexed like the string (UTF-16), so
 * [at[s], at[e]] is the stretch a match from s to e covers.
 *
 * Each character weighs its advance in the PDF's font (`widths`, char -> em)
 * times the font size. Whatever the item's width has beyond that — the PDF's
 * character spacing, mostly — is shared evenly between the characters, which
 * is what character spacing is. A character the table does not have (a space
 * pdf.js inserted, or no table at all) is taken as one em if it is CJK and
 * half an em otherwise.
 */
export function runOffsets(text, item, widths) {
    const n = text.length;
    // One weight per character, on its first UTF-16 unit; the second half of
    // a surrogate pair weighs nothing.
    const em = new Array(n).fill(0);
    const starts = [];
    for (let i = 0; i < n;) {
        const ch = String.fromCodePoint(text.codePointAt(i));
        const known = widths ? widths.get(ch) : undefined;
        em[i] = typeof known === 'number' ? known : (isWide(ch) ? 1 : 0.5);
        starts.push(i);
        i += ch.length;
    }
    let weights = em;
    const t = item && item.transform;
    const size = t ? Math.hypot(t[0], t[1]) : 0;
    if (size > 0 && item.width > 0 && starts.length) {
        const sum = starts.reduce((a, k) => a + em[k], 0);
        const extra = (item.width - sum * size) / starts.length;
        weights = new Array(n).fill(0);
        for (const k of starts) weights[k] = Math.max(0, em[k] * size + extra);
    }
    const total = weights.reduce((a, b) => a + b, 0);
    const at = new Array(n + 1);
    at[0] = 0;
    for (let k = 0; k < n; k++) {
        const w = total > 0 ? weights[k] / total : (em[k] > 0 ? 1 / starts.length : 0);
        at[k + 1] = at[k] + w;
    }
    at[n] = 1;
    return at;
}

/** A page's size in PDF points, rotation applied, as [width, height]. */
function pageSize(page) {
    const vp = page.getViewport({ scale: 1 });
    return [vp.width, vp.height];
}

function injectStyles() {
    if (document.getElementById('pdf-view-styles')) return;
    const style = document.createElement('style');
    style.id = 'pdf-view-styles';
    style.textContent = `
    .pdf-view { display: flex; flex-direction: column; height: 100%; min-height: 0;
        color: var(--text-color); background: var(--bg-color); font-size: 13px; }
    .pdf-head { display: flex; align-items: center; gap: 10px; flex-shrink: 0;
        padding: 6px 12px; border-bottom: 1px solid var(--border-color); overflow: hidden; }
    .pdf-badge { font-size: 11px; font-weight: 600; letter-spacing: .02em;
        padding: 2px 8px; border-radius: 10px; flex-shrink: 0;
        border: 1px solid var(--border-color); color: var(--text-secondary, inherit); opacity: .85; }
    .pdf-nav, .pdf-zoom { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .pdf-page-input { width: 3.5em; font: inherit; font-size: 12px; text-align: right;
        padding: 2px 4px; border: 1px solid var(--border-color); border-radius: 4px;
        background: transparent; color: inherit; }
    .pdf-page-count { font-size: 12px; opacity: .8; white-space: nowrap; }
    .pdf-zoom-label { min-width: 3.2em; text-align: center; font-size: 12px; font-variant-numeric: tabular-nums; }
    .pdf-spacer { flex: 1 1 auto; }
    .pdf-note { font-size: 11px; opacity: .7; white-space: nowrap; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; }
    .pdf-btn { font: inherit; font-size: 11px; padding: 3px 10px; cursor: pointer;
        border: 1px solid var(--border-color); border-radius: 4px;
        background: transparent; color: inherit; flex-shrink: 0; }
    .pdf-btn:hover { background: var(--hover-color); }
    .pdf-btn.active { background: var(--hover-color); border-color: var(--text-secondary, var(--border-color)); }

    .pdf-body { flex: 1 1 auto; min-height: 0; overflow: auto; outline: none;
        background: color-mix(in srgb, var(--bg-color) 88%, #808080); }
    .pdf-pages { display: flex; flex-direction: column; align-items: center;
        gap: ${PAGE_GAP}px; padding: ${PAGE_GAP}px 16px; width: max-content; min-width: 100%; box-sizing: border-box; }
    /* Pages stay white in a dark theme, as paper does in every PDF viewer:
       inverting a document's colours misrepresents its figures. */
    .pdf-page { position: relative; flex-shrink: 0; background: #fff;
        box-shadow: 0 1px 4px rgba(0, 0, 0, .25);
        --user-unit: 1; --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
        --scale-round-x: 1px; --scale-round-y: 1px; }
    .pdf-canvas { display: block; }
    .pdf-empty { padding: 40px 16px; opacity: .7; text-align: center; }

    /* pdf.js's text layer (adapted from pdfjs-dist/web/pdf_viewer.css,
       Apache-2.0): transparent text laid exactly over the drawn glyphs, so
       selection and copy work on the page. */
    .pdf-page .textLayer { position: absolute; text-align: initial; inset: 0; overflow: clip;
        opacity: 1; line-height: 1; letter-spacing: normal; word-spacing: normal;
        text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0; z-index: 0;
        --min-font-size: 1;
        --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
        --min-font-size-inv: calc(1 / var(--min-font-size)); }
    .pdf-page .textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre;
        cursor: text; transform-origin: 0% 0%; user-select: text; }
    .pdf-page .textLayer > :not(.markedContent),
    .pdf-page .textLayer .markedContent span:not(.markedContent) { z-index: 1; --font-height: 0;
        font-size: calc(var(--text-scale-factor) * var(--font-height));
        --scale-x: 1; --rotate: 0deg;
        transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }
    .pdf-page .textLayer .markedContent { display: contents; }
    .pdf-page .textLayer span[role="img"] { user-select: none; cursor: default; }
    .pdf-page .textLayer ::selection { background: rgba(0, 90, 255, .3); color: transparent; }
    .pdf-page .textLayer br::selection { background: transparent; }
    .pdf-page .textLayer .endOfContent { display: block; position: absolute; inset: 100% 0 0;
        z-index: 0; cursor: default; user-select: none; }
    .pdf-page .textLayer.selecting .endOfContent { top: 0; }
    /* An empty box inside the item's span, placed in percent of the span's
       width so the span's own stretch carries it to the PDF's positions. A
       <mark>, not a span, so the span rules above leave it alone. */
    .pdf-page .textLayer mark.pdf-hit { position: absolute; top: 0; height: 100%;
        padding: 0; margin: 0; color: transparent; pointer-events: none;
        background: rgba(255, 200, 0, .45); border-radius: 2px; }
    .pdf-page .textLayer mark.pdf-hit-active { background: rgba(255, 120, 0, .65); }
    `;
    document.head.appendChild(style);
}
