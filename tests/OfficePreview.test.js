import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extensionOf, isOfficeFile, officeKind } from '../src/modules/utils/Office.js';

/* Opening a spreadsheet to look at one column meant waiting for Excel. The
   preview exists to remove that wait, which puts two things at risk that a
   passing build would not show:

   - a file routed to the wrong reader. An .xlsx read as text is mojibake; a
     .doc routed to a preview that cannot read it is a dead click. The
     extension list is the whole of that decision, so it is tested first.
   - a grid that draws all of it. Five thousand rows by two hundred columns is
     a million cells, and building them is the freeze the feature promised to
     remove. The view windows both axes; these tests watch the window. */

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }));

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('which files get the Office preview', () => {
    it('reads the extension off a path, not off the folders above it', () => {
        expect(extensionOf('C:\\work\\2026.Q1\\report.xlsx')).toBe('xlsx');
        expect(extensionOf('/home/a/b.d/notes')).toBe('');
        // A dotfile's leading dot names the file; it is not an extension.
        expect(extensionOf('.gitignore')).toBe('');
        expect(extensionOf('Book.XLSX')).toBe('xlsx');
    });

    it('claims only the formats there is a reader for', () => {
        for (const p of ['a.xlsx', 'a.xlsm', 'a.xls', 'a.ods', 'a.docx', 'a.pptx']) {
            expect(isOfficeFile(p), p).toBe(true);
        }
        // The pre-2007 binary formats have no reader here. Claiming them would
        // route the file into a preview whose only possible outcome is an error.
        for (const p of ['a.doc', 'a.ppt', 'a.pdf', 'a.csv', 'a.md', 'xlsx']) {
            expect(isOfficeFile(p), p).toBe(false);
        }
    });

    it('names the shape the preview will take', () => {
        expect(officeKind('q1.xlsx')).toBe('sheets');
        expect(officeKind('deck.pptx')).toBe('slides');
        expect(officeKind('spec.docx')).toBe('document');
        expect(officeKind('readme.md')).toBe(null);
    });

    // The explorer hid every Office extension as "binary". With the preview in
    // place that hides the feature: the file cannot be clicked because it is
    // not drawn.
    it('is no longer filtered out of the explorer listing', () => {
        const src = read('src/modules/utils/FileSystem.js');
        const list = src.slice(src.indexOf('BINARY_EXTENSIONS'), src.indexOf('return entries.filter'));
        for (const ext of ['xlsx', 'xls', 'ods', 'docx', 'pptx']) {
            expect(list, `${ext} should not be hidden`).not.toContain(`'${ext}'`);
        }
        // …and the ones with no reader still are.
        for (const ext of ['doc', 'ppt', 'pdf']) {
            expect(list, `${ext} should stay hidden`).toContain(`'${ext}'`);
        }
    });

    // Quick-open (Ctrl+P) reads its own list, in Rust. A file that opens but
    // cannot be found by name is a feature nobody discovers.
    it('is findable by name in quick-open', () => {
        const src = read('src-tauri/src/commands/search.rs');
        const list = src.slice(src.indexOf('let binary_exts'), src.indexOf('.into_iter().collect()'));
        for (const ext of ['xlsx', 'docx', 'pptx']) {
            expect(list, `${ext} should be listed`).not.toContain(`"${ext}"`);
        }
        expect(list).toContain('"doc"');
        expect(list).toContain('"ppt"');
    });
});

describe('the grid helpers', () => {
    let columnName, isNumeric, measureColumns, oneLine, textWidth;
    let coverageByRow, isCovered, applyBorders, applyMergeBorders;

    beforeAll(async () => {
        ({ columnName, isNumeric, measureColumns, oneLine, textWidth } =
            await import('../src/modules/views/OfficeView.js'));
        ({ coverageByRow, isCovered, applyBorders, applyMergeBorders } =
            await import('../src/modules/views/OfficeView.js'));
    });

    it('labels columns the way a spreadsheet does', () => {
        expect(columnName(0)).toBe('A');
        expect(columnName(25)).toBe('Z');
        // The carry is the part that is easy to get wrong: after Z comes AA,
        // not BA, and 51 is AZ rather than AA again.
        expect(columnName(26)).toBe('AA');
        expect(columnName(51)).toBe('AZ');
        expect(columnName(52)).toBe('BA');
        expect(columnName(701)).toBe('ZZ');
        expect(columnName(702)).toBe('AAA');
    });

    it('right-aligns numbers without right-aligning things that merely start with one', () => {
        expect(isNumeric('42')).toBe(true);
        expect(isNumeric('-3.5')).toBe(true);
        expect(isNumeric('1,204')).toBe(true);
        expect(isNumeric('12%')).toBe(true);
        // An order code and a date are text. Aligning them right makes a column
        // of identifiers look like a column of quantities.
        expect(isNumeric('2026-01-04')).toBe(false);
        expect(isNumeric('12 units')).toBe(false);
        expect(isNumeric('')).toBe(false);
    });

    it('folds a multi-line value onto the one line a row has room for', () => {
        // Rows are a fixed height so they can be virtualised. Left alone, the
        // second and third lines would be drawn below the cell and clipped —
        // data in the file, invisible on screen, with nothing to say so.
        expect(oneLine('one\ntwo\nthree')).toBe('one two three');
        expect(oneLine('a\r\n  b')).toBe('a b');
        expect(oneLine('plain')).toBe('plain');
        expect(oneLine('')).toBe('');
    });

    it('gives a Japanese column the width its characters actually take', () => {
        // Counting characters and multiplying cut every Japanese column short:
        // a kanji is nearly twice a Latin letter wide.
        expect(textWidth('MMMM')).toBeCloseTo(4 * 6.6, 1);
        expect(textWidth('六角')).toBeCloseTo(2 * 12, 1);
        // Half-width katakana is half-width — that is the whole point of it.
        expect(textWidth('ｱｲ')).toBeLessThan(textWidth('アイ'));

        const [latin, japanese] = measureColumns([['Bolt', '六角ボルト']]);
        expect(japanese).toBeGreaterThan(latin);

        // A column measured on the folded text, not on the raw value: the
        // line breaks are gone by the time it is drawn.
        const [folded] = measureColumns([['ab\ncd']]);
        expect(folded).toBe(measureColumns([['ab cd']])[0]);
    });

    it('sizes a column to its content, within limits', () => {
        const narrow = measureColumns([['a'], ['b']]);
        // An empty-ish column still has to be wide enough to hold a header.
        expect(narrow[0]).toBeGreaterThanOrEqual(64);

        const wide = measureColumns([['x'.repeat(400)]]);
        // One cell holding a paragraph must not push every other column off
        // the screen.
        expect(wide[0]).toBeLessThanOrEqual(320);

        const mixed = measureColumns([['short', 'a much longer value here']]);
        expect(mixed[1]).toBeGreaterThan(mixed[0]);

        // Rows past the sample are not measured — that is the point of the
        // sample — so a late long value does not re-size the column.
        const sampled = measureColumns([['ab'], ['x'.repeat(100)]], 1);
        expect(sampled[0]).toBe(64);
    });

    it('knows which cells a merge has swallowed', () => {
        // Stored once per ROW a merge crosses, not once per cell: a range
        // twenty columns wide has to cost the same as one two columns wide.
        const cover = coverageByRow([
            { row: 1, col: 2, rows: 2, cols: 3 },
            { row: 1, col: 9, rows: 1, cols: 2 },
        ]);
        expect([...cover.keys()].sort()).toEqual([1, 2]);

        const first = cover.get(1);
        expect(isCovered(first, 1)).toBe(false);
        // The anchor is covered too: the text is drawn once, by the box.
        expect(isCovered(first, 2)).toBe(true);
        expect(isCovered(first, 4)).toBe(true);
        expect(isCovered(first, 5)).toBe(false);
        expect(isCovered(first, 10)).toBe(true);

        // The second row of the taller merge, but not the shorter one.
        expect(isCovered(cover.get(2), 3)).toBe(true);
        expect(isCovered(cover.get(2), 9)).toBe(false);

        expect(coverageByRow([]).size).toBe(0);
        expect(coverageByRow(undefined).size).toBe(0);
    });

    it('draws one line where two cells share an edge', () => {
        // Both cells declare the edge between them. Drawing both puts two
        // lines where the sheet has one, and every table comes out with
        // double-thickness inner rules.
        const el = () => ({ style: {} });
        const thin = { top: 'thin', right: 'thin', bottom: 'thin', left: 'thin' };

        const middle = el();
        applyBorders(middle, thin, { right: 'thin' }, { bottom: 'thin' });
        expect(middle.style.borderRight).toContain('1px solid');
        expect(middle.style.borderBottom).toContain('1px solid');
        // The neighbours already drew these two.
        expect(middle.style.borderLeft).toBeUndefined();
        expect(middle.style.borderTop).toBeUndefined();

        // At the edge of the sheet there is no neighbour to defer to.
        const corner = el();
        applyBorders(corner, thin, null, null);
        expect(corner.style.borderLeft).toContain('1px solid');
        expect(corner.style.borderTop).toContain('1px solid');

        // A neighbour that declares nothing does not cover for this cell.
        const beside = el();
        applyBorders(beside, thin, { right: '' }, { bottom: '' });
        expect(beside.style.borderLeft).toContain('1px solid');
    });

    it('gives a merged box the outline of the range, not of its first cell', () => {
        // The anchor's own right border is an edge INSIDE the box; drawing it
        // there puts a line through the middle of every wide heading.
        const box = { style: {} };
        applyMergeBorders(box, { top: 'thin', left: 'thick', right: 'double', bottom: '' });
        expect(box.style.borderTop).toContain('1px solid');
        expect(box.style.borderLeft).toContain('2px solid');
        expect(box.style.borderRight).toContain('double');
        expect(box.style.borderBottom).toBeUndefined();
    });
});

