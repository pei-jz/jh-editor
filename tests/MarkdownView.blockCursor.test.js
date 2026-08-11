import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// State.vimState.selectedIndex — the markdown block cursor — is GLOBAL: one
// value shared by every tab. Opening another document used to inherit the
// previous one's index, so the first ↑/↓ moved relative to a block belonging to
// some other file; in book mode selectBlock() then flipped the book to the page
// holding it, which looked like "pressing ↓ on page 1 jumps to another page".
// Clicking a block first hid the bug by re-anchoring the cursor.

const load = async () => {
    const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
    const { State } = await import('../src/modules/core/Store.js');
    return { MarkdownView, State };
};

describe('MarkdownView block cursor anchoring', () => {
    let MarkdownView;
    let State;
    let view;

    beforeEach(async () => {
        ({ MarkdownView, State } = await load());
        document.body.innerHTML = '<div id="host"></div>';
        view = new MarkdownView(document.getElementById('host'), {});
    });

    afterEach(() => {
        State.markdownViewMode = 'scroll';
        document.body.innerHTML = '';
    });

    /** A stand-in for the StPageFlip instance: 2-page spreads, no animation. */
    const fakeBook = (leftPage) => ({
        getCurrentPageIndex: () => leftPage,
        getOrientation: () => 'landscape',
        flip: vi.fn()
    });

    /** pages[i] = the blocks rendered on page i. */
    const pages = [
        [{ index: 0 }, { index: 1 }],
        [{ index: 2 }, { index: 3 }],
        [{ index: 4 }, { index: 5 }],
        [{ index: 6 }, { index: 7 }]
    ];

    describe('_syncSelectionToFile', () => {
        it('drops a cursor inherited from another file', () => {
            State.vimState.selectedIndex = 12;
            view.file = { path: '/notes/other.md' };
            view._syncSelectionToFile(8);
            expect(State.vimState.selectedIndex).toBe(-1);
        });

        it('restores the cursor this file was left on', () => {
            State.vimState.selectedIndex = 12;
            view.file = { path: '/notes/a.md', _mdSelBlock: 3 };
            view._syncSelectionToFile(8);
            expect(State.vimState.selectedIndex).toBe(3);
        });

        it('keeps the cursor across re-renders of the same file', () => {
            view.file = { path: '/notes/a.md' };
            view._syncSelectionToFile(8);
            State.vimState.selectedIndex = 5;
            view._syncSelectionToFile(8); // e.g. book/scroll toggle, resize
            expect(State.vimState.selectedIndex).toBe(5);
        });

        it('clamps an index the document no longer has', () => {
            State.vimState.selectedIndex = 99;
            view.file = { path: '/notes/a.md', _mdSelBlock: 99 };
            view._syncSelectionToFile(8);
            expect(State.vimState.selectedIndex).toBe(-1);
        });
    });

    describe('navigateBlock in book mode', () => {
        beforeEach(() => {
            State.markdownViewMode = 'book';
            view.pages = pages;
            view.blocksData = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
            view.currentPageIndex = 2;
            view.pageFlipInstance = fakeBook(2);
            view.selectBlock = vi.fn((i) => { State.vimState.selectedIndex = i; });
        });

        it('lands on the visible page instead of flipping back to a stale block', () => {
            State.vimState.selectedIndex = 1; // page 0 — nowhere near the spread
            view.navigateBlock(1);
            expect(view.selectBlock).toHaveBeenCalledWith(4); // top of page 2
            expect(view.pageFlipInstance.flip).not.toHaveBeenCalled();
        });

        it('lands on the visible page when nothing is selected at all', () => {
            State.vimState.selectedIndex = -1;
            view.navigateBlock(1);
            expect(view.selectBlock).toHaveBeenCalledWith(4);
        });

        it('moves normally once the cursor is on the shown spread', () => {
            State.vimState.selectedIndex = 5;
            view.navigateBlock(1);
            expect(view.selectBlock).toHaveBeenCalledWith(6);
        });

        it('treats the right-hand page of the spread as visible', () => {
            State.vimState.selectedIndex = 6; // page 3 = right page of spread 2
            view.navigateBlock(-1);
            expect(view.selectBlock).toHaveBeenCalledWith(5);
        });
    });

    it('focus() does not turn the page when nothing is selected', () => {
        State.markdownViewMode = 'book';
        view.pages = pages;
        view.blocksData = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        view.currentPageIndex = 2;
        view.pageFlipInstance = fakeBook(2);
        view.selectBlock = vi.fn((i) => { State.vimState.selectedIndex = i; });

        State.vimState.selectedIndex = -1;
        view.focus();
        expect(view.selectBlock).toHaveBeenCalledWith(4);
        expect(view.selectBlock).not.toHaveBeenCalledWith(0);
    });

    describe('block-nav keys vs. modal overlays', () => {
        beforeEach(() => {
            // Scroll mode: the block-nav handler is installed by render().
            State.markdownViewMode = 'scroll';
            view.blocksData = ['a', 'b', 'c', 'd'];
            view.navigateBlock = vi.fn();
            view.container.innerHTML = '<div class="md-block"></div>'.repeat(4);
            // jsdom does no layout: offsetParent is null, which the handler
            // treats as "view not visible". Make it look visible.
            Object.defineProperty(view.container, 'offsetParent', { value: document.body, configurable: true });
            view._installBlockNavKeys();
            State.vimState.selectedIndex = 1; // block selected → arrows would move it
        });

        it('does not steal ↑/↓ while the NewFileModal overlay is open', () => {
            const overlay = document.createElement('div');
            overlay.id = 'new-file-overlay';
            overlay.className = 'tab-search-overlay';
            document.body.appendChild(overlay);
            try {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
                expect(view.navigateBlock).not.toHaveBeenCalled();
            } finally {
                overlay.remove();
            }
        });

        it('still moves the block when no modal is open', () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
            expect(view.navigateBlock).toHaveBeenCalledWith(1);
        });
    });
});
