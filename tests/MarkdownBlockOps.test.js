import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TableEditor } from '../src/modules/editors/TableEditor.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, '..', ...p), 'utf8');

/*
   Removing a block used to take four steps: F2, select all, delete, save. And
   there was no way to act on more than one block at a time, so reworking a
   heading together with the paragraph under it meant two modals.

   The selection model here is an ANCHOR plus the cursor — a contiguous range,
   which is what was asked for and what the UI can actually draw. These tests
   pin the range arithmetic and the source wiring; the DOM behaviour around it
   is exercised through the view.
*/

/* The range arithmetic, exercised directly. `selectedRange` reads only the
   cursor, the anchor and the block count, so it can be driven without building
   a view — which makes this a test of the behaviour rather than of the text of
   the source. */
describe('selectedRange', () => {
    let view;
    let State;

    beforeEach(async () => {
        ({ State } = await import('../src/modules/core/Store.js'));
        const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
        view = Object.create(MarkdownView.prototype);
        view.blocksData = ['a', 'b', 'c', 'd'];
        State.vimState = State.vimState || {};
    });

    const at = (cursor, anchor) => {
        State.vimState.selectedIndex = cursor;
        view._selAnchor = anchor;
        return view.selectedRange();
    };

    it('is the cursor alone when there is no anchor', () => {
        expect(at(2, null)).toEqual({ from: 2, to: 2 });
    });

    it('spans anchor to cursor, whichever way round they are', () => {
        expect(at(3, 1)).toEqual({ from: 1, to: 3 });
        expect(at(1, 3)).toEqual({ from: 1, to: 3 });
    });

    it('is null when nothing is selected', () => {
        expect(at(-1, null)).toBeNull();
    });

    it('collapses onto the phantom row instead of spanning into it', () => {
        // Index 4 is the "+ Add Block" control on a 4-block document.
        expect(at(4, 0)).toEqual({ from: 4, to: 4 });
    });

    it('clamps an anchor left behind by a shorter document', () => {
        view.blocksData = ['a', 'b'];
        expect(at(0, 9)).toEqual({ from: 0, to: 1 });
    });
});

describe('markdown block selection is a contiguous range', () => {
    const src = read('src/modules/views/MarkdownView.js');

    it('derives the range from an anchor and the cursor', () => {
        expect(src).toContain('selectedRange()');
        expect(src).toContain('_selAnchor');
        expect(src).toContain('return { from: Math.min(anchor, head), to: Math.max(anchor, head) };');
    });

    it('collapses the range on a plain move and keeps it when extending', () => {
        expect(src).toContain('if (!extend) {\n            this._selAnchor = index;');
    });

    it('never lets the trailing phantom into a range', () => {
        // The "+ Add Block" row is a control, not content — deleting it would
        // mean deleting a block that does not exist.
        expect(src).toContain('if (head >= total) return { from: head, to: head };');
    });

    it('extends on Ctrl-click and Shift-click alike', () => {
        expect(src).toContain('extend: e.ctrlKey || e.metaKey || e.shiftKey');
    });

    it('binds Delete and Shift+Arrow in the block scope', () => {
        const defs = read('src/modules/core/ShortcutDefinitions.js');
        expect(defs).toContain("cmd: 'md-block:delete'");
        expect(defs).toContain("cmd: 'md-block:extend'");
        expect(src).toContain("if (cmd === 'md-block:delete')");
        expect(src).toContain("if (cmd === 'md-block:extend')");
    });

    it('asks before deleting text, since there is no block-level undo', () => {
        expect(src).toContain('deleteSelectedBlocks()');
        expect(src).toContain('const ok = await showConfirm(');
        // An empty block is not worth a dialog.
        expect(src).toContain("const hasContent = doomed.some((b) => String(b || '').trim());");
    });

    it('edits a multi-block selection as one document', () => {
        expect(src).toContain('_editBlockRange(range)');
        expect(src).toContain('rangeCount: range.to - range.from + 1');
        // The result is re-split, so three blocks can become five or one.
        expect(src).toContain('this.blocksData.splice(index, replace, ...pieces);');
    });
});