describe('the preview view', () => {
    let OfficeView;
    let container;
    let originalResizeObserver;
    let originalRaf;
    let originalScrollIntoView;

    beforeAll(async () => {
        originalResizeObserver = global.ResizeObserver;
        global.ResizeObserver = class {
            constructor() { this.observe = vi.fn(); this.unobserve = vi.fn(); this.disconnect = vi.fn(); }
        };
        // jsdom never paints, so the document's chunked build would stop after
        // the first frame. Run it straight through instead.
        originalRaf = global.requestAnimationFrame;
        global.requestAnimationFrame = (fn) => { fn(); return 1; };
        // jsdom lays nothing out and so implements no scrolling. The view
        // calls it for real; here it only has to not throw.
        originalScrollIntoView = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function () {};
        OfficeView = (await import('../src/modules/views/OfficeView.js')).OfficeView;
    });

    afterAll(() => {
        global.ResizeObserver = originalResizeObserver;
        global.requestAnimationFrame = originalRaf;
        Element.prototype.scrollIntoView = originalScrollIntoView;
    });

    beforeEach(() => {
        document.body.innerHTML = '<div id="pane" style="height:400px"></div>';
        container = document.getElementById('pane');
    });

    const show = (office, path = 'C:/work/book.xlsx') => {
        const view = new OfficeView(container, {});
        const file = { path, content: '', type: 'office', office };
        view.render('', file);
        return { view, file };
    };

    const sheetsPreview = (overrides = {}) => ({
        kind: 'sheets',
        sheets: [
            {
                name: 'Orders',
                rows: [['Item', 'Qty'], ['Bolt', '12']],
                total_rows: 2, total_cols: 2, truncated: false,
                error: null, layout: null,
            },
            {
                name: 'Notes',
                rows: [['read me']],
                total_rows: 1, total_cols: 1, truncated: false,
                error: null, layout: null,
            },
        ],
        slides: [], blocks: [],
        ...overrides,
    });

    it('says it is read-only before it says anything else', () => {
        show(sheetsPreview());
        // The one thing a reader must not be wrong about. A grid that looks
        // like the CSV editor and silently drops edits would be worse than no
        // preview at all.
        expect(container.querySelector('.of-badge').textContent).toMatch(/read-only/i);
    });

    it('draws a sheet as a grid with spreadsheet coordinates', () => {
        show(sheetsPreview());
        const head = [...container.querySelectorAll('.of-grid-head .of-col')].map(e => e.textContent);
        expect(head).toEqual(['A', 'B']);

        const rows = [...container.querySelectorAll('.of-row')];
        expect(rows).toHaveLength(2);
        // The gutter carries the sheet's own 1-based row number, so a value
        // seen here can be found again in Excel.
        expect(rows[0].querySelector('.of-gutter').textContent).toBe('1');
        expect(rows[1].querySelector('.of-gutter').textContent).toBe('2');
        expect([...rows[1].querySelectorAll('.of-cell')].map(e => e.textContent))
            .toEqual(['Bolt', '12']);
        // "12" is a quantity; "Bolt" is not.
        expect(rows[1].querySelectorAll('.of-cell')[1].className).toContain('num');
    });

    it('moves between sheets on Ctrl+PageUp and Ctrl+PageDown', () => {
        // Excel's own keys. Nothing in a read-only preview holds the focus —
        // no text box, no caret — so the key is caught on the window.
        const { view, file } = show(sheetsPreview());
        const active = () => container.querySelector('.of-tab.active').textContent;
        const key = (k, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', {
            key: k, ctrlKey: true, bubbles: true, cancelable: true, ...opts,
        }));

        expect(active()).toBe('Orders');
        key('PageDown');
        expect(active()).toBe('Notes');
        expect(file._officeSheet).toBe(1);

        // Excel stops at the ends. Wrapping turns "I am on the last sheet"
        // into a silent jump back to the first.
        key('PageDown');
        expect(active()).toBe('Notes');
        key('PageUp');
        expect(active()).toBe('Orders');

        // Without Ctrl it is scrolling, and must stay scrolling.
        key('PageDown', { ctrlKey: false });
        expect(active()).toBe('Orders');
        view.destroy();
    });

    it('leaves the keys alone while someone is typing', () => {
        const { view } = show(sheetsPreview());
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();

        window.dispatchEvent(new KeyboardEvent('keydown',
            { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }));
        expect(container.querySelector('.of-tab.active').textContent).toBe('Orders');

        input.remove();
        view.destroy();
    });

    it('answers only for the pane being looked at', () => {
        // A split editor can have two previews open; one of them is not the
        // one the keys are meant for.
        const pane = document.createElement('div');
        pane.className = 'editor-pane';
        document.body.appendChild(pane);
        const host = document.createElement('div');
        pane.appendChild(host);

        const view = new OfficeView(host, {});
        view.render('', { path: 'C:/w/b.xlsx', content: '', type: 'office', office: sheetsPreview() });

        window.dispatchEvent(new KeyboardEvent('keydown',
            { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }));
        expect(host.querySelector('.of-tab.active').textContent).toBe('Orders');

        pane.classList.add('active');
        window.dispatchEvent(new KeyboardEvent('keydown',
            { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }));
        expect(host.querySelector('.of-tab.active').textContent).toBe('Notes');

        view.destroy();
        pane.remove();
    });

    it('stops listening once the tab is gone', () => {
        // A window listener outlives the element it was added for.
        const { view, file } = show(sheetsPreview());
        view.destroy();
        window.dispatchEvent(new KeyboardEvent('keydown',
            { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }));
        expect(file._officeSheet).toBeUndefined();
    });

    /* Walking a sheet with the arrows, and the scrolling that has to come with
       it. A grid that moves a selection it will not scroll to is worse than one
       that does not move at all: the reader loses the cell and has no way to
       find it again short of dragging the bar. */
    describe('walking the cells with the arrow keys', () => {
        // 20 rows of 20px and 10 columns of 100px, so every offset in these
        // tests is a number that can be checked by hand.
        const grid = (overrides = {}) => sheetsPreview({
            sheets: [{
                name: 'Grid',
                rows: Array.from({ length: 20 }, (_, r) =>
                    Array.from({ length: 10 }, (_, c) => `r${r}c${c}`)),
                total_rows: 20, total_cols: 10, truncated: false, error: null,
                layout: {
                    col_widths: Array(10).fill(100),
                    row_heights: Array(20).fill(20),
                    merges: [], styles: [], style_ids: [],
                    gridlines: true, default_col_width: 64,
                    ...overrides,
                },
            }],
        });

        // jsdom lays nothing out, so a viewport has to be declared for the
        // "is it off the bottom" arithmetic to have anything to compare with.
        const viewport = (view, { height = 100, width = 300 } = {}) => {
            Object.defineProperty(view.gridEl, 'clientHeight', { value: height, configurable: true });
            Object.defineProperty(view.gridEl, 'clientWidth', { value: width, configurable: true });
        };

        const press = (key, opts = {}) => {
            const e = new KeyboardEvent('keydown',
                { key, bubbles: true, cancelable: true, ...opts });
            window.dispatchEvent(e);
            return e;
        };

        it('lands on the cell already in view instead of jumping home', () => {
            // Excel always has an active cell and this preview starts without
            // one, so the first press has to invent it. Inventing A1 would
            // throw a reader who had scrolled to row 400 back to the top.
            const { view } = show(grid());
            viewport(view);
            view.gridEl.scrollTop = 200;

            press('ArrowDown');
            expect(view.selection.focus).toEqual({ r: 10, c: 0 });
            expect(view.gridEl.scrollTop, 'the sheet should not have moved').toBe(200);
            view.destroy();
        });

        it('moves one cell per press, in all four directions', () => {
            const { view } = show(grid());
            viewport(view);
            press('ArrowDown');            // lands on r0c0
            press('ArrowDown');
            press('ArrowRight');
            press('ArrowRight');
            expect(view.selection.focus).toEqual({ r: 1, c: 2 });
            press('ArrowUp');
            press('ArrowLeft');
            expect(view.selection.focus).toEqual({ r: 0, c: 1 });
            // Moving collapses the range: only extending keeps the far corner.
            expect(view.selection.anchor).toEqual({ r: 0, c: 1 });
            view.destroy();
        });

        it('stops at the edges rather than wrapping', () => {
            const { view } = show(grid());
            viewport(view);
            press('ArrowDown');
            press('ArrowUp');
            press('ArrowLeft');
            expect(view.selection.focus).toEqual({ r: 0, c: 0 });
            view.destroy();
        });

        it('stretches the range on Shift and leaves the anchor alone', () => {
            const { view } = show(grid());
            viewport(view);
            press('ArrowDown');
            press('ArrowDown', { shiftKey: true });
            press('ArrowRight', { shiftKey: true });
            expect(view.selection.anchor).toEqual({ r: 0, c: 0 });
            expect(view.selection.focus).toEqual({ r: 1, c: 1 });
            expect(container.querySelectorAll('.of-cell.of-selected')).toHaveLength(4);
            view.destroy();
        });

        it('scrolls the least that brings the cell back into view', () => {
            // The least, not to the middle. Re-centring on every press moves
            // the rows around the cell under the eye, and reading down the
            // column is what the reader is doing.
            const { view } = show(grid());
            viewport(view, { height: 100 });
            press('ArrowDown');                      // r0, nothing to scroll
            expect(view.gridEl.scrollTop).toBe(0);

            for (let i = 0; i < 5; i++) press('ArrowDown');
            // Row 5 spans 100..120; the bottom of it sits on the bottom edge.
            expect(view.selection.focus.r).toBe(5);
            expect(view.gridEl.scrollTop).toBe(20);

            press('ArrowDown');
            expect(view.gridEl.scrollTop).toBe(40);

            // Coming back up stops as soon as the cell's top edge is on screen.
            for (let i = 0; i < 6; i++) press('ArrowUp');
            expect(view.selection.focus.r).toBe(0);
            expect(view.gridEl.scrollTop).toBe(0);
            view.destroy();
        });

        it('scrolls sideways past the sticky row numbers', () => {
            // The gutter floats over the left edge of the window, so a column
            // tucked underneath it is not visible however much of it is inside
            // the scroll box.
            const { view } = show(grid());
            viewport(view, { width: 300 });
            press('ArrowRight');
            for (let i = 0; i < 3; i++) press('ArrowRight');
            expect(view.selection.focus.c).toBe(3);
            // Columns are 100 wide and the gutter takes 52 of the 300: column 3
            // ends at 400, so 400 + 52 - 300 has to be scrolled away.
            expect(view.gridEl.scrollLeft).toBe(152);

            // Column 2 runs 200..300 and is already inside the window, so
            // coming back to it costs no scroll at all.
            press('ArrowLeft');
            expect(view.gridEl.scrollLeft).toBe(152);
            // Column 1 starts at 100, behind the left edge, so this one does.
            press('ArrowLeft');
            expect(view.gridEl.scrollLeft).toBe(100);
            view.destroy();
        });

        it('treats a merged box as one cell to step over', () => {
            // 設計書 sheets are mostly merges. Stepping into the middle of the
            // box the reader is already standing on looks exactly like the key
            // having done nothing.
            const { view } = show(grid({
                merges: [{ row: 2, col: 1, rows: 3, cols: 2 }],
            }));
            viewport(view);
            press('ArrowDown');                       // r0c0
            press('ArrowRight');                      // r0c1
            press('ArrowDown');
            press('ArrowDown');
            // Entered at the top-left of the box, the one cell carrying text.
            expect(view.selection.focus).toEqual({ r: 2, c: 1 });
            press('ArrowDown');
            expect(view.selection.focus, 'one press leaves the box').toEqual({ r: 5, c: 1 });
            press('ArrowUp');
            expect(view.selection.focus).toEqual({ r: 2, c: 1 });
            press('ArrowRight');
            expect(view.selection.focus, 'and one press crosses it').toEqual({ r: 2, c: 3 });
            view.destroy();
        });

        it('leaves the arrows to whoever else has the focus', () => {
            // The explorer walks its tree with the same four keys, and a
            // preview being on screen says nothing about where the reader is.
            const { view } = show(grid());
            viewport(view);
            const tree = document.createElement('div');
            tree.tabIndex = 0;
            document.body.appendChild(tree);
            tree.focus();

            const e = press('ArrowDown');
            expect(view.selection).toBe(null);
            expect(e.defaultPrevented).toBe(false);

            tree.remove();
            view.destroy();
        });

        it('leaves Ctrl+arrow to the browser rather than swallowing it', () => {
            // Excel's jump to the edge of the data is not implemented. Taking
            // the key to do nothing with it is worse than not taking it.
            const { view } = show(grid());
            viewport(view);
            press('ArrowDown');
            const before = { ...view.selection.focus };
            const e = press('ArrowDown', { ctrlKey: true });
            expect(view.selection.focus).toEqual(before);
            expect(e.defaultPrevented).toBe(false);
            view.destroy();
        });

        it('stops answering once the tab is gone', () => {
            const { view } = show(grid());
            viewport(view);
            press('ArrowDown');
            expect(view.selection).not.toBe(null);
            view.destroy();
            const e = press('ArrowDown');
            expect(e.defaultPrevented).toBe(false);
        });
    });

    it('offers every sheet and remembers which one was being read', () => {
        const { view, file } = show(sheetsPreview());
        const tabs = [...container.querySelectorAll('.of-tab')];
        expect(tabs.map(t => t.textContent)).toEqual(['Orders', 'Notes']);
        expect(tabs[0].className).toContain('active');

        tabs[1].click();
        expect(container.querySelector('.of-cell').textContent).toBe('read me');
        // Stored on the tab, not on the view: closing and reopening the pane
        // builds a new view, and landing back on sheet 1 loses the reader's
        // place every time they switch tabs.
        expect(file._officeSheet).toBe(1);
        view.destroy();
    });

    it('draws the sheet at the size the sheet says, not at the size of its text', () => {
        /* Sizing columns from their contents is a fair guess for a list of
           data and quite wrong for a document. A Japanese 設計書 is drawn on a
           grid of 2.5-character columns — 23px — with the boxes made of merged
           cells; measured and re-fitted, that comes out as a page nobody
           wrote. */
        show(sheetsPreview({
            sheets: [{
                name: 'Grid',
                rows: [['システム構成図', '', '', ''], ['', 'システム名', '', '']],
                total_rows: 2, total_cols: 4, truncated: false, error: null,
                layout: {
                    col_widths: [23, 23, 100, 23],
                    row_heights: [38, 20],
                    merges: [{ row: 1, col: 1, rows: 1, cols: 2 }],
                },
            }],
        }));

        const head = [...container.querySelectorAll('.of-grid-head .of-col')];
        expect(head.map(e => e.style.width)).toEqual(['23px', '23px', '100px', '23px']);

        const rows = [...container.querySelectorAll('.of-row')];
        // Points in the file, pixels on the screen: 28.5pt is 38px.
        expect(rows[0].style.height).toBe('38px');
        expect(rows[1].style.height).toBe('20px');
        // The line box follows the row, so one line of text sits in the middle
        // of a tall row instead of at the top of it.
        expect(rows[0].style.lineHeight).toBe('38px');
    });

    it('keeps declared row heights when another grid repaint happens', () => {
        const { view } = show(sheetsPreview({
            sheets: [{
                name: 'Heights', rows: [['title'], ['short'], ['tall']],
                total_rows: 3, total_cols: 1, truncated: false, error: null,
                layout: { col_widths: [80], row_heights: [25, 20, 93], merges: [] },
            }],
        }));

        view._setColumnWidth(0, 140); // Repaints the virtualised grid.
        expect([...container.querySelectorAll('.of-row')].map((row) => row.style.height))
            .toEqual(['25px', '20px', '93px']);
        view.destroy();
    });

    it('auto-fits wrapped content and recomputes it after a column resize', () => {
        const { view } = show(sheetsPreview({
            sheets: [{
                name: 'Wrapped',
                rows: [['A long description which has to wrap several times in a narrow cell.']],
                total_rows: 1, total_cols: 1, truncated: false, error: null,
                layout: {
                    col_widths: [60], row_heights: [20], merges: [],
                    styles: [{ wrap: false }, { wrap: true }], style_ids: [[1]],
                },
            }],
        }));

        const narrow = view.rowHeights[0];
        expect(narrow).toBeGreaterThan(20);
        expect(container.querySelector('.of-row').style.height).toBe(`${narrow}px`);

        view._setColumnWidth(0, 320);
        expect(view.rowHeights[0]).toBeLessThan(narrow);
        view.destroy();
    });

    it('lets a reader drag a row height and double-click back to auto-fit', () => {
        const { view, file } = show(sheetsPreview({
            sheets: [{
                name: 'Rows', rows: [['one'], ['two']],
                total_rows: 2, total_cols: 1, truncated: false, error: null,
                layout: { col_widths: [80], row_heights: [20, 20], merges: [] },
            }],
        }));

        expect(container.querySelectorAll('.of-row-grip')).toHaveLength(2);
        view._setRowHeight(0, 72);
        expect(view.rowHeights[0]).toBe(72);
        expect(file._officeRowHeights).toEqual({ 0: { 0: 72 } });
        expect(container.querySelector('.of-row').style.height).toBe('72px');

        view._autoFitRow(0);
        expect(view.rowHeights[0]).toBe(20);
        view.destroy();
    });

    it('joins merged cells into one box and empties what it covers', () => {
        show(sheetsPreview({
            sheets: [{
                name: 'Merged',
                rows: [['title', '', ''], ['a', 'b', 'c']],
                total_rows: 2, total_cols: 3, truncated: false, error: null,
                layout: {
                    col_widths: [50, 60, 70],
                    row_heights: [20, 20],
                    merges: [{ row: 0, col: 0, rows: 1, cols: 3 }],
                },
            }],
        }));

        const box = container.querySelector('.of-merge');
        expect(box, 'the merge should be drawn').toBeTruthy();
        expect(box.textContent).toBe('title');
        // Spans all three columns, starting after the row-number gutter.
        expect(box.style.width).toBe(`${50 + 60 + 70}px`);
        expect(box.style.top).toBe('0px');

        // The cells underneath are blank: the text belongs to the box, and
        // drawing it twice would show it through the box's own background.
        const first = [...container.querySelectorAll('.of-row')][0];
        expect([...first.querySelectorAll('.of-cell')].map(e => e.textContent))
            .toEqual(['', '', '']);
        // The row below is untouched.
        const second = [...container.querySelectorAll('.of-row')][1];
        expect([...second.querySelectorAll('.of-cell')].map(e => e.textContent))
            .toEqual(['a', 'b', 'c']);
    });

    it('draws the borders the sheet declares, and wraps where it says to', () => {
        show(sheetsPreview({
            sheets: [{
                name: 'Doc',
                rows: [['見出し', 'とても長い説明の文'], ['a', 'b']],
                total_rows: 2, total_cols: 2, truncated: false, error: null,
                layout: {
                    col_widths: [80, 120],
                    row_heights: [40, 20],
                    merges: [],
                    styles: [
                        { top: '', right: '', bottom: '', left: '', wrap: false, halign: '', valign: '' },
                        { top: 'thin', right: 'thin', bottom: 'thin', left: 'thin',
                          wrap: true, halign: 'center', valign: 'center' },
                    ],
                    style_ids: [[1, 1], [0, 0]],
                },
            }],
        }));

        const first = [...container.querySelectorAll('.of-row')][0];
        const cells = [...first.querySelectorAll('.of-cell')];
        expect(cells[0].className).toContain('h-center');
        expect(cells[0].className).toContain('wrap');
        expect(cells[0].style.borderTop).toContain('1px solid');
        // The cell to its right defers the shared edge to this one.
        expect(cells[1].style.borderLeft).toBe('');

        // An unstyled row keeps the plain grid.
        const second = [...container.querySelectorAll('.of-row')][1];
        expect([...second.querySelectorAll('.of-cell')][0].className).not.toContain('wrap');
    });

    it('lets a long value run across the empty cells beside it', () => {
        /* Excel spills text into the empty cells to its right and cuts it at
           the first one holding something — which is why no spreadsheet has
           ever shown an ellipsis. Cutting at the cell's own edge is what put
           "…" through the middle of every sentence in a document. */
        show(sheetsPreview({
            sheets: [{
                name: 'Spill',
                rows: [['a very long sentence indeed', '', '', 'stop'], ['x', 'y', '', '']],
                total_rows: 2, total_cols: 4, truncated: false, error: null,
                layout: { col_widths: [60, 60, 60, 60], row_heights: [20, 20], merges: [], styles: [], style_ids: [] },
            }],
        }));

        const rows = [...container.querySelectorAll('.of-row')];
        const first = [...rows[0].querySelectorAll('.of-cell')];
        // Two empty columns to run into, and then a cell with 'stop' in it.
        expect(first[0].style.clipPath).toBe('inset(0 -120px 0 0)');
        // Nothing to the right of 'stop'.
        expect(first[3].style.clipPath).toBe('');

        // 'x' is followed immediately by 'y': no room at all. 'y' has the two
        // empty columns after it, so it gets both.
        const second = [...rows[1].querySelectorAll('.of-cell')];
        expect(second[0].style.clipPath).toBe('');
        expect(second[1].style.clipPath).toBe('inset(0 -120px 0 0)');
    });

    it('starts with the grid the sheet asked for, and lets it be turned back on', () => {
        /* A sheet laid out as a document usually turns Excel's background grid
           off, and honouring that is most of the difference between "a
           spreadsheet" and the page its author saw. The button is for the
           other half of the time, reading across a wide row. */
        const { view } = show(sheetsPreview({
            sheets: [{
                name: 'Form', rows: [['a', 'b']],
                total_rows: 1, total_cols: 2, truncated: false, error: null,
                layout: {
                    col_widths: [60, 60], row_heights: [20], merges: [],
                    styles: [], style_ids: [], gridlines: false, default_col_width: 60,
                },
            }],
        }));

        const grid = container.querySelector('.of-grid');
        expect(grid.classList.contains('no-grid')).toBe(true);

        const btn = [...container.querySelectorAll('.of-btn')]
            .find(b => /gridlines/i.test(b.textContent));
        expect(btn).toBeTruthy();
        btn.click();
        expect(grid.classList.contains('no-grid')).toBe(false);
        btn.click();
        expect(grid.classList.contains('no-grid')).toBe(true);
        view.destroy();
    });

    it('leaves the grid on for a sheet that says nothing about it', () => {
        show(sheetsPreview());
        expect(container.querySelector('.of-grid').classList.contains('no-grid')).toBe(false);
    });

    it('carries the sheet out to the edge of the pane', () => {
        // Two narrow columns in a wide window left a strip of background to
        // the right of the last one, which reads as the sheet having been
        // broken off rather than having ended.
        const { view } = show(sheetsPreview({
            sheets: [{
                name: 'Narrow', rows: [['a', 'b']],
                total_rows: 1, total_cols: 2, truncated: false, error: null,
                layout: {
                    col_widths: [60, 60], row_heights: [20], merges: [],
                    styles: [], style_ids: [], gridlines: true, default_col_width: 50,
                },
            }],
        }));

        // jsdom lays nothing out, so the width has to be supplied — which is
        // also the first-paint case the ResizeObserver exists for.
        Object.defineProperty(view.gridEl, 'clientWidth', { value: 500, configurable: true });
        view._refitFiller();

        // 52 gutter + 60 + 60 = 172; eight more columns of 50 reach past 500.
        expect(view.dataCols).toBe(2);
        expect(view.colWidths.length).toBeGreaterThan(2);
        expect(view.colWidths.length).toBeLessThanOrEqual(2 + 64);

        // Narrowing gives the padding back rather than keeping it forever.
        Object.defineProperty(view.gridEl, 'clientWidth', { value: 100, configurable: true });
        view._refitFiller();
        expect(view.colWidths.length).toBe(2);
        view.destroy();
    });

    it('lets a column be resized, and remembers it for as long as the tab lives', () => {
        const { view, file } = show(sheetsPreview({
            sheets: [{
                name: 'S', rows: [['a', 'bbbb'], ['c', 'd']],
                total_rows: 2, total_cols: 2, truncated: false, error: null,
                layout: {
                    col_widths: [80, 120], row_heights: [20, 20], merges: [],
                    styles: [], style_ids: [], gridlines: true, default_col_width: 64,
                },
            }],
        }));

        view._setColumnWidth(1, 200);
        expect(view.colWidths[1]).toBe(200);
        // The offsets the padding is rebuilt from have to move with it, or the
        // merged boxes and the column window would be placed off the old grid.
        expect(view.dataOffsets).toEqual([0, 80, 280]);

        // On the tab, keyed by sheet — the same life as the chosen sheet, and
        // nothing is written to the file on disk.
        expect(file._officeColWidths).toEqual({ 0: { 1: 200 } });

        // It survives a repaint of the same sheet.
        view._renderSheet();
        expect(view.colWidths[1]).toBe(200);
        view.destroy();
    });

    it('keeps following the pointer after the repaint destroys the grip', () => {
        /* Changing a width repaints the header, and the header is rebuilt from
           scratch — so the grip the gesture started on leaves the document on
           the first move. Listeners on the grip went with it, and the column
           shifted a few pixels and then stopped dead. They belong on the
           window. */
        const { view } = show(sheetsPreview({
            sheets: [{
                name: 'S', rows: [['a', 'b']],
                total_rows: 1, total_cols: 2, truncated: false, error: null,
                layout: {
                    col_widths: [80, 120], row_heights: [20], merges: [],
                    styles: [], style_ids: [], gridlines: true, default_col_width: 64,
                },
            }],
        }));

        const grip = container.querySelectorAll('.of-col-grip')[1];
        expect(grip, 'the header should offer a grip').toBeTruthy();

        view._beginColumnDrag(1, 100);
        const move = (x) => window.dispatchEvent(
            new MouseEvent('pointermove', { clientX: x, bubbles: true }));

        // Many small moves, the way a real drag arrives — every one of them
        // repaints.
        for (let x = 110; x <= 300; x += 10) move(x);
        expect(container.contains(grip), 'the original grip is long gone').toBe(false);
        expect(view.colWidths[1]).toBe(320);

        window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        move(500);
        expect(view.colWidths[1], 'let go means let go').toBe(320);
        view.destroy();
    });

    it('will not resize the padding columns, which are not columns', () => {
        const { view, file } = show(sheetsPreview({
            sheets: [{
                name: 'S', rows: [['a']],
                total_rows: 1, total_cols: 1, truncated: false, error: null,
                layout: {
                    col_widths: [80], row_heights: [20], merges: [],
                    styles: [], style_ids: [], gridlines: true, default_col_width: 64,
                },
            }],
        }));

        Object.defineProperty(view.gridEl, 'clientWidth', { value: 400, configurable: true });
        view._refitFiller();
        expect(view.colWidths.length).toBeGreaterThan(1);

        // There is no column out there to make wider.
        view._setColumnWidth(view.dataCols, 300);
        expect(file._officeColWidths).toBeUndefined();
        view.destroy();
    });

    it('does not write the resized width back into the payload', () => {
        // colWidths used to BE the payload's array, so a drag edited the parsed
        // document and the padding columns were pushed onto it.
        const preview = sheetsPreview({
            sheets: [{
                name: 'S', rows: [['a', 'b']],
                total_rows: 1, total_cols: 2, truncated: false, error: null,
                layout: {
                    col_widths: [80, 120], row_heights: [20], merges: [],
                    styles: [], style_ids: [], gridlines: true, default_col_width: 64,
                },
            }],
        });
        const { view } = show(preview);
        view._setColumnWidth(0, 300);
        expect(preview.sheets[0].layout.col_widths).toEqual([80, 120]);
        view.destroy();
    });

    it('selects a cell range, expands it across a merge, and copies TSV', async () => {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        const { view, file } = show(sheetsPreview({
            sheets: [{
                name: 'Copy', rows: [['joined', '', 'c'], ['d', 'e', 'f']],
                total_rows: 2, total_cols: 3, truncated: false, error: null,
                layout: {
                    col_widths: [50, 50, 50], row_heights: [20, 20],
                    merges: [{ row: 0, col: 0, rows: 1, cols: 2 }],
                },
            }],
        }));

        // Selecting any part of the merge selects the complete merged cell.
        view._beginSelection(0, 1, new MouseEvent('pointerdown', { button: 0 }));
        view.selection.focus = { r: 1, c: 2 };
        view._rememberSelection();
        view.scroller.onScroll();
        expect(view._selectionBounds()).toEqual({ top: 0, bottom: 1, left: 0, right: 2 });
        expect(container.querySelector('.of-selection').style.width).toBe('150px');
        expect(file._officeSelections[0]).toEqual({
            anchor: { r: 0, c: 1 }, focus: { r: 1, c: 2 },
        });

        await view.copy();
        expect(writeText).toHaveBeenLastCalledWith('joined\t\tc\nd\te\tf');
        view.destroy();
    });

    it('measures from the content when the file says nothing about its shape', () => {
        // .xls and .ods keep their widths somewhere this cannot read, and a
        // sheet can simply not declare any. Both keep the old behaviour.
        show(sheetsPreview());
        const head = [...container.querySelectorAll('.of-grid-head .of-col')];
        expect(head.every(e => parseInt(e.style.width, 10) >= 64)).toBe(true);
    });

    it('finds text in a sheet and puts the match on screen', () => {
        /* The preview has no textarea for the search panel to work through,
           and a sheet has no running text to work through either — it is a
           grid of separate values. So the view finds its own matches and is
           told which one to show (the cell-grid protocol in ui/Search.js). */
        const { view } = show(sheetsPreview({
            sheets: [{
                name: 'S',
                rows: [['apple', 'pear'], ['apricot', 'plum'], ['fig', 'apple pie']],
                total_rows: 3, total_cols: 2, truncated: false, error: null,
                layout: null,
            }],
        }));

        expect(view.isCellGrid()).toBe(true);

        const hits = view.collectCellMatches((s2) => s2.includes('ap'));
        expect(hits).toEqual([{ r: 0, c: 0 }, { r: 1, c: 0 }, { r: 2, c: 1 }]);

        // Every match is tinted, so "where else is this" is answered at once.
        expect(container.querySelectorAll('.of-hit')).toHaveLength(3);
        expect(container.querySelectorAll('.of-hit-active')).toHaveLength(0);

        view.gotoCellMatch(hits[1]);
        const active = container.querySelectorAll('.of-hit-active');
        expect(active).toHaveLength(1);
        expect(active[0].textContent).toBe('apricot');

        // Clearing is the panel's own lifecycle: _cleanupSearch calls this
        // with an empty list when the query goes away.
        view.renderSearchHighlights([], 0);
        expect(container.querySelectorAll('.of-hit')).toHaveLength(0);
        view.destroy();
    });

    it('marks the merged box, not the hidden cell underneath it', () => {
        // A cell covered by a merge is drawn empty — the box holds the value.
        // Marking both put the active highlight on something invisible.
        const { view } = show(sheetsPreview({
            sheets: [{
                name: 'M', rows: [['joined', '', ''], ['x', 'y', 'z']],
                total_rows: 2, total_cols: 3, truncated: false, error: null,
                layout: {
                    col_widths: [50, 50, 50], row_heights: [20, 20],
                    merges: [{ row: 0, col: 0, rows: 1, cols: 3 }],
                    styles: [], style_ids: [], gridlines: true, default_col_width: 50,
                },
            }],
        }));

        const hits = view.collectCellMatches((s2) => s2 === 'joined');
        expect(hits).toEqual([{ r: 0, c: 0 }]);
        view.gotoCellMatch(hits[0]);

        const marked = [...container.querySelectorAll('.of-hit')];
        expect(marked).toHaveLength(1);
        expect(marked[0].className).toContain('of-merge');
        expect(marked[0].textContent).toBe('joined');
        view.destroy();
    });

    it('finds text on a slide and scrolls to the card holding it', () => {
        const { view } = show({
            kind: 'slides',
            sheets: [], blocks: [],
            slides: [
                { number: 1, title: 'Quarter in review', bullets: [], notes: '', pictures: 0 },
                { number: 2, title: 'Costs', bullets: [{ level: 0, text: 'Quarter on quarter' }],
                  notes: '', pictures: 0 },
            ],
        }, 'C:/w/deck.pptx');

        const hits = view.collectCellMatches((s2) => s2.includes('Quarter'));
        expect(hits).toHaveLength(2);
        // A negative column is how the grid protocol says "not a cell": r is
        // then an index into the text on the page.
        expect(hits[0]).toEqual({ r: 0, c: -1 });

        view.gotoCellMatch(hits[1]);
        const active = container.querySelectorAll('.of-hit-active');
        expect(active).toHaveLength(1);
        expect(active[0].textContent).toBe('Quarter on quarter');
        view.destroy();
    });

    it('says what it is not showing when a sheet was cut short', () => {
        show(sheetsPreview({
            sheets: [{
                name: 'Big', rows: [['a']], total_rows: 90000, total_cols: 1, truncated: true,
            }],
        }));
        const note = container.querySelector('.of-note').textContent;
        expect(note).toContain('90000');
        expect(note).toContain('1');
    });

    it('keeps a slide title apart from its bullets, and its notes out of the way', () => {
        show({
            kind: 'slides',
            sheets: [],
            slides: [
                {
                    number: 1,
                    title: 'Quarter in review',
                    bullets: [{ level: 0, text: 'Revenue up' }, { level: 1, text: 'Mostly EMEA' }],
                    notes: 'Do not read this out.',
                },
                { number: 2, title: '', bullets: [], notes: '' },
            ],
            blocks: [],
        }, 'C:/work/deck.pptx');

        const slides = container.querySelectorAll('.of-slide');
        expect(slides).toHaveLength(2);
        expect(slides[0].querySelector('.of-slide-title').textContent).toBe('Quarter in review');
        const bullets = slides[0].querySelectorAll('.of-bullets li');
        expect([...bullets].map(b => b.textContent)).toEqual(['Revenue up', 'Mostly EMEA']);
        // The authored indent is what makes an outline readable as an outline.
        expect(bullets[1].style.marginLeft).toBe('18px');

        // Notes are collapsed: they are the speaker's, not the reader's.
        const notes = slides[0].querySelector('.of-notes');
        expect(notes.tagName).toBe('DETAILS');
        expect(notes.open).toBe(false);

        // A slide with no title placeholder is normal; an empty heading is not.
        expect(slides[1].querySelector('.of-slide-title').textContent).toMatch(/no title/i);
        expect(slides[1].querySelector('.of-notes')).toBe(null);
        // …and a slide that does have text is never labelled as having none.
        expect(slides[0].querySelector('.of-slide-none')).toBe(null);
        expect(container.querySelector('.of-banner')).toBe(null);
    });

    it('explains an all-image deck instead of showing a column of blank cards', () => {
        // Decks exported one-picture-per-slide are common, and they parse to
        // nothing at all. That is the file, not a failure — but silence reads
        // as a broken preview.
        show({
            kind: 'slides',
            sheets: [],
            slides: [
                { number: 1, title: '', bullets: [], notes: '', pictures: 1 },
                { number: 2, title: '', bullets: [], notes: '', pictures: 4 },
                { number: 3, title: '', bullets: [], notes: '', pictures: 0 },
            ],
            blocks: [],
        }, 'C:/work/scan.pptx');

        expect(container.querySelector('.of-banner').textContent).toMatch(/picture/i);
        const none = [...container.querySelectorAll('.of-slide-none')].map(e => e.textContent);
        // "1 images" is the kind of thing that makes a preview look unfinished.
        expect(none[0]).toBe('One image, no text');
        expect(none[1]).toBe('4 images, no text');
        expect(none[2]).toMatch(/no text/i);
    });

    it('rebuilds a document as headings, prose, lists and tables', () => {
        show({
            kind: 'document',
            sheets: [], slides: [],
            blocks: [
                { kind: 'heading', level: 2, text: 'Scope', rows: [] },
                { kind: 'paragraph', level: 0, text: 'The plan in one line.', rows: [] },
                { kind: 'list', level: 0, text: 'First', rows: [] },
                { kind: 'list', level: 1, text: 'Nested', rows: [] },
                { kind: 'paragraph', level: 0, text: 'After the list.', rows: [] },
                { kind: 'list', level: 0, text: 'A separate list', rows: [] },
                { kind: 'table', level: 0, text: '', rows: [['Name', 'Qty'], ['Bolt', '12']] },
            ],
        }, 'C:/work/spec.docx');

        const doc = container.querySelector('.of-doc');
        expect(doc.querySelector('h2').textContent).toBe('Scope');
        expect(doc.querySelectorAll('.of-doc-p')).toHaveLength(2);

        // Consecutive list blocks are one list; a paragraph between them ends
        // it. Folding them all into a single <ul> would reorder the document.
        const lists = doc.querySelectorAll('.of-doc-list');
        expect(lists).toHaveLength(2);
        expect(lists[0].querySelectorAll('li')).toHaveLength(2);
        expect(lists[1].querySelectorAll('li')).toHaveLength(1);

        // The first table row reads as the header row, which is what Word
        // documents almost always mean by it.
        const table = doc.querySelector('.of-doc-table');
        expect([...table.querySelectorAll('th')].map(e => e.textContent)).toEqual(['Name', 'Qty']);
        expect([...table.querySelectorAll('td')].map(e => e.textContent)).toEqual(['Bolt', '12']);
    });

    it('does not turn a one-row table into a header row', () => {
        // A single-row table is a note box, not a table with a heading. Bold
        // on a tinted background would say something the document does not.
        show({
            kind: 'document',
            sheets: [], slides: [],
            blocks: [{ kind: 'table', level: 0, text: '', rows: [['\u6ce8\u610f', 'Bump instead.']] }],
        }, 'C:/work/note.docx');

        const table = container.querySelector('.of-doc-table');
        expect(table.querySelectorAll('th')).toHaveLength(0);
        expect([...table.querySelectorAll('td')].map(e => e.textContent))
            .toEqual(['\u6ce8\u610f', 'Bump instead.']);
    });

    it('draws only the rows in view, however many the sheet has', () => {
        const rows = Array.from({ length: 4000 }, (_, i) => [`row ${i}`, String(i)]);
        show(sheetsPreview({
            sheets: [{ name: 'Big', rows, total_rows: 4000, total_cols: 2, truncated: false }],
        }));
        // jsdom reports a zero-height container, so this is the buffer alone —
        // which is the assertion that matters: not 4000.
        const drawn = container.querySelectorAll('.of-row').length;
        expect(drawn).toBeGreaterThan(0);
        expect(drawn).toBeLessThan(100);
    });

    it('hands the file to the real application rather than pretending to be one', async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        vi.mocked(invoke).mockClear();

        show(sheetsPreview());
        const btn = [...container.querySelectorAll('.of-btn')]
            .find(b => /office/i.test(b.textContent));
        expect(btn).toBeTruthy();

        btn.click();
        // Through the backend command, NOT the shell plugin's open(): its JS
        // side is scoped to http, tel and mailto, so it refused the path
        // before it reached the shell and the button did nothing at all.
        expect(invoke).toHaveBeenCalledWith('open_office_file', { path: 'C:/work/book.xlsx' });
    });

    it('says so instead of drawing nothing when there is nothing to draw', () => {
        show({ kind: 'sheets', sheets: [], slides: [], blocks: [] });
        expect(container.querySelector('.of-empty').textContent).toMatch(/no sheets/i);
    });
});

