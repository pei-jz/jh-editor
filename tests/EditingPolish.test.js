import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TableEditor } from '../src/modules/editors/TableEditor.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

/* A Markdown table cell wrapped when you were reading it and stopped wrapping
   the moment you edited it: the editor was an <input type="text">, which is
   single-line by definition, so long text scrolled sideways through a narrow
   column and you edited it through a letterbox. */
describe('editing a table cell', () => {
    let container;

    beforeEach(() => {
        document.body.innerHTML = '';
        container = document.createElement('div');
        document.body.appendChild(container);
        TableEditor.render(container, [['h1', 'h2'], ['a', 'b']], vi.fn());
    });

    // Row 0 is the header; the first data cell is row 1.
    const firstCell = () => container.querySelector('td[data-row="1"][data-col="0"]');

    it('edits in a box that can wrap', () => {
        const editor = firstCell().querySelector('textarea');
        expect(editor, 'the cell editor is still a single-line input').not.toBeNull();
        expect(firstCell().querySelector('input')).toBeNull();
    });

    // Enter has nothing to mean inside a cell: a Markdown table cannot hold a
    // real newline, so it commits and moves down, exactly as before.
    it('still commits on Enter instead of inserting a newline', () => {
        const src = read('src/modules/editors/TableEditor.js');
        const i = src.indexOf('input.onkeydown = (e) => {');
        const fn = src.slice(i, src.indexOf('\n            };', i));
        expect(fn).toContain("if (e.key === 'Enter'");
        expect(fn).toContain('e.preventDefault();');
    });

    it('grows to fit rather than hiding text below the fold', () => {
        const src = read('src/modules/editors/TableEditor.js');
        expect(src).toContain('const autoGrow = (el) => {');
        expect(src).toContain("input.addEventListener('input', () => autoGrow(input));");
        // ...and is sized the moment it is revealed, not only on the next key.
        expect((src.match(/input\.style\.height = `\$\{input\.scrollHeight\}px`;/g) || []).length)
            .toBe(2);
    });

    it('is styled to wrap, with no inner scrollbar or drag handle', () => {
        const css = read('src/styles/editor.css');
        // lastIndexOf: the selector also appears in the shared input/textarea rule.
        const i = css.lastIndexOf('.visual-table-editor textarea {');
        const block = css.slice(i, css.indexOf('}', i));
        expect(block).toContain('white-space: pre-wrap');
        expect(block).toContain('overflow-wrap: anywhere');
        expect(block).toContain('resize: none');
        expect(block).toContain('overflow: hidden');
    });

    // `break-all` split ordinary words mid-letter; the preview does not.
    it('wraps the read-only text at word boundaries', () => {
        const css = read('src/styles/editor.css');
        const i = css.indexOf('.visual-table-editor .cell-text {');
        const block = css.slice(i, css.indexOf('}', i));
        expect(block).toContain('word-break: normal');
        expect(block).not.toContain('word-break: break-all');
    });
});

/* After saving a block the view re-renders, and `block: 'nearest'` then parks
   the edited block flush against the top or bottom edge — which reads as
   having scrolled to the wrong place. */
describe('where the view lands after editing a block', () => {
    const src = read('src/modules/views/MarkdownView.js');

    it('centres the block that was just edited', () => {
        expect(src).toContain('selectBlock(index, opts = {})');
        // `extend` joined the options when contiguous multi-select landed.
        expect(src).toContain("const { reveal = 'nearest', focus = true, extend = false } = opts;");
        expect(src).toContain("this.selectBlock(blockIndex, { reveal: 'center' });");
    });

    // Arrow-key navigation must NOT centre: scrolling the page under a reader
    // who can already see the target is worse than not scrolling.
    it('leaves plain navigation on nearest', () => {
        expect(src).toContain("behavior: 'smooth', block: reveal");
        const i = src.indexOf('navigateBlock(');
        const fn = src.slice(i, i + 900);
        expect(fn).not.toContain("reveal: 'center'");
    });
});

/* Book mode parks the cursor on the visible page 150ms after the view is
   built — which is AFTER the explorer's own re-focus. It took the keyboard
   back from whatever the user had just clicked, so arrows moved blocks and F2
   opened a block editor while the explorer looked focused. */
describe('book mode does not steal the keyboard', () => {
    const src = read('src/modules/views/MarkdownView.js');

    it('parks the cursor without focusing it', () => {
        expect(src).toContain('this.selectBlock(anchor, { focus: false });');
        expect(src).toContain('this._selectFirstBlockOfPage(left, { focus: false });');
    });

    it('still focuses when the user actually navigates', () => {
        // The default is focus:true, so every other caller is unaffected.
        expect(src).toContain('const { reveal = \'nearest\', focus = true, extend = false } = opts;');
        expect(src).toContain('if (!focus) return;');
    });
});

/* A results list is something you work THROUGH. Opening each hit over the list
   itself replaced the very thing you were walking down. */
describe('opening a grep hit while split', () => {
    const src = read('src/modules/views/SearchResultsView.js');

    it('sends the file to the other pane', () => {
        expect(src).toContain('function openHitInOtherPane()');
        const i = src.indexOf('function openHitInOtherPane()');
        const fn = src.slice(i, src.indexOf('\n}', i));
        expect(fn).toContain("State.activePane === 'right' ? 'left' : 'right'");
        // Nowhere else to put it without a split.
        expect(fn).toContain('if (!State.splitMode) return;');
    });

    it('does it before the file is opened', () => {
        const i = src.indexOf('lineEl.onclick');
        const handler = src.slice(i, src.indexOf('};', i));
        expect(handler.indexOf('openHitInOtherPane()'))
            .toBeLessThan(handler.indexOf('window.app.openFile'));
    });
});
