import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { t } from '../utils/I18n.js';
import { VirtualScroll } from '../utils/VirtualScroll.js';

/**
 * OfficeView — a read-only look inside .xlsx / .docx / .pptx.
 *
 * The point is the wait, not the fidelity. Excel takes seconds to come up and
 * loads add-ins on the way; this draws the content that is already in the file.
 * So it shows values and text and nothing else: no cell formatting, no charts,
 * no shapes, no images. When the file turns out to be the one you wanted to
 * work in, the header has a button that hands it to the real application.
 *
 * The parsing happens in Rust (commands/office.rs) and arrives on the tab as
 * `file.office`. This file only draws it.
 */

const ROW_HEIGHT = 24;
const MIN_ROW_HEIGHT = 16;
const WRAP_LINE_HEIGHT = 16.2;
const CELL_HORIZONTAL_PADDING = 16;
const MIN_COL_WIDTH = 64;
const MAX_COL_WIDTH = 320;
/** Rows sampled when sizing columns. Measuring 5000 of them to pick a width
 *  costs more than the draw it is meant to speed up. */
const WIDTH_SAMPLE = 200;
/** Document blocks appended per frame, so a long report paints instead of
 *  freezing the window until the last paragraph is built. */
const BLOCKS_PER_FRAME = 300;
/** What counts as a piece of text on a slide or in a document, for search. */
const TEXT_NODES = '.of-slide-title, .of-bullets li, .of-notes > div, '
    + '.of-doc-h, .of-doc-p, .of-doc-list li, .of-doc-table th, .of-doc-table td';

/** Width of a padding column when the sheet declares no default, in px. */
const DEFAULT_FILL_WIDTH = 64;
/** A ceiling on the padding, so a very wide window cannot ask for hundreds of
 *  empty columns on a sheet two columns wide. */
const MAX_FILL_COLS = 64;

