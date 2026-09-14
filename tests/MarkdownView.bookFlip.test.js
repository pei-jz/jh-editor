import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Book mode turns pages with an 800ms animation, and for that whole time
// page-flip's getCurrentPageIndex() still reports the spread being LEFT. Keys
// pressed during a turn used to be judged against that stale spread: ← straight
// after a → that crossed spreads found "same spread, no flip", the turn landed
// on the new spread anyway, and the selection was moved to that page's top.
// Separately, the scroll that brings a selected block into view ran while its
// page was still folded away and was then undone by _resetSpreadScroll, so a
// block below the fold of an overflowing page ended up selected out of sight.

const load = async () => {
    const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
    const { State } = await import('../src/modules/core/Store.js');
    return { MarkdownView, State };
};

describe('MarkdownView book turning', () => {
    let MarkdownView;
    let State;
    let view;
    let book;
    let savedTab;

    // pages[i] holds blocks i*2 and i*2+1.
    const PAGE_COUNT = 8;
    const pages = Array.from({ length: PAGE_COUNT }, (_, i) => [{ index: i * 2 }, { index: i * 2 + 1 }]);

    /**
     * A stand-in for page-flip with its real timing: flip() starts a turn
     * ('flipping'); finish() ends it the way the library does — show the new
     * spread (the `flip` event), then return to 'read'.
     */
    const makeBook = (shown = 0) => {
        const b = {
            shown,
            state: 'read',
            target: null,
            getCurrentPageIndex: () => b.shown,
            getOrientation: () => 'landscape',
            getState: () => b.state,
            flip: vi.fn((p) => { b.state = 'flipping'; b.target = p - (p % 2); }),
            turnToPage: vi.fn((p) => { b.shown = p - (p % 2); view._onBookFlip(b.shown); }),
            finish() {
                b.shown = b.target;
                view._onBookFlip(b.shown);
                b.state = 'read';
                view._onBookStateChange('read');
            },
        };
        return b;
    };

    beforeEach(async () => {
        ({ MarkdownView, State } = await load());
        document.body.innerHTML = '<div id="host"></div>';
        view = new MarkdownView(document.getElementById('host'), {});
        savedTab = State.activeTabIndex;
        State.activeTabIndex = 0;
        State.markdownViewMode = 'book';
        view.pages = pages;
        view.blocksData = Array.from({ length: PAGE_COUNT * 2 }, (_, i) => `block ${i}`);
        book = makeBook(0);
        view.pageFlipInstance = book;
        view.currentPageIndex = 0;
        view._flipTarget = null;
        view._queuedFlip = null;
    });

    afterEach(() => {
        State.markdownViewMode = 'scroll';
        State.activeTabIndex = savedTab;
        State.vimState.selectedIndex = -1;
        document.body.innerHTML = '';
    });

    it('does not lose ← pressed while a → is still turning the page', () => {
        view.selectBlock(2);                    // page 1, right side of spread 0
        view._selectAdjacentPageTop(1);         // → : top of page 2 — turns to spread 2
        expect(book.flip).toHaveBeenCalledWith(2);
        expect(State.vimState.selectedIndex).toBe(4);

        view._selectAdjacentPageTop(-1);        // ← during the turn: back to page 1
        expect(State.vimState.selectedIndex).toBe(2);
        expect(book.flip).toHaveBeenCalledTimes(1);   // not issued mid-turn

        book.finish();                          // lands on spread 2 …
        expect(book.flip).toHaveBeenLastCalledWith(0); // … and turns back
        book.finish();
        expect(book.shown).toBe(0);
        expect(State.vimState.selectedIndex).toBe(2); // still where ← put it
    });

    it('keeps a selection moved onto the destination spread during the turn', () => {
        view.selectBlock(2);
        view._selectAdjacentPageTop(1);         // top of page 2, turning to spread 2
        view._selectAdjacentPageTop(1);         // → again mid-turn: top of page 3
        expect(State.vimState.selectedIndex).toBe(6);
        expect(book.flip).toHaveBeenCalledTimes(1);   // same spread: nothing more to turn

        book.finish();
        expect(book.shown).toBe(2);
        expect(State.vimState.selectedIndex).toBe(6); // not reset to the top of page 2
    });

    it('turns two spreads for Alt+→ pressed twice during one turn', () => {
        view.navigatePage(1);
        expect(book.flip).toHaveBeenCalledWith(2);
        view.navigatePage(1);
        expect(book.flip).toHaveBeenCalledTimes(1);
        book.finish();
        expect(book.flip).toHaveBeenLastCalledWith(4);
        book.finish();
        expect(book.shown).toBe(4);
        expect(view.currentPageIndex).toBe(4);
    });

    it('shows the spread without animation when the library declines the flip', () => {
        book.flip = vi.fn();                    // stays in 'read', does not move
        view.selectBlock(5);                    // page 2
        expect(book.turnToPage).toHaveBeenCalledWith(2);
        expect(book.shown).toBe(2);
        expect(view._flipTarget).toBeNull();
        expect(view._bookMoving()).toBe(false);
    });

    it('brings a block below the fold into view once the turn lands', () => {
        const host = document.getElementById('host');
        view.container = host;
        const pageEls = pages.map((blocks, i) => {
            const pageEl = document.createElement('div');
            pageEl.className = 'stf__page';
            pageEl.dataset.pageIndex = String(i);
            Object.defineProperty(pageEl, 'clientHeight', { value: 200, configurable: true });
            blocks.forEach((b, k) => {
                const el = document.createElement('div');
                el.className = 'md-block';
                el.dataset.index = String(b.index);
                Object.defineProperty(el, 'offsetParent', { value: pageEl, configurable: true });
                Object.defineProperty(el, 'offsetTop', { value: k === 0 ? 0 : 300, configurable: true });
                Object.defineProperty(el, 'offsetHeight', { value: 100, configurable: true });
                el.focus = () => {};
                pageEl.appendChild(el);
            });
            host.appendChild(pageEl);
            return pageEl;
        });

        book.shown = 2;
        view.currentPageIndex = 2;
        view.selectBlock(4);                    // top of page 2 (showing)
        view.selectBlock(3);                    // ↑ : last block of page 1, below its fold
        expect(book.flip).toHaveBeenCalledWith(0);
        pageEls[1].scrollTop = 0;
        book.finish();

        // 300 + 100 - 200 + 20: the block's bottom just inside the page.
        expect(pageEls[1].scrollTop).toBe(220);
        expect(State.vimState.selectedIndex).toBe(3);
    });

    it('opens a block taller than the page at its top, not its end', () => {
        const pageEl = document.createElement('div');
        pageEl.className = 'stf__page';
        Object.defineProperty(pageEl, 'clientHeight', { value: 200, configurable: true });
        const el = document.createElement('div');
        pageEl.appendChild(el);
        Object.defineProperty(el, 'offsetParent', { value: pageEl, configurable: true });
        Object.defineProperty(el, 'offsetTop', { value: 150, configurable: true });
        Object.defineProperty(el, 'offsetHeight', { value: 900, configurable: true });

        view._revealInBookPage(el, 'nearest', 'auto');
        expect(pageEl.scrollTop).toBe(130);
    });
});
