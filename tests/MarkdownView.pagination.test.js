import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Book mode TURNS pages; it does not scroll for you. Anything past the bottom
// of a sheet is content the reader turns straight past, so the governing
// invariant is that a page is never deliberately overfilled. Two earlier
// revisions broke it from opposite directions: packing a fixed NUMBER of blocks
// per page (which stranded headings and overflowed long pages), and then
// packing to two thirds full even when the next block would spill (which put
// nine pages in ten over the fold, so every turn skipped a tail).

const load = async () => {
    const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
    return { MarkdownView };
};

describe('MarkdownView._splitIntoPages', () => {
    let MarkdownView;
    let view;

    // jsdom has no `marked` and no layout, so measurement falls back to
    // _estimateBlockHeight — deterministic, which is what we assert against.
    const PAGE_HEIGHT = 600;
    const PAGE_WIDTH = 500;
    const usable = () => Math.max(160, PAGE_HEIGHT - MarkdownView.PAGE_PADDING_V);

    const heightsOf = (texts) => view._measureBlockHeights(texts, PAGE_WIDTH);

    beforeEach(async () => {
        ({ MarkdownView } = await load());
        document.body.innerHTML = '<div id="host"></div>';
        view = new MarkdownView(document.getElementById('host'), {});
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    const para = (n) => Array.from({ length: n }, (_, i) => `paragraph body line ${i}`).join('\n');

    it('returns a single empty page for an empty document', () => {
        expect(view._splitIntoPages([], PAGE_HEIGHT, PAGE_WIDTH)).toEqual([[]]);
    });

    it('keeps every block exactly once and in order', () => {
        const blocks = ['# One', para(3), '## Two', para(6), para(2), '### Three', para(4)];
        const pages = view._splitIntoPages(blocks, PAGE_HEIGHT, PAGE_WIDTH);
        const flat = pages.flat().map((b) => b.index);
        expect(flat).toEqual(blocks.map((_, i) => i));
        expect(pages.flat().map((b) => b.text)).toEqual(blocks);
    });

    it('never ends a page on a heading whose body follows', () => {
        // Alternating heading / body, sized so a count-based split would land a
        // page boundary right after a heading.
        const blocks = [];
        for (let i = 0; i < 12; i++) {
            blocks.push(`# Section ${i}`);
            blocks.push(para(5));
        }
        const pages = view._splitIntoPages(blocks, PAGE_HEIGHT, PAGE_WIDTH);
        expect(pages.length).toBeGreaterThan(1);
        pages.forEach((page, idx) => {
            if (idx === pages.length - 1) return; // nothing follows the last page
            const last = page[page.length - 1];
            expect(view._isHeadingBlock(last.text)).toBe(false);
        });
    });

    it('does not overflow the page height when blocks fit at all', () => {
        const blocks = Array.from({ length: 30 }, (_, i) => para(3 + (i % 4)));
        const heights = heightsOf(blocks);
        const pages = view._splitIntoPages(blocks, PAGE_HEIGHT, PAGE_WIDTH);
        pages.forEach((page) => {
            const total = page.reduce((sum, b) => sum + heights[b.index], 0);
            expect(total).toBeLessThanOrEqual(usable());
        });
    });

    it('gives a block taller than a whole page its own page', () => {
        // The preceding page must already be at least two thirds full — a
        // sparser page keeps the oversized block instead of being wasted.
        const blocks = [para(18), para(200), para(2)];
        const heights = heightsOf(blocks);
        expect(heights[1]).toBeGreaterThan(usable());
        const pages = view._splitIntoPages(blocks, PAGE_HEIGHT, PAGE_WIDTH);
        const giant = pages.find((p) => p.some((b) => b.index === 1));
        expect(giant.map((b) => b.index)).toEqual([1]);
    });

    // A page that would be left more than a third blank is not closed at all:
    // the oversized block rides along and the page scrolls. Anything else puts
    // a lone heading at the top of a page and two thirds of a hole under it.
    it('keeps a tall block on a page that would otherwise be left mostly blank', () => {
        const blocks = ['## 0. Overview', para(30)];
        const heights = heightsOf(blocks);
        expect(heights[0] + heights[1]).toBeGreaterThan(usable());
        const pages = view._splitIntoPages(blocks, PAGE_HEIGHT, PAGE_WIDTH);
        expect(pages).toHaveLength(1);
        expect(pages[0].map((b) => b.index)).toEqual([0, 1]);
    });

    it('starts a new page for a block that does not fit', () => {
        const blocks = [para(20), para(20)];
        const heights = heightsOf(blocks);
        expect(heights[0] + heights[1]).toBeGreaterThan(usable());
        const pages = view._splitIntoPages(blocks, PAGE_HEIGHT, PAGE_WIDTH);
        expect(pages.map((p) => p.map((b) => b.index))).toEqual([[0], [1]]);
    });

    // THE invariant. A page that runs past the sheet hides its tail behind a
    // scroll the reader never makes, and Alt+→ skips it.
    it('never overfills a page, except for a block nothing could fit', () => {
        const docs = {
            prose: Array.from({ length: 40 }, (_, i) => para(3 + (i * 7) % 9)),
            sections: Array.from({ length: 24 }, (_, i) =>
                i % 2 ? para(6 + (i * 5) % 11) : `## Section ${i}`),
            reference: Array.from({ length: 40 }, (_, i) =>
                [`## Section ${i}`, para(4), para(19), para(5)][i % 4]),
            halfPages: Array.from({ length: 20 }, () => para(13)),
        };
        for (const [name, blocks] of Object.entries(docs)) {
            const heights = heightsOf(blocks);
            const pages = view._splitIntoPages(blocks, PAGE_HEIGHT, PAGE_WIDTH);
            for (const page of pages) {
                const fill = page.reduce((n, b) => n + heights[b.index], 0);
                if (fill > usable()) {
                    // Two excuses, both unavoidable: a block taller than a whole
                    // sheet, or a last block preceded only by the headings that
                    // introduce it (breaking there would waste a whole page on
                    // those headings).
                    const where = `${name}: ${JSON.stringify(page.map((b) => b.index))}`;
                    const giant = page.some((b) => heights[b.index] > usable());
                    const leadIsHeadings = page.slice(0, -1).length > 0
                        && page.slice(0, -1).every((b) => /^#{1,6}\s/.test(blocks[b.index]));
                    expect(giant || leadIsHeadings, where).toBe(true);
                }
            }
        }
    });

    // A page taller than the sheet scrolls, and .stf__page keeps that offset on
    // the element — so flipping back to a page you had scrolled dropped you into
    // its middle instead of its start.
    it('puts a turned-to spread back at its top', () => {
        const host = document.getElementById('host');
        const make = (i) => {
            const el = document.createElement('div');
            el.className = 'stf__page';
            el.dataset.pageIndex = String(i);
            el.scrollTop = 120;
            host.appendChild(el);
            return el;
        };
        const [p0, p1, p2] = [make(0), make(1), make(2)];
        view.container = host;

        view._resetSpreadScroll(0);
        expect(p0.scrollTop).toBe(0);
        expect(p1.scrollTop).toBe(0);   // the right half of the spread too
        expect(p2.scrollTop).toBe(120); // untouched
    });

    // The reported spread: page 1 ended on `## 0. 総合評価` with two thirds of the
    // sheet blank and its table opened page 2. Reserving only a line or two
    // after a heading was meaningless — a block is atomic, so a 400px table
    // either fits beside the heading or does not.
    it('keeps a heading with the whole block that follows it', () => {
        const texts = ['intro', '## 0. Overview', 'TABLE', 'after'];
        const heights = [Math.round(usable() * 0.55), 55, Math.round(usable() * 0.5), 90];
        view._measureBlockHeights = () => heights;
        const pages = view._splitIntoPages(texts, PAGE_HEIGHT, PAGE_WIDTH);

        const headingPage = pages.findIndex((p) => p.some((b) => b.index === 1));
        const tablePage = pages.findIndex((p) => p.some((b) => b.index === 2));
        expect(headingPage).toBe(tablePage);
        // …and the heading did move on rather than stay above the hole.
        expect(headingPage).toBeGreaterThan(0);
    });

    // A run of headings travels together: flushing between them would leave the
    // outer one alone on a page of its own.
    it('never leaves a page holding nothing but headings', () => {
        const texts = ['## Section', '### Sub', 'TABLE'];
        const heights = [55, 45, Math.round(usable() * 0.95)];
        view._measureBlockHeights = () => heights;
        const pages = view._splitIntoPages(texts, PAGE_HEIGHT, PAGE_WIDTH);
        for (const page of pages) {
            expect(page.every((b) => /^#{1,6}\s/.test(texts[b.index]))).toBe(false);
        }
    });

    // The reported spread: the left page ended on `## 1. 全体像` with three
    // quarters of the sheet blank, because the heading check only looked ONE
    // block ahead — it passed against the small `### 1.1` under it, which then
    // broke away with its tall table and abandoned it.
    it('looks past a stack of headings to the content underneath', () => {
        const texts = [
            '> note',
            '## 1. Overview',
            '### 1.1 Files',
            'TABLE',
            'trailing paragraph',
        ];
        // The table is tall enough that it cannot share the page with the
        // note above, but the two headings and it still fit together.
        const heights = [100, 55, 40, Math.round(usable() * 0.8), 60];
        view._measureBlockHeights = () => heights;
        const pages = view._splitIntoPages(texts, PAGE_HEIGHT, PAGE_WIDTH);

        const at = (i) => pages.findIndex((p) => p.some((b) => b.index === i));
        expect(at(1), 'the two headings and the table travel together')
            .toBe(at(2));
        expect(at(2)).toBe(at(3));
        // …and doing so did not push the page over the fold.
        const group = pages[at(1)];
        expect(group.reduce((n, b) => n + heights[b.index], 0))
            .toBeLessThanOrEqual(usable());
    });

    // THE invariant, whatever route the break took. _liftTrailingHeadings is
    // the backstop that makes it unconditional.
    it('never ends a page on a heading', () => {
        const docs = {
            reported: [['> note', 100], ['## 1. Overview', 55], ['### 1.1', 40],
                ['TABLE', Math.round(usable() * 0.87)], ['tail', 60]],
            stacked: [['body', 200], ['# A', 60], ['## B', 45], ['### C', 40],
                ['TABLE', Math.round(usable() * 0.9)], ['tail', 80]],
            giants: [['body', 300], ['## A', 55],
                ['GIANT', Math.round(usable() * 1.6)], ['## B', 55], ['body2', 400]],
        };
        for (const [name, doc] of Object.entries(docs)) {
            const texts = doc.map((d) => d[0]);
            const heights = doc.map((d) => d[1]);
            view._measureBlockHeights = () => heights;
            const pages = view._splitIntoPages(texts, PAGE_HEIGHT, PAGE_WIDTH);
            for (let i = 0; i < pages.length - 1; i++) {
                const last = pages[i][pages[i].length - 1];
                expect(/^#{1,6}\s/.test(texts[last.index]),
                    `${name}: page ${i} ends on "${texts[last.index]}"`).toBe(false);
            }
        }
    });

    it('starts a chapter heading on a fresh page when the page is mostly full', () => {
        const blocks = [para(18), '# Chapter 2', para(4)];
        const pages = view._splitIntoPages(blocks, PAGE_HEIGHT, PAGE_WIDTH);
        const chapterPage = pages.findIndex((p) => p.some((b) => b.index === 1));
        expect(chapterPage).toBeGreaterThan(0);
        // …and its body rides along on the same page.
        expect(pages[chapterPage].map((b) => b.index)).toEqual([1, 2]);
    });
});