describe('block-edit modal layout', () => {
    const src = read('src/modules/views/MarkdownView.js');

    it('can stack source over preview, and remembers the choice', () => {
        expect(src).toContain('mbe-vertical');
        expect(src).toContain('MBE_LAYOUT_KEY');
        expect(read('src/modules/views/MarkdownView.js')).toContain('Ctrl+Alt+L');
    });

    it('drags on the right axis for the current layout', () => {
        // A pixel width set by a horizontal drag is not a height; the splitter
        // reads which axis it is on rather than assuming.
        expect(src).toContain("const vertical = body.classList.contains('mbe-vertical');");
        expect(src).toContain('let last = vertical ? e.clientY : e.clientX;');
    });
});

describe('TableEditor clipboard export', () => {
    const data = [
        ['Feature', 'Description'],
        ['MCP server role', 'Operates as MCP server'],
        ['a & b', '<script>x</script>'],
    ];

    it('produces tab-separated text', () => {
        const tsv = TableEditor.toTsv(data);
        expect(tsv.split('\n')).toHaveLength(3);
        expect(tsv.split('\n')[0]).toBe('Feature\tDescription');
    });

    it('honours a range', () => {
        expect(TableEditor.toTsv(data, { r1: 1, r2: 1, c1: 0, c2: 0 })).toBe('MCP server role');
    });

    it('builds an HTML table with inline styles, which is what Excel reads', () => {
        const html = TableEditor.toHtml(data);
        expect(html).toContain('<table style="border-collapse:collapse;">');
        expect(html).toContain('<thead>');
        // Inline, not a class: a stylesheet does not travel on the clipboard.
        expect(html).toMatch(/<th style="[^"]*border:1px solid/);
        expect(html).toMatch(/<td style="[^"]*background-color:/);
        expect(html).toContain('font-weight:bold');
    });

    it('keeps every style declaration inside its attribute', () => {
        // A double quote in the font stack closed style="..." early, so
        // everything after it — including the background colour — became
        // stray attributes and Excel received malformed markup.
        const html = TableEditor.toHtml(data);
        for (const attr of html.match(/style="[^"]*"/g) || []) {
            expect(attr).not.toContain('font-family:Calibri, "');
        }
        expect(html).not.toMatch(/style="[^"]*"[A-Za-z ]/);
    });

    it('escapes cell content instead of emitting it as markup', () => {
        const html = TableEditor.toHtml(data);
        expect(html).toContain('a &amp; b');
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>');
    });

    it('returns empty for an empty table rather than a stray <table>', () => {
        expect(TableEditor.toHtml([])).toBe('');
        expect(TableEditor.toTsv([])).toBe('');
    });

    describe('copyToClipboard', () => {
        let originalClipboard;

        beforeEach(() => {
            originalClipboard = navigator.clipboard;
        });
        afterEach(() => {
            if (originalClipboard === undefined) delete navigator.clipboard;
            else Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
            vi.restoreAllMocks();
        });

        it('writes both flavours through the async Clipboard API when it exists', async () => {
            const write = vi.fn(async () => {});
            Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
            globalThis.ClipboardItem = function (items) { this.items = items; };

            const ok = await TableEditor.copyToClipboard(data);
            expect(ok).toBe(true);
            expect(write).toHaveBeenCalledTimes(1);
            const item = write.mock.calls[0][0][0];
            expect(Object.keys(item.items)).toEqual(['text/html', 'text/plain']);

            delete globalThis.ClipboardItem;
        });

        it('falls back to a copy event when the Clipboard API is unavailable', async () => {
            Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
            const seen = {};
            document.execCommand = vi.fn(() => {
                // The real implementation copies whatever the one-shot listener
                // put on the event, so simulate that listener firing.
                const e = new Event('copy', { bubbles: true });
                e.clipboardData = { setData: (t, v) => { seen[t] = v; } };
                e.preventDefault = () => {};
                document.dispatchEvent(e);
                return true;
            });

            const ok = await TableEditor.copyToClipboard(data);
            expect(ok).toBe(true);
            expect(seen['text/plain']).toContain('Feature\tDescription');
            expect(seen['text/html']).toContain('<table');
            // The scratch node used to drive the selection must not be left behind.
            expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
        });

        it('reports failure rather than throwing when nothing works', async () => {
            Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
            document.execCommand = vi.fn(() => { throw new Error('denied'); });
            vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(TableEditor.copyToClipboard(data)).resolves.toBe(false);
        });

        it('copies nothing for an empty table', async () => {
            await expect(TableEditor.copyToClipboard([])).resolves.toBe(false);
        });
    });
});