/* The wiring in Editor.js decides whether a file is parsed or read as text,
   and whether a tab can be written back. Both are reachable only through the
   whole editor, so they are asserted against the source — the same way
   FileSafety.test.js holds the rest of that file. */
describe('how an Office tab is opened and closed off', () => {
    const editor = read('src/modules/core/Editor.js');

    it('parses the file instead of running it through the encoding detector', () => {
        const open = editor.slice(editor.indexOf('export async function openFile'));
        const branch = open.indexOf('isOfficeFile(resolvedPath)');
        expect(branch).toBeGreaterThan(-1);
        // The branch has to come BEFORE the text read, or the detector gets a
        // zip file first and the tab opens full of mojibake.
        expect(branch).toBeLessThan(open.indexOf('FS.readFileAutoDetect'));
        expect(open).toContain("invoke('read_office_preview'");
    });

    it('refuses to write a file it can only read', () => {
        const save = editor.slice(editor.indexOf('export async function saveFile'));
        const guard = save.indexOf("file.type === 'office'");
        expect(guard).toBeGreaterThan(-1);
        // Before needsSaveLocation(), or an Office tab would be offered a Save
        // As dialog and then write an empty text file over the answer.
        expect(guard).toBeLessThan(save.indexOf('needsSaveLocation(file)'));
    });

    it('does not offer a text view an Office tab cannot go to', () => {
        // file.content is '' for these tabs, so the toggle would land in an
        // empty CodeMirror and look like the file had been wiped.
        const toggle = editor.slice(editor.indexOf("'app:toggle-view-mode'"), editor.indexOf("'md-block:nav'"));
        expect(toggle).toContain("file.type === 'office'");
    });

    it('speaks the same search protocol the CSV grid does', () => {
        // One protocol, two implementations. What a "cell" is differs, and
        // only the view knows how to put one on screen — but the panel should
        // not have to know which kind of view it is talking to.
        const search = read('src/modules/ui/Search.js');
        expect(search).toContain('isCellGrid');
        expect(search).toContain('collectCellMatches');
        expect(search).toContain('gotoCellMatch');
        // The old CSV-only names are gone from every side of it.
        for (const dead of ['isCsvGridMode', 'collectCsvMatches', 'gotoCsvMatch']) {
            for (const f of ['src/modules/ui/Search.js', 'src/modules/views/CsvView.js',
                             'src/modules/editors/CsvEditor.js', 'src/modules/views/OfficeView.js']) {
                expect(read(f), `${dead} in ${f}`).not.toContain(dead);
            }
        }
        for (const m of ['isCellGrid', 'collectCellMatches', 'gotoCellMatch']) {
            expect(read('src/modules/views/CsvView.js'), m).toContain(m);
        }
    });

    it('refuses Replace on a match it cannot write back', () => {
        // Left to fall through, a cell match reached the Markdown branch,
        // indexed the block list with `undefined` and threw — so Replace in
        // the CSV grid has never worked either. The preview cannot be written
        // to at all.
        const search = read('src/modules/ui/Search.js');
        const fn = search.slice(search.indexOf('function _doReplace()'));
        const guard = fn.indexOf('match.isCell');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(fn.indexOf('Markdown block replace'));
    });

    it('reopens one with the workspace, since it is a real file on disk', () => {
        expect(read('src/modules/core/Session.js')).toContain("f.type !== 'office'");
        expect(editor).toContain('restoredOfficeTab');
    });

    // Opening a file with its default handler is a shell execute, which for an
    // .exe means running it. The command has to be narrow enough that a path
    // from anywhere else cannot turn it into a launcher.
    it('will only hand the shell a file the preview itself can read', () => {
        const office = read('src-tauri/src/commands/office.rs');
        const cmd = office.slice(office.indexOf('pub fn open_office_file'));
        const body = cmd.slice(0, cmd.indexOf('\n}'));
        expect(body).toContain('is_office_path');
        expect(body).toContain('is_file()');
    });
});
