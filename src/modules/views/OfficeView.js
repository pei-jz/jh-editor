import { invoke } from '@tauri-apps/api/core';
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
const MIN_COL_WIDTH = 64;
const MAX_COL_WIDTH = 320;
/** Rows sampled when sizing columns. Measuring 5000 of them to pick a width
 *  costs more than the draw it is meant to speed up. */
const WIDTH_SAMPLE = 200;
/** Document blocks appended per frame, so a long report paints instead of
 *  freezing the window until the last paragraph is built. */
const BLOCKS_PER_FRAME = 300;

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
            tab.title = sheet.name;
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

        this.colWidths = measureColumns(rows);
        this.colOffsets = [0];
        for (const w of this.colWidths) {
            this.colOffsets.push(this.colOffsets[this.colOffsets.length - 1] + w);
        }
        const totalWidth = this.colOffsets[this.colOffsets.length - 1] + GUTTER_WIDTH;

        const grid = document.createElement('div');
        grid.className = 'of-grid';

        const head = document.createElement('div');
        head.className = 'of-grid-head';
        head.style.width = `${totalWidth}px`;

        const canvas = document.createElement('div');
        canvas.className = 'of-grid-canvas';
        canvas.style.width = `${totalWidth}px`;

        const rowsEl = document.createElement('div');
        rowsEl.className = 'of-grid-rows';
        canvas.appendChild(rowsEl);

        grid.append(head, canvas);
        this.bodyEl.appendChild(grid);

        this.gridEl = grid;
        this.gridHeadEl = head;
        this.gridRowsEl = rowsEl;
        this.gridCanvasEl = canvas;
        this.sheetRows = rows;

        this.scroller = new VirtualScroll(grid, rows.length, ROW_HEIGHT, (info) => this._paintRows(info));

        // Columns are windowed as well as rows, so a sideways scroll has to
        // repaint even though the visible row range has not moved.
        this._lastScrollLeft = 0;
        this._onHScroll = () => {
            if (grid.scrollLeft === this._lastScrollLeft) return;
            this._lastScrollLeft = grid.scrollLeft;
            this.scroller.onScroll();
        };
        grid.addEventListener('scroll', this._onHScroll);
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
            this.gridHeadEl.appendChild(h);
        }

        const frag = document.createDocumentFragment();
        for (let r = startIndex; r <= endIndex; r++) {
            const row = this.sheetRows[r];
            if (!row) continue;
            const el = document.createElement('div');
            el.className = 'of-row';
            el.appendChild(cell('of-gutter', String(r + 1)));
            el.appendChild(spacerCell(pad));
            for (let c = cols.start; c <= cols.end; c++) {
                const value = row[c] || '';
                const text = oneLine(value);
                const td = cell(isNumeric(value) ? 'of-cell num' : 'of-cell', text);
                td.style.width = `${this.colWidths[c]}px`;
                // The tooltip carries what the cell itself cannot: the tail of
                // a long value, and the line breaks folded out of it.
                if (text !== value || value.length > 12) td.title = value;
                el.appendChild(td);
            }
            frag.appendChild(el);
        }
        this.gridRowsEl.innerHTML = '';
        this.gridRowsEl.appendChild(frag);
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

    // -- housekeeping ------------------------------------------------------

    _empty(message) {
        this.bodyEl.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'of-empty';
        el.textContent = message;
        this.bodyEl.appendChild(el);
    }

    _teardownScroller() {
        if (this.gridEl && this._onHScroll) {
            this.gridEl.removeEventListener('scroll', this._onHScroll);
        }
        if (this.scroller) {
            this.scroller.destroy();
            this.scroller = null;
        }
        this.gridEl = null;
        this.gridRowsEl = null;
        this.gridHeadEl = null;
        this.gridCanvasEl = null;
    }

    focus() {
        if (this.bodyEl) this.bodyEl.focus?.();
    }

    destroy() {
        if (this.pending) {
            cancelAnimationFrame(this.pending);
            this.pending = null;
        }
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
    .of-row { display: flex; height: ${ROW_HEIGHT}px; }
    .of-row:hover { background: var(--hover-color); }
    .of-cell, .of-col, .of-gutter {
        height: ${ROW_HEIGHT}px; line-height: ${ROW_HEIGHT - 2}px; padding: 0 8px;
        box-sizing: border-box; overflow: hidden; white-space: pre;
        text-overflow: ellipsis; flex: 0 0 auto;
        border-right: 1px solid var(--border-color);
        border-bottom: 1px solid var(--border-color);
    }
    .of-cell.num { text-align: right; }
    .of-pad { flex: 0 0 auto; height: ${ROW_HEIGHT}px; }
    .of-col { text-align: center; font-weight: 600; opacity: .7; background: var(--bg-color); }
    .of-gutter { width: ${GUTTER_WIDTH}px; text-align: right; opacity: .55;
        position: sticky; left: 0; z-index: 2; background: var(--bg-color); }
    .of-corner { z-index: 4; }

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
