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
            expect(view.selectBlock).toHaveBeenCalledWith(6, { extend: false });
        });

        it('treats the right-hand page of the spread as visible', () => {
            State.vimState.selectedIndex = 6; // page 3 = right page of spread 2
            view.navigateBlock(-1);
            expect(view.selectBlock).toHaveBeenCalledWith(5, { extend: false });
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

    describe('_renderVisibleBlocks first-paint fallback', () => {
        it('renders blocks that overlap the container viewport (with margin)', () => {
            view.container.innerHTML = '';
            const blocks = ['# One', 'Two', 'Three', 'Four'];
            view.blocksData = blocks;
            // Emulate the render() DOM: one .md-block per block.
            const divs = blocks.map((_, i) => {
                const d = document.createElement('div');
                d.className = 'md-block md-body';
                d.dataset.index = String(i);
                d.style.minHeight = '20px';
                view.container.appendChild(d);
                return d;
            });
            // Container at (0, 0, 400, 600). Blocks laid out top→bottom.
            const sizes = [0, 20, 40, 60, 80, 100, 120, 140];
            const fakeRects = new Map(divs.map((d, i) => [d, { top: i * 20, bottom: (i + 1) * 20 }]));
            view.container.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 400, width: 400, height: 600 });
            divs.forEach((d) => {
                d.getBoundingClientRect = () => {
                    const r = fakeRects.get(d);
                    return { ...r, left: 0, right: 400, width: 400, height: 20 };
                };
            });
            // clientWidth/Height must be non-zero or the guard bails.
            Object.defineProperty(view.container, 'clientWidth', { value: 400, configurable: true });
            Object.defineProperty(view.container, 'clientHeight', { value: 600, configurable: true });

            // Only the in-viewport blocks get rendered; far below the margin stay unrendered.
            view._renderVisibleBlocks();
            // In-viewport (0..600 + 300 margin = up to block ~45): blocks 0..14 visible.
            // jsdom has no marked, so _renderBlockInternal falls back to textContent.
            expect(divs[0].dataset.rendered).toBe('true');
            expect(divs[1].dataset.rendered).toBe('true');
        });

        it('skips blocks already rendered and does not double-render', () => {
            view.container.innerHTML = '';
            const blocks = ['a', 'b'];
            view.blocksData = blocks;
            const divs = blocks.map((_, i) => {
                const d = document.createElement('div');
                d.className = 'md-block md-body';
                d.dataset.index = String(i);
                view.container.appendChild(d);
                return d;
            });
            Object.defineProperty(view.container, 'clientWidth', { value: 400, configurable: true });
            Object.defineProperty(view.container, 'clientHeight', { value: 600, configurable: true });
            view.container.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 400 });
            divs.forEach((d, i) => {
                d.getBoundingClientRect = () => ({ top: i * 20, bottom: (i + 1) * 20, left: 0, right: 400 });
            });
            divs[1].dataset.rendered = 'true';
            divs[1].textContent = 'already-rendered';

            view._renderVisibleBlocks();

            expect(divs[0].dataset.rendered).toBe('true');
            // The pre-rendered block was NOT overwritten.
            expect(divs[1].textContent).toBe('already-rendered');
        });

        it('does nothing while the container is not laid out (zero size)', () => {
            view.container.innerHTML = '';
            view.blocksData = ['a'];
            const div = document.createElement('div');
            div.className = 'md-block md-body';
            div.dataset.index = '0';
            view.container.appendChild(div);
            // Zero client sizes → guard returns before touching the block.
            Object.defineProperty(view.container, 'clientWidth', { value: 0, configurable: true });
            Object.defineProperty(view.container, 'clientHeight', { value: 0, configurable: true });
            view.container.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 400 });
            div.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: 0, right: 400 });

            view._renderVisibleBlocks();

            expect(div.dataset.rendered).toBeUndefined();
        });
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
            expect(view.navigateBlock).toHaveBeenCalledWith(1, { extend: false });
        });
    });
});