export class OfficeView {
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.scroller = null;
        this.pending = null;
    }

    render(content, file) {
        this.file = file;
        this.preview = file.office || { kind: 'sheets', sheets: [], slides: [], blocks: [] };
        injectStyles();

        this.container.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'of-view';

        this.headEl = document.createElement('div');
        this.headEl.className = 'of-head';
        root.appendChild(this.headEl);

        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'of-body';
        root.appendChild(this.bodyEl);

        this.container.appendChild(root);

        this._renderHead();
        if (this.preview.kind === 'sheets') this._renderWorkbook();
        else if (this.preview.kind === 'slides') this._renderDeck();
        else this._renderDocument();

        this._bindSheetKeys();
    }

    /**
     * The keys a sheet answers: Ctrl+PageUp / Ctrl+PageDown between sheets and
     * the arrows between cells, both as they behave in Excel.
     *
     * On the window rather than on the view, because nothing in a read-only
     * preview holds the focus: it has no text box and no caret, so a listener
     * waiting for the key to arrive at the grid would only ever fire after a
     * click. Which pane is being driven is settled by asking whether this
     * view's pane is the active one — the split editor can have two previews
     * open, and only one of them is being looked at.
     */
    _bindSheetKeys() {
        this._unbindSheetKeys();
        if (this.preview.kind !== 'sheets') return;

        this._sheetKeyHandler = (e) => {
            if (!this._keysAreOurs()) return;
            if (this._sheetSwitchKey(e)) return;
            this._cellMoveKey(e);
        };
        window.addEventListener('keydown', this._sheetKeyHandler, true);
    }

    /**
     * Is the keyboard this view's to read?
     *
     * Every guard has to be asked here, because the listener is on the window
     * and hears keys meant for the whole application. The arrows make this
     * sharper than the sheet keys did on their own: the explorer walks its
     * tree with the same four keys, and it is perfectly normal for a preview
     * to be on screen while the reader is up in the file list.
     */
    _keysAreOurs() {
        if (!this.container || !this.container.isConnected) return false;

        const el = document.activeElement;
        // Somebody is typing — a rename box in the explorer, the search
        // field, the AI prompt.
        if (el && (el.isContentEditable
            || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return false;
        // Nothing inside a read-only preview can take focus, so the body still
        // holding it is the ordinary case. Anything else that has taken it is
        // reading these keys itself.
        if (el && el !== document.body && el !== document.documentElement
            && !this.container.contains(el)) return false;

        const pane = this.container.closest('.editor-pane');
        return !pane || pane.classList.contains('active');
    }

    /** Ctrl+PageUp / Ctrl+PageDown. True once the key was one of them. */
    _sheetSwitchKey(e) {
        if (!e.ctrlKey && !e.metaKey) return false;
        if (e.altKey || e.shiftKey) return false;
        if (e.key !== 'PageUp' && e.key !== 'PageDown') return false;

        const sheets = this.preview.sheets || [];
        const next = this.sheetIndex + (e.key === 'PageDown' ? 1 : -1);
        // Excel stops at the ends rather than wrapping, and so does this:
        // wrapping turns "I am at the last sheet" into a silent jump home.
        if (next < 0 || next >= sheets.length) return true;

        e.preventDefault();
        e.stopPropagation();
        this.sheetIndex = next;
        this.file._officeSheet = next;
        this._renderTabs();
        this._renderSheet();
        return true;
    }

    /** The arrows walk the selected cell; Shift+arrow stretches the range. */
    _cellMoveKey(e) {
        const step = ARROW_STEPS[e.key];
        if (!step) return;
        // Ctrl+arrow is Excel's jump to the edge of the data, which this does
        // not do. Swallowing the key to do nothing would be worse than leaving
        // the browser to scroll with it.
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (!this.gridEl || !this.sheetRows || !this.sheetRows.length) return;

        e.preventDefault();
        e.stopPropagation();
        this._moveSelection(step[0], step[1], e.shiftKey);
    }

    _unbindSheetKeys() {
        if (!this._sheetKeyHandler) return;
        window.removeEventListener('keydown', this._sheetKeyHandler, true);
        this._sheetKeyHandler = null;
    }

    // -- header ------------------------------------------------------------

    _renderHead() {
        this.headEl.innerHTML = '';

        const badge = document.createElement('span');
        badge.className = 'of-badge';
        badge.textContent = t('Preview · read-only');
        badge.title = t('This preview shows text and values only — no formatting, charts or images.');
        this.headEl.appendChild(badge);

        // Sheet tabs sit in the header rather than at the bottom: the body is a
        // virtualised scroller, and a strip under it would have to be kept out
        // of the scroll area anyway.
        if (this.preview.kind === 'sheets' && this.preview.sheets.length) {
            this.tabsEl = document.createElement('div');
            this.tabsEl.className = 'of-tabs';
            this.headEl.appendChild(this.tabsEl);
        }

        const spacer = document.createElement('span');
        spacer.className = 'of-spacer';
        this.headEl.appendChild(spacer);

        this.noteEl = document.createElement('span');
        this.noteEl.className = 'of-note';
        this.headEl.appendChild(this.noteEl);

        // Gridlines follow the sheet by default — a sheet laid out as a
        // document usually turns them off, and that is most of the difference
        // between "a spreadsheet" and the page the author saw. The button is
        // for the other half of the time, when the faint grid is what you
        // wanted in order to read across a wide row.
        if (this.preview.kind === 'sheets') {
            this.gridBtn = document.createElement('button');
            this.gridBtn.className = 'of-btn';
            this.gridBtn.onclick = () => {
                this.showGrid = !this.showGrid;
                this._syncGridButton();
                if (this.gridEl) this.gridEl.classList.toggle('no-grid', !this.showGrid);
            };
            this.headEl.appendChild(this.gridBtn);
        }

        if (this.file && this.file.path) {
            const openBtn = document.createElement('button');
            openBtn.className = 'of-btn';
            openBtn.textContent = t('Open in the Office app');
            // Not the shell plugin's open(): its JS side is scoped to http,
            // tel and mailto, so a path is refused before it reaches the shell
            // and the button does nothing. commands/office.rs does it instead.
            openBtn.onclick = () => {
                invoke('open_office_file', { path: this.file.path }).catch((err) => {
                    // A button that fails in the console is a button that is
                    // broken as far as anyone pressing it can tell.
                    console.warn('Could not open the file:', err);
                    if (window.showToast) window.showToast(t('Could not open this file in the Office app.'));
                });
            };
            this.headEl.appendChild(openBtn);
        }
    }

    _setNote(text) {
        if (this.noteEl) this.noteEl.textContent = text || '';
    }

    _syncGridButton() {
        if (!this.gridBtn) return;
        this.gridBtn.textContent = t('Gridlines');
        this.gridBtn.classList.toggle('active', !!this.showGrid);
        this.gridBtn.title = this.showGrid
            ? t('Hide the background grid')
            : t('Show the background grid');
    }

    // -- workbooks ---------------------------------------------------------

    _renderWorkbook() {
        const sheets = this.preview.sheets || [];
        if (!sheets.length) {
            this._empty(t('This workbook has no sheets to show.'));
            return;
        }
        this.sheetIndex = Math.min(this.file._officeSheet || 0, sheets.length - 1);
        this._renderTabs();
        this._renderSheet();
    }

    _renderTabs() {
        if (!this.tabsEl) return;
        this.tabsEl.innerHTML = '';
        (this.preview.sheets || []).forEach((sheet, i) => {
            const tab = document.createElement('button');
            tab.className = 'of-tab' + (i === this.sheetIndex ? ' active' : '');
            tab.textContent = sheet.name;
            tab.title = `${sheet.name}  (Ctrl+PgUp / Ctrl+PgDn)`;
            tab.onclick = () => {
                if (i === this.sheetIndex) return;
                this.sheetIndex = i;
                // Remembered on the tab so coming back to this file lands on
                // the sheet that was being read, not on the first one.
                this.file._officeSheet = i;
                this._renderTabs();
                this._renderSheet();
            };
            this.tabsEl.appendChild(tab);
        });
    }

    _renderSheet() {
        const sheet = this.preview.sheets[this.sheetIndex];
        this._teardownScroller();
        this.bodyEl.innerHTML = '';

        const rows = sheet.rows || [];
        if (sheet.error) {
            // The tab is still there, and says why it is blank. A sheet that
            // simply vanishes from the strip is the worse failure: nothing on
            // screen distinguishes it from a sheet the workbook never had.
            this._setNote(t('could not be read'));
            this._empty(t('This sheet could not be read: {reason}', { reason: sheet.error }));
            return;
        }
        if (!rows.length) {
            this._setNote(t('empty sheet'));
            this._empty(t('This sheet is empty.'));
            return;
        }

        this._setNote(sheet.truncated
            ? t('showing {shown} of {total} rows', { shown: rows.length, total: sheet.total_rows })
            : t('{total} rows', { total: rows.length }));

        // The sheet's own geometry when the file records it, and a guess from
        // the contents when it does not. Measuring is a fair guess for a list
        // of data and quite wrong for a document: a Japanese 設計書 is often
        // drawn on a grid of 2.5-character columns, and re-fitting those to
        // their contents produces a page nobody wrote.
        const layout = sheet.layout || null;
        const declared = layout && layout.col_widths && layout.col_widths.length === rows[0].length
            ? layout.col_widths
            : null;
        // Copied, never the payload's own array: the filler columns are pushed
        // onto this, and a drag writes into it.
        this.colWidths = (declared || measureColumns(rows)).slice();
        // Widths the reader dragged, for as long as this tab is open — the same
        // life as the chosen sheet. Nothing is written to the file.
        const dragged = (this.file._officeColWidths || {})[this.sheetIndex];
        if (dragged) {
            for (const [c, px] of Object.entries(dragged)) {
                if (c < this.colWidths.length) this.colWidths[c] = px;
            }
        }
        this.colOffsets = [0];
        for (const w of this.colWidths) {
            this.colOffsets.push(this.colOffsets[this.colOffsets.length - 1] + w);
        }
        let totalWidth = this.colOffsets[this.colOffsets.length - 1] + GUTTER_WIDTH;

        // Row heights, and the running tops the merge boxes are placed at.
        // A reader normally sends one height per displayed row. Do not throw
        // away every recorded height if a truncated or older payload happens
        // to send only a prefix, though: the known tall rows still matter more
        // than falling back to a completely uniform grid.
        const declaredHeights = layout && Array.isArray(layout.row_heights) && layout.row_heights.length
            ? layout.row_heights
            : null;
        const heights = declaredHeights
            ? rows.map((_, r) => Number.isFinite(declaredHeights[r]) ? declaredHeights[r] : ROW_HEIGHT)
            : null;
        this.baseRowHeights = heights || rows.map(() => ROW_HEIGHT);
        this.rowHeights = this.baseRowHeights.slice();
        this.rowTops = [0];
        for (let r = 0; r < rows.length; r++) {
            this.rowTops.push(this.rowTops[r] + (heights ? heights[r] : ROW_HEIGHT));
        }
        this.merges = (layout && layout.merges) || [];
        this.covered = coverageByRow(this.merges);
        this.styles = (layout && layout.styles) || [];
        this.styleIds = (layout && layout.style_ids) || [];
        // Each sheet carries its own answer, so switching tabs picks it up.
        this.showGrid = layout ? layout.gridlines !== false : true;
        this._syncGridButton();

        // Columns of data end where the data does; the window does not. An
        // empty strip of background beyond the last column reads as the sheet
        // having been broken off, so it is padded out with the blank columns
        // Excel would be showing there. Done for real in _refitFiller, which
        // has to wait for a width to exist.
        this.dataCols = this.colWidths.length;
        this.dataOffsets = this.colOffsets.slice();
        this.fillWidth = (layout && layout.default_col_width) || DEFAULT_FILL_WIDTH;
        totalWidth = this.colOffsets[this.colOffsets.length - 1] + GUTTER_WIDTH;

        const grid = document.createElement('div');
        grid.className = 'of-grid' + (this.showGrid ? '' : ' no-grid');

        const head = document.createElement('div');
        head.className = 'of-grid-head';
        head.style.width = `${totalWidth}px`;

        const canvas = document.createElement('div');
        canvas.className = 'of-grid-canvas';
        canvas.style.width = `${totalWidth}px`;

        const rowsEl = document.createElement('div');
        rowsEl.className = 'of-grid-rows';
        canvas.appendChild(rowsEl);

        // Merged cells are drawn as boxes over the grid rather than inside it.
        // A range spanning twenty rows cannot live in any one of them, and the
        // rows are virtualised — only a handful exist at a time.
        const mergesEl = document.createElement('div');
        mergesEl.className = 'of-merges';
        canvas.appendChild(mergesEl);
        this.gridMergesEl = mergesEl;

        // Selection is an overlay rather than a set of DOM nodes. Rows and
        // columns are virtualised, so a DOM-only selection would disappear as
        // soon as the reader scrolls it out of the window.
        const selectionEl = document.createElement('div');
        selectionEl.className = 'of-selection';
        canvas.appendChild(selectionEl);
        this.gridSelectionEl = selectionEl;

        grid.append(head, canvas);
        this.bodyEl.appendChild(grid);

        this.gridEl = grid;
        this.gridHeadEl = head;
        this.gridRowsEl = rowsEl;
        this.gridCanvasEl = canvas;
        this.sheetRows = rows;
        this.selection = this._selectionForSheet();

        // Excel writes a fixed `ht` only for manually resized rows. A row
        // with Wrap Text and no `ht` is auto-sized when Excel opens it, so
        // reproduce that calculation from the visible column widths here.
        this._refreshRowHeights();

        // A uniform sheet keeps VirtualScroll on its fixed-height path, which
        // is a straight division instead of a scan over every row.
        const metric = this._rowMetric();
        this.scroller = new VirtualScroll(grid, rows.length, metric, (info) => this._paintRows(info));

        // Columns are windowed as well as rows, so a sideways scroll has to
        // repaint even though the visible row range has not moved.
        this._lastScrollLeft = 0;
        this._onHScroll = () => {
            if (grid.scrollLeft === this._lastScrollLeft) return;
            this._lastScrollLeft = grid.scrollLeft;
            this.scroller.onScroll();
        };
        grid.addEventListener('scroll', this._onHScroll);

        // The pane has no width yet: this all runs in one go, before the
        // browser has laid anything out, so clientWidth reads 0 and the
        // padding below would be skipped on first paint. The observer fires
        // once as soon as there is a width, and again whenever it changes —
        // which is also what makes the padding follow a window resize.
        this._fitObserver = new ResizeObserver(() => this._refitFiller());
        this._fitObserver.observe(grid);
    }

    /**
     * Add or drop the blank columns that carry the sheet out to the edge of
     * the pane. Only the padding moves; the sheet's own columns are untouched.
     */
    _refitFiller() {
        if (!this.gridEl || !this.colWidths) return;

        const want = this.gridEl.clientWidth || 0;
        // Start from the sheet's own columns every time, so a pane that has
        // been narrowed gives its padding back.
        this.colWidths.length = this.dataCols;
        this.colOffsets = this.dataOffsets.slice();

        let total = this.colOffsets[this.colOffsets.length - 1] + GUTTER_WIDTH;
        const step = this.fillWidth > 0 ? this.fillWidth : DEFAULT_FILL_WIDTH;
        while (total < want && this.colWidths.length < this.dataCols + MAX_FILL_COLS) {
            this.colWidths.push(step);
            this.colOffsets.push(this.colOffsets[this.colOffsets.length - 1] + step);
            total += step;
        }

        const width = `${this.colOffsets[this.colOffsets.length - 1] + GUTTER_WIDTH}px`;
        if (this.gridHeadEl) this.gridHeadEl.style.width = width;
        if (this.gridCanvasEl) this.gridCanvasEl.style.width = width;
        if (this.scroller) this.scroller.onScroll();
    }

    _rowMetric() {
        const heights = this.rowHeights || [];
        const uniform = heights.length > 0 && heights.every((h) => h === heights[0]);
        return uniform
            ? (heights[0] > 0 ? heights[0] : ROW_HEIGHT)
            : ((i) => heights[i] || 0);
    }

    /** Approximate the line count Excel needs for a wrapped value. */
    _wrappedLineCount(value, width) {
        const usable = Math.max(1, width - CELL_HORIZONTAL_PADDING);
        return String(value).split(/\r?\n/).reduce((count, line) => (
            count + Math.max(1, Math.ceil(textWidth(line) / usable))
        ), 0);
    }

    _autoRowHeight(rowIndex) {
        const base = this.baseRowHeights[rowIndex] || ROW_HEIGHT;
        const row = this.sheetRows[rowIndex] || [];
        const ids = this.styleIds[rowIndex] || [];
        let height = base;
        for (let c = 0; c < this.dataCols; c++) {
            const value = row[c] || '';
            const style = this.styles[ids[c]];
            if (!value || !style || !style.wrap) continue;
            const lines = this._wrappedLineCount(value, this.colWidths[c] || 0);
            // The CSS cell has 2px top padding and uses a 1.35 line-height.
            height = Math.max(height, Math.ceil(lines * WRAP_LINE_HEIGHT + 4));
        }
        return height;
    }

    /** Rebuild row geometry after content-driven or reader-driven height changes. */
    _refreshRowHeights() {
        if (!this.sheetRows) return;
        const dragged = (this.file._officeRowHeights || {})[this.sheetIndex] || {};
        this.rowHeights = this.sheetRows.map((_, r) => (
            Object.prototype.hasOwnProperty.call(dragged, r)
                ? dragged[r]
                : this._autoRowHeight(r)
        ));
        this.rowTops = [0];
        for (const height of this.rowHeights) {
            this.rowTops.push(this.rowTops[this.rowTops.length - 1] + height);
        }
        if (this.scroller) this.scroller.setItemHeight(this._rowMetric());
    }

    /**
     * The handle on a column header's right edge.
     *
     * Built with the header, which is rebuilt on every paint — so it carries no
     * state of its own, and a drag that outlives one paint keeps working
     * because the pointer is captured by the element that started it.
     */
    _columnGrip(col) {
        const grip = document.createElement('div');
        grip.className = 'of-col-grip';
        grip.title = t('Drag to resize · double-click to fit');

        grip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            this._beginColumnDrag(col, e.clientX);
        });

        // The spreadsheet gesture: double-click an edge to fit the contents.
        grip.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const column = this.sheetRows.map((row) => [row[col] || '']);
            this._setColumnWidth(col, measureColumns(column)[0] || MIN_COL_WIDTH);
        });

        return grip;
    }

    /**
     * Follow the pointer until it is let go.
     *
     * On the WINDOW, not on the grip. Changing a width repaints the header,
     * and the header is rebuilt from scratch every paint — so the grip the
     * gesture started on is removed from the document on the first move, and
     * with it went the listeners and the pointer capture. The column shifted a
     * few pixels and then stopped dead, which is exactly how it behaved.
     */
    _beginColumnDrag(col, startX) {
        if (!this.colWidths || col >= this.dataCols) return;
        const startWidth = this.colWidths[col];
        const grid = this.gridEl;

        // The cursor and the no-select have to live on something that survives
        // the repaint too.
        if (grid) grid.classList.add('col-resizing');

        const move = (ev) => {
            // Zero is allowed: that is how Excel hides a column, and someone
            // dragging one shut means it.
            this._setColumnWidth(col, Math.max(0, Math.round(startWidth + ev.clientX - startX)));
        };
        const up = () => {
            if (grid) grid.classList.remove('col-resizing');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            this._colDragCleanup = null;
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        // Closing the tab mid-drag would otherwise leave them on the window.
        this._colDragCleanup = up;
    }

    /** Resize one column and redraw. Remembered on the tab, not in the file. */
    _setColumnWidth(col, px) {
        if (!this.colWidths || col >= this.dataCols) return;
        this.colWidths[col] = px;

        // The sheet's own offsets, which _refitFiller rebuilds the padding from.
        this.dataOffsets = [0];
        for (let i = 0; i < this.dataCols; i++) {
            this.dataOffsets.push(this.dataOffsets[i] + this.colWidths[i]);
        }

        if (!this.file._officeColWidths) this.file._officeColWidths = {};
        const forSheet = this.file._officeColWidths[this.sheetIndex] || {};
        forSheet[col] = px;
        this.file._officeColWidths[this.sheetIndex] = forSheet;

        // A narrower/wider wrapped cell has a different number of lines.
        this._refreshRowHeights();
        // _refitFiller trims back to the sheet's columns, re-pads, resizes the
        // canvas and repaints — everything a width change needs.
        this._refitFiller();
    }

    /** The handle below a row-number cell. Double-click restores auto-fit. */
    _rowGrip(row) {
        const grip = document.createElement('div');
        grip.className = 'of-row-grip';
        grip.title = t('Drag to resize · double-click to fit');
        grip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            this._beginRowDrag(row, e.clientY);
        });
        grip.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._autoFitRow(row);
        });
        return grip;
    }

    _beginRowDrag(row, startY) {
        if (!this.rowHeights || row >= this.rowHeights.length) return;
        const startHeight = this.rowHeights[row];
        const grid = this.gridEl;
        if (grid) grid.classList.add('row-resizing');
        const move = (ev) => this._setRowHeight(
            row, Math.max(MIN_ROW_HEIGHT, Math.round(startHeight + ev.clientY - startY)));
        const up = () => {
            if (grid) grid.classList.remove('row-resizing');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            this._rowDragCleanup = null;
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        this._rowDragCleanup = up;
    }

    /** A reader-set height takes precedence over auto-fit, for this tab only. */
    _setRowHeight(row, px) {
        if (!this.sheetRows || row >= this.sheetRows.length) return;
        if (!this.file._officeRowHeights) this.file._officeRowHeights = {};
        const forSheet = this.file._officeRowHeights[this.sheetIndex] || {};
        forSheet[row] = px;
        this.file._officeRowHeights[this.sheetIndex] = forSheet;
        this._refreshRowHeights();
    }

    _autoFitRow(row) {
        const bySheet = this.file._officeRowHeights || {};
        const forSheet = bySheet[this.sheetIndex];
        if (forSheet) delete forSheet[row];
        this._refreshRowHeights();
    }

    /** Which columns are within the horizontal viewport, plus one either side. */
    _visibleCols() {
        const left = this.gridEl.scrollLeft;
        const right = left + (this.gridEl.clientWidth || 800);
        const n = this.colWidths.length;
        let start = 0;
        while (start < n - 1 && this.colOffsets[start + 1] + GUTTER_WIDTH < left) start++;
        let end = start;
        while (end < n - 1 && this.colOffsets[end] + GUTTER_WIDTH < right) end++;
        return { start: Math.max(0, start - 1), end: Math.min(n - 1, end + 1) };
    }

    _paintRows({ startIndex, endIndex, offsetY, totalHeight }) {
        if (!this.gridRowsEl) return;
        const cols = this._visibleCols();
        const pad = this.colOffsets[cols.start];

        this.gridCanvasEl.style.height = `${totalHeight}px`;
        this.gridRowsEl.style.transform = `translateY(${offsetY}px)`;

        // The header is rebuilt with the rows because it is windowed the same
        // way — its cells have to line up with the ones underneath.
        this.gridHeadEl.innerHTML = '';
        this.gridHeadEl.appendChild(cell('of-gutter of-corner', ''));
        this.gridHeadEl.appendChild(spacerCell(pad));
        for (let c = cols.start; c <= cols.end; c++) {
            const h = cell('of-col', columnName(c));
            h.style.width = `${this.colWidths[c]}px`;
            // Only the sheet's own columns can be resized. The padding on the
            // right is scenery — there is no column there to make wider.
            if (c < this.dataCols) h.appendChild(this._columnGrip(c));
            this.gridHeadEl.appendChild(h);
        }

        const frag = document.createDocumentFragment();
        for (let r = startIndex; r <= endIndex; r++) {
            const row = this.sheetRows[r];
            if (!row) continue;
            const h = this.rowHeights ? this.rowHeights[r] : ROW_HEIGHT;
            const el = document.createElement('div');
            el.className = 'of-row';
            // Set here rather than in the stylesheet: rows are only all the
            // same height when the sheet says so. line-height centres the one
            // line of text a cell shows, whatever height the row turned out.
            el.style.height = `${h}px`;
            el.style.lineHeight = `${h}px`;
            const gutter = cell('of-gutter of-row-gutter', String(r + 1));
            gutter.appendChild(this._rowGrip(r));
            el.appendChild(gutter);
            el.appendChild(spacerCell(pad));
            const spans = this.covered.get(r);
            const ids = this.styleIds[r];
            for (let c = cols.start; c <= cols.end; c++) {
                // Inside a merge, including its own top-left: the text is drawn
                // once, by the box over the top.
                const hidden = spans ? isCovered(spans, c) : false;
                const value = hidden ? '' : (row[c] || '');
                const style = ids ? this.styles[ids[c]] : null;
                const wrap = !!(style && style.wrap);
                const text = wrap ? value : oneLine(value);

                let cls = 'of-cell';
                if (!style || !style.halign) {
                    if (isNumeric(value)) cls += ' num';
                } else {
                    cls += ` h-${style.halign}`;
                }
                if (style && style.valign) cls += ` v-${style.valign}`;
                if (wrap) cls += ' wrap';

                // Not for a cell under a merged box: it is drawn empty, the
                // box carries the value, and marking both puts the active
                // highlight on something nobody can see.
                if (this.searchHits && !hidden) {
                    const key = `${r}:${c}`;
                    if (this.searchHits.has(key)) {
                        cls += key === this.searchActive ? ' of-hit of-hit-active' : ' of-hit';
                    }
                }

                if (this._isSelected(r, c)) cls += ' of-selected';

                const td = cell(cls, text);
                td.style.width = `${this.colWidths[c]}px`;
                if (style) applyBorders(td, style, this._styleAt(r, c - 1), this._styleAt(r - 1, c));
                // Not wrapping is not the same as being cut off. Excel lets a
                // long value run across the empty cells beside it and clips it
                // only when it reaches one with something in it — which is why
                // no spreadsheet has ever shown an ellipsis.
                if (!wrap) {
                    const room = this._spillRoom(r, row, c, cols.end);
                    if (room > 0) td.style.clipPath = `inset(0 ${-room}px 0 0)`;
                }
                // The tooltip still carries the whole of a value that had to be
                // cut, and the line breaks folded out of one that did not wrap.
                if (text !== value || value.length > 12) td.title = value;
                td.addEventListener('pointerdown', (e) => this._beginSelection(r, c, e));
                el.appendChild(td);
            }
            frag.appendChild(el);
        }
        this.gridRowsEl.innerHTML = '';
        this.gridRowsEl.appendChild(frag);
        this._paintMerges(startIndex, endIndex);
        this._paintSelection();
    }

    /** The style of one cell, or null. Out-of-range asks are the normal case
     *  at the edges of the sheet. */
    _styleAt(row, col) {
        if (row < 0 || col < 0) return null;
        const ids = this.styleIds[row];
        if (!ids || ids[col] === undefined) return null;
        return this.styles[ids[col]] || null;
    }

    /**
     * How far a value may run past its own cell, in pixels.
     *
     * Excel spills text across the empty cells to its right and stops at the
     * first one holding something. Cutting at the cell's own edge instead is
     * what put "…" in the middle of every sentence in a document.
     */
    _spillRoom(rowIndex, row, col, lastVisible) {
        const spans = this.covered.get(rowIndex);
        let room = 0;
        for (let c = col + 1; c <= lastVisible; c++) {
            if ((row[c] || '') !== '') break;
            // A merged box owns its area; text must not run under it.
            if (spans && isCovered(spans, c)) break;
            room += this.colWidths[c] || 0;
        }
        return room;
    }

    /** The merged boxes overlapping the rows on screen. */
    _paintMerges(startIndex, endIndex) {
        if (!this.gridMergesEl) return;
        this.gridMergesEl.innerHTML = '';
        if (!this.merges.length) return;

        const frag = document.createDocumentFragment();
        for (const m of this.merges) {
            if (m.row > endIndex || m.row + m.rows - 1 < startIndex) continue;
            const left = GUTTER_WIDTH + this.colOffsets[m.col];
            const right = GUTTER_WIDTH + this.colOffsets[Math.min(m.col + m.cols, this.colWidths.length)];
            const top = this.rowTops[m.row];
            const bottom = this.rowTops[Math.min(m.row + m.rows, this.sheetRows.length)];
            if (right <= left || bottom <= top) continue;

            const value = (this.sheetRows[m.row] && this.sheetRows[m.row][m.col]) || '';
            const anchor = this._styleAt(m.row, m.col);
            const wrap = !!(anchor && anchor.wrap);
            const text = wrap ? value : oneLine(value);

            let cls = 'of-merge';
            if (!anchor || !anchor.halign) {
                if (isNumeric(value)) cls += ' num';
            } else {
                cls += ` h-${anchor.halign}`;
            }
            // A merged box is usually taller than its text, so where the text
            // sits inside it is the difference between a heading and a stray
            // line floating in a box.
            cls += ` v-${(anchor && anchor.valign) || 'center'}`;
            if (wrap) cls += ' wrap';

            if (this.searchHits) {
                const key = `${m.row}:${m.col}`;
                if (this.searchHits.has(key)) {
                    cls += key === this.searchActive ? ' of-hit of-hit-active' : ' of-hit';
                }
            }

            const box = document.createElement('div');
            box.className = cls;
            box.style.left = `${left}px`;
            box.style.top = `${top}px`;
            box.style.width = `${right - left}px`;
            box.style.height = `${bottom - top}px`;
            box.textContent = text;

            // The outline of the range, not of its top-left cell: the anchor's
            // own right border is an edge INSIDE the box, and drawing it there
            // would put a line through the middle of every wide heading.
            const topRight = this._styleAt(m.row, m.col + m.cols - 1);
            const bottomLeft = this._styleAt(m.row + m.rows - 1, m.col);
            applyMergeBorders(box, {
                top: anchor && anchor.top,
                left: anchor && anchor.left,
                right: topRight && topRight.right,
                bottom: bottomLeft && bottomLeft.bottom,
            });

            if (text !== value || value.length > 12) box.title = value;
            box.addEventListener('pointerdown', (e) => this._beginSelection(m.row, m.col, e));
            frag.appendChild(box);
        }
        this.gridMergesEl.appendChild(frag);
    }

    // -- cell selection ---------------------------------------------------

    /** The selection belongs to the open tab, just like a dragged column. */
    _selectionForSheet() {
        const saved = (this.file._officeSelections || {})[this.sheetIndex];
        if (!saved || !saved.anchor || !saved.focus) return null;
        return {
            anchor: { ...saved.anchor },
            focus: { ...saved.focus },
        };
    }

    _rememberSelection() {
        if (!this.file._officeSelections) this.file._officeSelections = {};
        this.file._officeSelections[this.sheetIndex] = this.selection && {
            anchor: { ...this.selection.anchor },
            focus: { ...this.selection.focus },
        };
    }

    /** Bounds of the rectangle, expanded to contain intersecting merged cells. */
    _selectionBounds() {
        if (!this.selection) return null;
        let top = Math.min(this.selection.anchor.r, this.selection.focus.r);
        let bottom = Math.max(this.selection.anchor.r, this.selection.focus.r);
        let left = Math.min(this.selection.anchor.c, this.selection.focus.c);
        let right = Math.max(this.selection.anchor.c, this.selection.focus.c);

        // A selection may touch a merge in the middle, not only at the two
        // endpoints. Keep expanding until the rectangle owns every merge it
        // touches, exactly as a spreadsheet does.
        let changed = true;
        while (changed) {
            changed = false;
            for (const m of this.merges || []) {
                const mBottom = m.row + m.rows - 1;
                const mRight = m.col + m.cols - 1;
                if (mBottom < top || m.row > bottom || mRight < left || m.col > right) continue;
                const next = {
                    top: Math.min(top, m.row), bottom: Math.max(bottom, mBottom),
                    left: Math.min(left, m.col), right: Math.max(right, mRight),
                };
                changed = next.top !== top || next.bottom !== bottom
                    || next.left !== left || next.right !== right;
                ({ top, bottom, left, right } = next);
            }
        }
        return { top, bottom, left, right };
    }

    _isSelected(r, c) {
        const bounds = this._selectionBounds();
        return !!bounds && r >= bounds.top && r <= bounds.bottom && c >= bounds.left && c <= bounds.right;
    }

    _paintSelection() {
        const el = this.gridSelectionEl;
        const bounds = this._selectionBounds();
        if (!el) return;
        if (!bounds || !this.rowTops || !this.colOffsets) {
            el.style.display = 'none';
            return;
        }
        const left = GUTTER_WIDTH + this.colOffsets[bounds.left];
        const right = GUTTER_WIDTH + this.colOffsets[Math.min(bounds.right + 1, this.colOffsets.length - 1)];
        const top = this.rowTops[bounds.top];
        const bottom = this.rowTops[Math.min(bounds.bottom + 1, this.rowTops.length - 1)];
        el.style.display = '';
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${Math.max(0, right - left)}px`;
        el.style.height = `${Math.max(0, bottom - top)}px`;
    }

    /** Convert a pointer position into a real data cell, not a padding column. */
    _cellAtPoint(clientX, clientY) {
        if (!this.gridEl || !this.gridHeadEl || !this.rowTops || !this.colOffsets) return null;
        const rect = this.gridEl.getBoundingClientRect();
        const x = clientX - rect.left + this.gridEl.scrollLeft - GUTTER_WIDTH;
        const y = clientY - rect.top + this.gridEl.scrollTop - this.gridHeadEl.offsetHeight;
        if (x < 0 || y < 0) return null;
        const indexAt = (offsets, point) => {
            let lo = 0;
            let hi = offsets.length - 1;
            while (lo + 1 < hi) {
                const mid = Math.floor((lo + hi) / 2);
                if (offsets[mid] <= point) lo = mid;
                else hi = mid;
            }
            return lo;
        };
        const r = indexAt(this.rowTops, y);
        const c = indexAt(this.colOffsets, x);
        if (r >= this.sheetRows.length || c >= this.dataCols) return null;
        return { r, c };
    }

    _beginSelection(r, c, e) {
        if (e.button !== 0 || !this.gridEl) return;
        e.preventDefault();
        const point = { r, c };
        if (e.shiftKey && this.selection) this.selection.focus = point;
        else this.selection = { anchor: point, focus: point };
        this._rememberSelection();
        if (this.scroller) this.scroller.onScroll();

        const move = (ev) => {
            const next = this._cellAtPoint(ev.clientX, ev.clientY);
            if (!next) return;
            this.selection.focus = next;
            this._rememberSelection();
            if (this.scroller) this.scroller.onScroll();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            this._selectionDragCleanup = null;
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        this._selectionDragCleanup = up;
    }

    /** The merged box a cell falls inside, or null. */
    _mergeAt(r, c) {
        for (const m of this.merges || []) {
            if (r >= m.row && r < m.row + m.rows
                && c >= m.col && c < m.col + m.cols) return m;
        }
        return null;
    }

    /**
     * Move the selection by one cell, or stretch it when extending.
     *
     * With nothing selected yet the first press only lands somewhere: on the
     * cell already at the top-left of the window, so the sheet does not jump
     * to a row the reader was not looking at. Excel always has an active cell;
     * this is how a preview that started without one acquires it.
     */
    _moveSelection(dr, dc, extend) {
        const rows = this.sheetRows.length;
        const cols = this.dataCols;
        if (!rows || !cols) return;

        if (!this.selection) {
            const start = this._firstVisibleCell();
            this.selection = { anchor: start, focus: { ...start } };
            this._rememberSelection();
            if (this.scroller) this.scroller.onScroll();
            return;
        }

        const from = this.selection.focus;
        let r = Math.min(rows - 1, Math.max(0, from.r));
        let c = Math.min(cols - 1, Math.max(0, from.c));

        // A merge is one cell to step over, not a run of them. Leaving from
        // its far edge is what takes the reader out of a box in one press —
        // stepping into the middle of the box they are already standing on
        // looks exactly like the key having done nothing.
        const box = this._mergeAt(r, c);
        if (box) {
            if (dr > 0) r = box.row + box.rows - 1;
            else if (dr < 0) r = box.row;
            if (dc > 0) c = box.col + box.cols - 1;
            else if (dc < 0) c = box.col;
        }
        r = Math.min(rows - 1, Math.max(0, r + dr));
        c = Math.min(cols - 1, Math.max(0, c + dc));

        // A box is entered at its top-left, the one cell of it that carries
        // the text, so the reader can see which box they landed in.
        const into = this._mergeAt(r, c);
        const focus = into ? { r: into.row, c: into.col } : { r, c };

        this.selection.focus = focus;
        if (!extend) this.selection.anchor = { ...focus };
        this._rememberSelection();
        this._revealCell(focus.r, focus.c);
        if (this.scroller) this.scroller.onScroll();
    }

    /** The cell in the top-left corner of what is on screen. */
    _firstVisibleCell() {
        const atLeast = (offsets, edge, limit) => {
            for (let i = 0; i < limit; i++) if (offsets[i] >= edge) return i;
            return Math.max(0, limit - 1);
        };
        return {
            r: atLeast(this.rowTops, this.gridEl ? this.gridEl.scrollTop : 0,
                this.sheetRows.length),
            c: atLeast(this.colOffsets, this.gridEl ? this.gridEl.scrollLeft : 0,
                this.dataCols),
        };
    }

    /**
     * Scroll the least that brings a cell fully into view.
     *
     * The least, not to the middle: walking down a column with the sheet
     * re-centring on every press makes the rows around the cell move under the
     * eye, and reading the column is the thing the reader is doing. The search
     * jump centres because it is a jump — the cell it lands on has no
     * relationship to what was on screen before.
     *
     * The column header and the row-number gutter are sticky, so the strip of
     * window they cover is not somewhere a cell can be read; both edges are
     * measured against the space left over.
     */
    _revealCell(r, c) {
        const grid = this.gridEl;
        if (!grid || !this.rowTops || !this.colOffsets) return;

        // A merge is revealed whole where it fits, and from its top-left where
        // it does not — scrolling the head of a tall box off the screen to show
        // its foot loses the text, which lives at the top.
        const box = this._mergeAt(r, c);
        const lastRow = box ? box.row + box.rows - 1 : r;
        const lastCol = box ? box.col + box.cols - 1 : c;
        const headH = this.gridHeadEl ? this.gridHeadEl.offsetHeight : 0;

        const top = this.rowTops[r] || 0;
        const bottom = this.rowTops[Math.min(lastRow + 1, this.rowTops.length - 1)] || 0;
        const height = grid.clientHeight || 0;
        if (top < grid.scrollTop) grid.scrollTop = top;
        else if (headH + bottom > grid.scrollTop + height) {
            grid.scrollTop = Math.min(top, headH + bottom - height);
        }

        const left = this.colOffsets[c] || 0;
        const right = this.colOffsets[Math.min(lastCol + 1, this.colOffsets.length - 1)] || 0;
        const width = grid.clientWidth || 0;
        if (left < grid.scrollLeft) grid.scrollLeft = left;
        else if (GUTTER_WIDTH + right > grid.scrollLeft + width) {
            grid.scrollLeft = Math.min(left, GUTTER_WIDTH + right - width);
        }
    }

    /** Copy the selected rectangle as TSV, so it pastes directly into Excel. */
    async copy() {
        if (this.preview.kind !== 'sheets') return;
        const bounds = this._selectionBounds();
        if (!bounds) return;
        const lines = [];
        for (let r = bounds.top; r <= bounds.bottom; r++) {
            const row = this.sheetRows[r] || [];
            lines.push(row.slice(bounds.left, bounds.right + 1).join('\t'));
        }
        await writeText(lines.join('\n'));
    }

    // -- decks -------------------------------------------------------------

    _renderDeck() {
        const slides = this.preview.slides || [];
        this.bodyEl.innerHTML = '';
        if (!slides.length) {
            this._empty(t('This presentation has no slides to show.'));
            return;
        }
        this._setNote(t('{total} slides', { total: slides.length }));

        const list = document.createElement('div');
        list.className = 'of-slides';

        // A deck exported as one picture per slide parses to nothing at all.
        // That is the file, not a failure — but a column of blank cards reads
        // as a broken preview, so it gets said out loud, once.
        const hasText = (s) => !!(s.title || (s.bullets && s.bullets.length) || s.notes);
        if (!slides.some(hasText)) {
            const banner = document.createElement('div');
            banner.className = 'of-banner';
            banner.textContent = t('Every slide here is a picture — an outline has no text to read.');
            list.appendChild(banner);
        }
        for (const slide of slides) {
            const card = document.createElement('section');
            card.className = 'of-slide';

            const head = document.createElement('div');
            head.className = 'of-slide-head';
            const num = document.createElement('span');
            num.className = 'of-slide-num';
            num.textContent = String(slide.number);
            const title = document.createElement('h2');
            title.className = 'of-slide-title';
            // A slide with no title placeholder is normal (section breaks,
            // full-bleed images); saying so beats an empty heading.
            title.textContent = slide.title || t('(no title)');
            if (!slide.title) title.classList.add('untitled');
            head.append(num, title);
            card.appendChild(head);

            if (slide.bullets && slide.bullets.length) {
                const ul = document.createElement('ul');
                ul.className = 'of-bullets';
                for (const b of slide.bullets) {
                    const li = document.createElement('li');
                    li.style.marginLeft = `${Math.min(b.level, 6) * 18}px`;
                    li.textContent = b.text;
                    ul.appendChild(li);
                }
                card.appendChild(ul);
            }

            if (!hasText(slide)) {
                const none = document.createElement('p');
                none.className = 'of-slide-none';
                if (slide.pictures === 1) none.textContent = t('One image, no text');
                else if (slide.pictures) none.textContent = t('{n} images, no text', { n: slide.pictures });
                else none.textContent = t('No text on this slide');
                card.appendChild(none);
            }

            if (slide.notes) {
                const notes = document.createElement('details');
                notes.className = 'of-notes';
                const sum = document.createElement('summary');
                sum.textContent = t('Speaker notes');
                const body = document.createElement('div');
                body.textContent = slide.notes;
                notes.append(sum, body);
                card.appendChild(notes);
            }

            list.appendChild(card);
        }
        this.bodyEl.appendChild(list);
    }

    // -- documents ---------------------------------------------------------

    _renderDocument() {
        const blocks = this.preview.blocks || [];
        this.bodyEl.innerHTML = '';
        if (!blocks.length) {
            this._empty(t('This document has no text to show.'));
            return;
        }
        // "blocks" is what the parser calls them; a reader counts paragraphs,
        // and a table is one thing they scroll past rather than one paragraph.
        const paragraphs = blocks.filter((b) => b.kind !== 'table').length;
        this._setNote(t('{total} paragraphs', { total: paragraphs }));

        const page = document.createElement('article');
        page.className = 'of-doc';
        this.bodyEl.appendChild(page);

        // Painted a chunk per frame. A 300-page report built in one pass locks
        // the window for as long as it takes, which is exactly the wait this
        // whole feature exists to avoid.
        let i = 0;
        let list = null;
        const step = () => {
            const until = Math.min(i + BLOCKS_PER_FRAME, blocks.length);
            const frag = document.createDocumentFragment();
            for (; i < until; i++) {
                const block = blocks[i];
                if (block.kind === 'list') {
                    if (!list) {
                        list = document.createElement('ul');
                        list.className = 'of-doc-list';
                        frag.appendChild(list);
                    }
                    const li = document.createElement('li');
                    li.style.marginLeft = `${Math.min(block.level, 6) * 18}px`;
                    li.textContent = block.text;
                    list.appendChild(li);
                    continue;
                }
                list = null;
                frag.appendChild(documentBlock(block));
            }
            page.appendChild(frag);
            if (i < blocks.length) this.pending = requestAnimationFrame(step);
            else this.pending = null;
        };
        step();
    }

    // -- search ------------------------------------------------------------
    //
    // The cell-grid protocol from ui/Search.js: the view finds its own matches
    // and is told which one to show. A preview has no textarea for the panel
    // to work through, and for a sheet there is no text to work through at all
    // — the document is a grid of separate values.
    //
    // Sheets are searched one sheet at a time, which is what Excel's own Find
    // does unless you ask it for the workbook. Slides and documents are
    // searched over what is on the page.

    isCellGrid() {
        return true;
    }

    /**
     * Every match, as {r, c}. A negative column means "not a cell" — the r is
     * then an index into the text elements of a slide deck or a document,
     * which the grid protocol has no other way to say.
     */
    collectCellMatches(pred) {
        const hits = [];
        if (this.preview.kind === 'sheets') {
            const rows = this.sheetRows || [];
            for (let r = 0; r < rows.length; r++) {
                const row = rows[r];
                if (!row) continue;
                for (let c = 0; c < row.length; c++) {
                    if (pred(row[c] || '')) hits.push({ r, c });
                }
            }
            // Kept so the grid can mark them as it paints: the rows are
            // virtualised, so a highlight cannot simply be left on the DOM.
            this.searchHits = new Set(hits.map(({ r, c }) => `${r}:${c}`));
            this.searchActive = null;
            if (this.scroller) this.scroller.onScroll();
            return hits;
        }

        this.searchNodes = [...this.bodyEl.querySelectorAll(TEXT_NODES)];
        this.searchNodes.forEach((el, i) => {
            if (pred(el.textContent || '')) hits.push({ r: i, c: -1 });
        });
        return hits;
    }

    /** Put one match on screen and mark it. */
    gotoCellMatch(m) {
        if (!m) return;
        if (m.c < 0) {
            const el = (this.searchNodes || [])[m.r];
            if (!el) return;
            this.bodyEl.querySelectorAll('.of-hit-active')
                .forEach((n) => n.classList.remove('of-hit-active'));
            el.classList.add('of-hit-active');
            el.scrollIntoView({ block: 'center' });
            return;
        }

        if (!this.gridEl || !this.rowTops) return;
        this.searchActive = `${m.r}:${m.c}`;

        // Centred rather than merely brought inside the viewport: a hit that
        // lands one pixel below the header is technically visible and takes a
        // second to find.
        const top = this.rowTops[m.r] || 0;
        const height = (this.rowHeights ? this.rowHeights[m.r] : ROW_HEIGHT) || ROW_HEIGHT;
        const view = this.gridEl.clientHeight || 0;
        this.gridEl.scrollTop = Math.max(0, top - (view - height) / 2);

        const left = GUTTER_WIDTH + (this.colOffsets[m.c] || 0);
        const width = this.colWidths[m.c] || 0;
        const wide = this.gridEl.clientWidth || 0;
        if (left < this.gridEl.scrollLeft + GUTTER_WIDTH
            || left + width > this.gridEl.scrollLeft + wide) {
            this.gridEl.scrollLeft = Math.max(0, left - (wide - width) / 2);
        }
        // scrollTop/scrollLeft fire scroll, but not when the value is unchanged
        // — a second hit in the row already on screen would not repaint.
        if (this.scroller) this.scroller.onScroll();
    }

    /**
     * Drop the highlights. The name is the search panel's, not this view's:
     * _cleanupSearch calls renderSearchHighlights([], 0) on whatever is showing
     * when the query is cleared or the panel closed, so implementing it is how
     * a view gets told to forget. There is nothing to draw for a non-empty
     * list — the cells are marked as they are painted, because they are
     * virtualised and a highlight left on the DOM would scroll away.
     */
    renderSearchHighlights(matches) {
        if (matches && matches.length) return;
        this.searchHits = null;
        this.searchActive = null;
        if (this.bodyEl) {
            this.bodyEl.querySelectorAll('.of-hit-active')
                .forEach((n) => n.classList.remove('of-hit-active'));
        }
        if (this.scroller) this.scroller.onScroll();
    }

    // -- housekeeping ------------------------------------------------------

    _empty(message) {
        this.bodyEl.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'of-empty';
        el.textContent = message;
        this.bodyEl.appendChild(el);
    }

    _teardownScroller() {
        // A drag in flight owns three window listeners; the grid it was
        // dragging is about to go.
        if (this._colDragCleanup) this._colDragCleanup();
        if (this._rowDragCleanup) this._rowDragCleanup();
        if (this._selectionDragCleanup) this._selectionDragCleanup();
        if (this.gridEl && this._onHScroll) {
            this.gridEl.removeEventListener('scroll', this._onHScroll);
        }
        if (this._fitObserver) {
            this._fitObserver.disconnect();
            this._fitObserver = null;
        }
        if (this.scroller) {
            this.scroller.destroy();
            this.scroller = null;
        }
        this.gridEl = null;
        this.gridRowsEl = null;
        this.gridHeadEl = null;
        this.gridCanvasEl = null;
        this.gridMergesEl = null;
        this.gridSelectionEl = null;
    }

    focus() {
        if (this.bodyEl) this.bodyEl.focus?.();
    }

    destroy() {
        if (this.pending) {
            cancelAnimationFrame(this.pending);
            this.pending = null;
        }
        this._unbindSheetKeys();
        this._teardownScroller();
        if (this.container) this.container.innerHTML = '';
    }

    getDiagnostics() {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/** Row and column deltas for the four arrow keys. */
const ARROW_STEPS = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
};

/** Width of the row-number gutter, in px. Mirrored in the stylesheet below. */
const GUTTER_WIDTH = 52;

function cell(className, text) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    return el;
}

function spacerCell(width) {
    const el = document.createElement('div');
    el.className = 'of-pad';
    el.style.width = `${width}px`;
    return el;
}

/**
 * A cell's text on one line.
 *
 * Rows are a fixed height so they can be virtualised, so a value holding line
 * breaks would draw its first line and hide the rest below the cell — data
 * present in the file and invisible on the screen, with nothing to say so.
 * Folded to spaces instead, with the original kept in the tooltip.
 */
export function oneLine(value) {
    return String(value).replace(/\s*[\r\n]+\s*/g, ' ');
}

/**
 * Which columns each row has covered by a merge, as [first, last] spans.
 *
 * Indexed by row because that is how the grid is drawn — a row at a time —
 * and a merge is stored once per row it crosses rather than once per cell,
 * so a range twenty columns wide costs the same as one two columns wide.
 */
export function coverageByRow(merges) {
    const byRow = new Map();
    for (const m of merges || []) {
        for (let r = m.row; r < m.row + m.rows; r++) {
            let spans = byRow.get(r);
            if (!spans) byRow.set(r, (spans = []));
            spans.push([m.col, m.col + m.cols - 1]);
        }
    }
    return byRow;
}

/** Is this column inside one of the row's merged spans? */
export function isCovered(spans, col) {
    for (const [from, to] of spans) {
        if (col >= from && col <= to) return true;
    }
    return false;
}

/** OOXML's border kinds as CSS. Colour is deliberately the theme's ink: a
 *  spreadsheet's borders are almost always automatic or black, and a black
 *  line is invisible on a dark theme. A genuinely coloured border is the rare
 *  case, and losing its colour costs less than losing the line. */
const BORDER_CSS = {
    thin: '1px solid var(--text-color)',
    thick: '2px solid var(--text-color)',
    double: '3px double var(--text-color)',
    dashed: '1px dashed var(--text-color)',
    dotted: '1px dotted var(--text-color)',
};

/**
 * Put a cell's declared borders on it.
 *
 * Only its own right and bottom, plus a left or top that the neighbour on that
 * side does not already draw. Two cells sharing an edge each declare it, and
 * drawing both would put two lines where the sheet has one.
 */
export function applyBorders(el, style, leftNeighbour, aboveNeighbour) {
    if (style.right) el.style.borderRight = BORDER_CSS[style.right] || '';
    if (style.bottom) el.style.borderBottom = BORDER_CSS[style.bottom] || '';
    if (style.left && !(leftNeighbour && leftNeighbour.right)) {
        el.style.borderLeft = BORDER_CSS[style.left] || '';
    }
    if (style.top && !(aboveNeighbour && aboveNeighbour.bottom)) {
        el.style.borderTop = BORDER_CSS[style.top] || '';
    }
}

/**
 * The four edges of a merged box.
 *
 * Unlike a plain cell there is no neighbour to defer to: the box is drawn over
 * the grid, so every edge it wants is its own to draw.
 */
export function applyMergeBorders(el, edges) {
    for (const side of ['top', 'right', 'bottom', 'left']) {
        const kind = edges[side];
        if (!kind) continue;
        const css = BORDER_CSS[kind];
        if (!css) continue;
        el.style[`border${side[0].toUpperCase()}${side.slice(1)}`] = css;
    }
}

/** 0 → A, 25 → Z, 26 → AA. The column labels a spreadsheet already uses. */
export function columnName(index) {
    let name = '';
    let n = index;
    do {
        name = String.fromCharCode(65 + (n % 26)) + name;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return name;
}

/** Right-aligned like a spreadsheet does, and only for what is really a number. */
export function isNumeric(value) {
    if (typeof value !== 'string' || value === '') return false;
    return /^-?\d[\d,]*(\.\d+)?%?$/.test(value);
}

/**
 * Characters that take a full cell of their own in a monospace font.
 *
 * Kanji, kana, Hangul, full-width punctuation and emoji. Half-width katakana
 * (U+FF61-FF9F) is deliberately outside the FF00 range below, because it is
 * narrow - which is the entire point of it.
 */
const WIDE_CHARS =
    /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]/u;

/** Measured in the grid's own 12px monospace: Latin 6.6px, CJK 12px. */
const NARROW_PX = 6.6;
const WIDE_PX = 12;
/**
 * Everything in a cell that is not the text: 8px padding either side, the 1px
 * right border (the cells are `border-box`), and 3px of slack. The slack earns
 * its place — at exactly the text width, sub-pixel rounding puts an ellipsis on
 * a value that fits, and "SO-2026-00…" in a column with room for it is the kind
 * of detail that makes the whole preview look approximate.
 */
const CELL_CHROME = 20;

/** How wide a string draws, in px, without touching the DOM to find out. */
export function textWidth(text) {
    let px = 0;
    for (const ch of String(text)) px += WIDE_CHARS.test(ch) ? WIDE_PX : NARROW_PX;
    return px;
}

/**
 * A width per column, from the widest value in the first rows.
 *
 * Sampled rather than measured over the whole sheet, and clamped at both ends:
 * a column of empty cells should not collapse to nothing, and one cell holding
 * a paragraph should not push every other column off the screen.
 *
 * Counting characters and multiplying was the first version, and it cut every
 * Japanese column short: a kanji is very nearly twice a Latin letter wide, so
 * product-name columns lost half their text to an ellipsis on a sheet with
 * room to spare.
 */
export function measureColumns(rows, sample = WIDTH_SAMPLE) {
    const count = rows.reduce((max, r) => Math.max(max, r.length), 0);
    const widths = new Array(count).fill(MIN_COL_WIDTH);
    const upto = Math.min(rows.length, sample);
    for (let r = 0; r < upto; r++) {
        const row = rows[r];
        for (let c = 0; c < row.length; c++) {
            const value = row[c];
            if (!value) continue;
            const want = Math.ceil(textWidth(oneLine(value))) + CELL_CHROME;
            if (want > widths[c]) widths[c] = Math.min(want, MAX_COL_WIDTH);
        }
    }
    return widths;
}

function documentBlock(block) {
    if (block.kind === 'heading') {
        const h = document.createElement(`h${Math.min(Math.max(block.level, 1), 6)}`);
        h.className = 'of-doc-h';
        h.textContent = block.text;
        return h;
    }
    if (block.kind === 'table') {
        const table = document.createElement('table');
        table.className = 'of-doc-table';
        const body = document.createElement('tbody');
        // The first row reads as a header, which is what a Word table almost
        // always means by it — but only when there is a second row for it to
        // be the header OF. A one-row table is a note box, and setting the
        // whole thing in bold on a tinted background says something about it
        // that the document does not.
        const rows = block.rows || [];
        const hasHeader = rows.length > 1;
        rows.forEach((row, i) => {
            const tr = document.createElement('tr');
            for (const value of row) {
                const td = document.createElement(hasHeader && i === 0 ? 'th' : 'td');
                td.textContent = value;
                tr.appendChild(td);
            }
            body.appendChild(tr);
        });
        table.appendChild(body);
        return table;
    }
    const p = document.createElement('p');
    p.className = 'of-doc-p';
    p.textContent = block.text;
    return p;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function injectStyles() {
    if (document.getElementById('office-view-styles')) return;
    const style = document.createElement('style');
    style.id = 'office-view-styles';
    style.textContent = `
    .of-view { display: flex; flex-direction: column; height: 100%; min-height: 0;
        color: var(--text-color); background: var(--bg-color); font-size: 13px; }

    .of-head { display: flex; align-items: center; gap: 10px; flex-shrink: 0;
        padding: 6px 12px; border-bottom: 1px solid var(--border-color); overflow: hidden; }
    .of-badge { font-size: 11px; font-weight: 600; letter-spacing: .02em;
        padding: 2px 8px; border-radius: 10px; flex-shrink: 0;
        border: 1px solid var(--border-color); color: var(--text-secondary, inherit); opacity: .85; }
    .of-spacer { flex: 1 1 auto; }
    .of-note { font-size: 11px; opacity: .7; white-space: nowrap; flex-shrink: 0; }
    .of-btn { font: inherit; font-size: 11px; padding: 3px 10px; cursor: pointer;
        border: 1px solid var(--border-color); border-radius: 4px;
        background: transparent; color: inherit; flex-shrink: 0; }
    .of-btn:hover { background: var(--hover-color); }
    .of-btn.active { background: var(--hover-color); border-color: var(--text-secondary, var(--border-color)); }

    .of-tabs { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: thin; min-width: 0; }
    .of-tab { font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
        white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis;
        border: 1px solid transparent; border-radius: 4px 4px 0 0;
        background: transparent; color: inherit; opacity: .7; }
    .of-tab:hover { background: var(--hover-color); opacity: 1; }
    .of-tab.active { opacity: 1; font-weight: 600;
        background: var(--hover-color); border-color: var(--border-color); border-bottom-color: transparent; }

    .of-body { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; }
    .of-empty { margin: auto; padding: 24px; opacity: .7; }

    /* --- workbook grid --- */
    .of-grid { flex: 1 1 auto; overflow: auto; position: relative;
        font-family: var(--editor-font-family, monospace); font-size: 12px; }
    .of-grid-head { display: flex; position: sticky; top: 0; z-index: 3;
        background: var(--bg-color); border-bottom: 1px solid var(--border-color); }
    .of-grid-canvas { position: relative; }
    .of-grid-rows { position: absolute; top: 0; left: 0; }
    /* The row carries its own height and line-height: they are only all the
       same when the sheet says so. */
    .of-row { display: flex; height: ${ROW_HEIGHT}px; line-height: ${ROW_HEIGHT}px; }
    .of-row:hover { background: var(--hover-color); }
    /* Clipped, never an ellipsis. No spreadsheet has ever shown one: a value
       too long for its column runs across the empty cells beside it and is cut
       at the first one with something in it. The tooltip still has all of it. */
    .of-cell, .of-col, .of-gutter {
        height: 100%; line-height: inherit; padding: 0 8px;
        box-sizing: border-box; overflow: hidden; white-space: pre;
        text-overflow: clip; flex: 0 0 auto;
        border-right: 1px solid var(--border-color);
        border-bottom: 1px solid var(--border-color);
    }
    /* The faint background grid, which the sheet can ask to be without. Real
       borders are set on the element and win, because they are more specific
       than the shared rule below. */
    .of-grid.no-grid .of-cell { border-color: transparent; }
    /* Search hits. Every match is tinted and the current one is outlined, so
       "where else is this" and "where am I" are answered at the same time. */
    .of-cell.of-hit, .of-merge.of-hit {
        background: color-mix(in srgb, var(--primary-color, #3b82f6) 22%, transparent);
    }
    .of-cell.of-hit-active, .of-merge.of-hit-active {
        background: color-mix(in srgb, var(--primary-color, #3b82f6) 45%, transparent);
        outline: 2px solid var(--primary-color, #3b82f6);
        outline-offset: -2px;
    }
    .of-hit-active { background: color-mix(in srgb, var(--primary-color, #3b82f6) 30%, transparent); }
    /* The fill makes a multi-cell selection readable even when a sheet has
       disabled its gridlines; the separate overlay below supplies its single,
       unbroken Excel-style edge across virtualised rows and merged cells. */
    .of-cell.of-selected {
        background: color-mix(in srgb, var(--primary-color, #3b82f6) 16%, transparent);
    }
    .of-cell.num, .of-cell.h-right { text-align: right; }
    .of-cell.h-left { text-align: left; }
    .of-cell.h-center { text-align: center; }
    /* A wrapped cell is the one place a row shows more than one line, so it
       cannot ride on the row's line-height. */
    .of-cell.wrap { white-space: pre-wrap; line-height: 1.35; padding-top: 2px;
        display: flex; flex-direction: column; justify-content: center; }
    .of-cell.wrap.v-top { justify-content: flex-start; }
    .of-cell.wrap.v-bottom { justify-content: flex-end; }
    .of-pad { flex: 0 0 auto; height: 100%; }
    /* Narrow padding and no ellipsis: a grid-paper sheet's columns are 23px
       wide, and "A…" in the header of every one of them is noise where the
       letter itself would have fitted. */
    .of-col { height: ${ROW_HEIGHT}px; line-height: ${ROW_HEIGHT}px; padding: 0 2px;
        text-overflow: clip; text-align: center; font-weight: 600;
        opacity: .7; background: var(--bg-color); }
    /* The grip overhangs the column edge by half its width, so the target is
       the line itself rather than the inside of one cell. */
    .of-col { position: relative; }
    .of-col-grip {
        position: absolute; top: 0; right: -3px; width: 7px; height: 100%;
        cursor: col-resize; z-index: 5;
    }
    .of-col-grip:hover {
        background: var(--primary-color, #3b82f6);
        opacity: .5;
    }
    /* On the grid, not on the grip: the grip is rebuilt on every repaint, and
       a drag repaints continuously. */
    .of-grid.col-resizing { cursor: col-resize; user-select: none; }
    .of-grid.col-resizing .of-col-grip {
        background: var(--primary-color, #3b82f6);
        opacity: .5;
    }
    .of-row-gutter { position: sticky; }
    .of-row-grip {
        position: absolute; left: 0; bottom: -3px; width: 100%; height: 7px;
        cursor: row-resize; z-index: 5;
    }
    .of-row-grip:hover {
        background: var(--primary-color, #3b82f6); opacity: .5;
    }
    .of-grid.row-resizing { cursor: row-resize; user-select: none; }
    .of-grid.row-resizing .of-row-grip {
        background: var(--primary-color, #3b82f6); opacity: .5;
    }
    .of-gutter { width: ${GUTTER_WIDTH}px; text-align: right; opacity: .55;
        position: sticky; left: 0; z-index: 2; background: var(--bg-color); }
    .of-corner { z-index: 4; }

    /* Merged cells, drawn over the rows. Opaque, so the gridlines of the cells
       underneath do not show through the middle of a box. */
    .of-merges { position: absolute; top: 0; left: 0; }
    .of-merge {
        position: absolute; box-sizing: border-box; padding: 0 8px;
        display: flex; flex-direction: column; justify-content: center;
        overflow: hidden; white-space: pre;
        background: var(--bg-color);
    }
    /* Horizontal alignment is on the text, vertical on the flex box, so the
       two do not have to agree about which axis they are using. */
    .of-merge.num, .of-merge.h-right { text-align: right; }
    .of-merge.h-center { text-align: center; }
    .of-merge.h-left { text-align: left; }
    .of-merge.v-top { justify-content: flex-start; }
    .of-merge.v-bottom { justify-content: flex-end; }
    .of-merge.wrap { white-space: pre-wrap; line-height: 1.35; }
    .of-selection {
        position: absolute; box-sizing: border-box; pointer-events: none;
        z-index: 4; border: 2px solid var(--primary-color, #3b82f6);
        background: color-mix(in srgb, var(--primary-color, #3b82f6) 8%, transparent);
    }

    /* --- deck --- */
    .of-slides { flex: 1 1 auto; overflow: auto; padding: 16px 20px 40px; }
    .of-slide { max-width: 900px; margin: 0 auto 14px;
        border: 1px solid var(--border-color); border-radius: 6px; padding: 14px 18px; }
    .of-slide-head { display: flex; align-items: baseline; gap: 10px; }
    .of-slide-num { font-size: 11px; font-weight: 700; opacity: .5; min-width: 22px; }
    .of-slide-title { font-size: 16px; margin: 0 0 2px; font-weight: 600; }
    .of-slide-title.untitled { opacity: .45; font-weight: 400; font-style: italic; }
    .of-slide-none { margin: 8px 0 0; font-size: 12px; opacity: .5; font-style: italic; }
    .of-banner { max-width: 900px; margin: 0 auto 14px; padding: 10px 14px; font-size: 12px;
        border: 1px dashed var(--border-color); border-radius: 6px; opacity: .8; }
    .of-bullets { margin: 8px 0 0; padding-left: 20px; line-height: 1.6; }
    .of-bullets li { margin: 2px 0; }
    .of-notes { margin-top: 10px; font-size: 12px; opacity: .8; }
    .of-notes summary { cursor: pointer; opacity: .7; }
    .of-notes > div { margin-top: 6px; white-space: pre-wrap; padding-left: 14px;
        border-left: 2px solid var(--border-color); }

    /* --- document --- */
    .of-doc { flex: 1 1 auto; overflow: auto; padding: 24px 28px 60px;
        max-width: 820px; margin: 0 auto; line-height: 1.75; }
    .of-doc-h { margin: 1.4em 0 .5em; line-height: 1.35; }
    .of-doc-h:first-child { margin-top: 0; }
    .of-doc-p { margin: 0 0 .85em; white-space: pre-wrap; }
    .of-doc-list { margin: 0 0 .85em; padding-left: 22px; }
    .of-doc-list li { margin: .15em 0; }
    .of-doc-table { border-collapse: collapse; margin: 0 0 1.2em; font-size: 12px; width: 100%; }
    .of-doc-table th, .of-doc-table td {
        border: 1px solid var(--border-color); padding: 5px 8px;
        text-align: left; vertical-align: top; white-space: pre-wrap; }
    .of-doc-table th { font-weight: 600; background: var(--hover-color); }
    `;
    document.head.appendChild(style);
}
