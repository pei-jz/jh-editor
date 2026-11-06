import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

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
        const i = src.indexOf('_handleModClick(pos, view) {');
        const handler = src.slice(i, src.indexOf('\n    }', i));
        expect(handler.indexOf('openHitInOtherPane()'))
            .toBeLessThan(handler.indexOf('window.app.openFile'));
    });
});
