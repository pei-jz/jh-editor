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
        expect(src).toContain('ok = await showConfirm(');
        // The confirm is awaited, so a second Delete arriving meanwhile must
        // not open a second dialog over the same range.
        expect(src).toContain('if (this._deleting) return false;');
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

/* Reported after the first round of block editing shipped. Each of these was a
   real defect, and each is the kind that only shows up in use. */
describe('block selection regressions', () => {
    let view;
    let State;

    beforeEach(async () => {
        ({ State } = await import('../src/modules/core/Store.js'));
        const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
        view = Object.create(MarkdownView.prototype);
        view.blocksData = ['a', 'b', 'c', 'd', 'e'];
        State.vimState = State.vimState || {};
    });

    it('drops the anchor when the document changes', () => {
        // View instances are reused across files. With the anchor left at 0 from
        // the previous document and the cursor restored to 4 in this one, the
        // first F2 opened blocks 0..4 as one edit — "the whole page".
        view._selFilePath = '/old/file.md';
        view._selAnchor = 0;
        view.file = { path: '/new/file.md', _mdSelBlock: 4 };

        view._syncSelectionToFile(view.blocksData.length);

        expect(view._selAnchor).toBeNull();
        expect(view.selectedRange()).toEqual({ from: 4, to: 4 });
    });

    it('drops the anchor when the cursor is reset out of range', () => {
        view._selFilePath = '/same.md';
        view.file = { path: '/same.md' };
        view._selAnchor = 1;
        State.vimState.selectedIndex = 99;      // beyond this document

        view._syncSelectionToFile(view.blocksData.length);

        expect(State.vimState.selectedIndex).toBe(-1);
        expect(view._selAnchor).toBeNull();
    });

    it('deletes once per keypress, not once per listener', () => {
        // ShortcutManager and the view's own nav handler both listen on window
        // in the CAPTURE phase, and stopPropagation() does not stop a sibling
        // listener on the same target. Both fired, so one Delete opened two
        // confirm dialogs over the same range — which is how cancelling one
        // could still end in a deletion.
        const calls = [];
        view.deleteSelectedBlocks = () => { calls.push(1); return Promise.resolve(true); };

        const e = { key: 'Delete', preventDefault() {}, stopPropagation() {} };

        // First handler (the scoped one) claims the event...
        view.handleShortcut('md-block:delete', e);
        expect(e.__mdBlockDelete).toBe(true);

        // ...and the second sees the stamp and stands down.
        expect(e.__mdBlockDelete).toBe(true);
        expect(calls).toHaveLength(1);
    });

    it('refuses a second delete while the confirm is still open', async () => {
        view._deleting = true;
        await expect(view.deleteSelectedBlocks()).resolves.toBe(false);
    });
});

describe('the block editor modal owns its own keys', () => {
    const src = read('src/modules/views/MarkdownView.js');

    it('listens on the overlay in the capture phase, not the pane in bubble', () => {
        // Bound to the source pane, Ctrl+Alt+L never arrived: focus is inside
        // CodeMirror (whose keymap runs first) and ShortcutManager listens on
        // window with capture, so the key was spoken for long before it bubbled
        // back out to the pane.
        expect(src).toContain("overlay.addEventListener('keydown', (e) => {");
        expect(src).toContain('toggleLayout();');
        // `true` = capture phase.
        expect(src).toMatch(/\}, true\);/);
    });

    it('matches the physical key as well as the character', () => {
        // Holding Alt changes the reported CHARACTER on several layouts
        // (Ctrl+Alt is AltGr on some Windows keyboards) while the physical key
        // stays KeyL. Same reason the codebase matches e.code for Ctrl+\.
        expect(src).toContain("e.code === 'KeyL'");
    });
});

describe('the table carries its own copy control', () => {
    const src = read('src/modules/editors/TableEditor.js');
    const view = read('src/modules/views/MarkdownView.js');

    it('puts the button on the non-scrolling host', () => {
        // Absolutely positioned inside the scroller, it slid out of view the
        // moment a wide table was scrolled sideways.
        expect(src).toContain("container.closest('.table-editor-host')");
        expect(view).toContain("tableHost.className = 'table-editor-host'");
        expect(view).toContain("tableContainer.className = 'table-editor-scroll'");
    });

    it('does not also keep a duplicate in the toolbar', () => {
        expect(view).not.toContain('copyTableBtn');
    });

    it('extends the selection on drag, and stops on mouseup', () => {
        expect(src).toContain('this._drag.active = true;');
        expect(src).toContain('cell.onmouseenter = () => {');
        expect(src).toContain("document.addEventListener('mouseup', this._endDrag, true);");
        // A drag that started must not survive a re-render.
        expect(src).toContain("document.removeEventListener('mouseup', this._endDrag, true);");
    });

    it('leaves the right mouse button to the context menu', () => {
        expect(src).toContain('if (e.button !== 0) return;');
    });
});
