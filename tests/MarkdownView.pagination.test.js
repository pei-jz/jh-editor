import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Book mode used to pack a fixed NUMBER of blocks per page, ignoring how tall
// each one is. Two things went wrong: a page could end on a lone `# heading`
// with its body starting on the next page, and a page holding a few long blocks
// overflowed so page 1 opened already scrolled. _splitIntoPages now packs by
// height and keeps headings with the text that follows them.

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
        // The preceding page must already be reasonably full — an almost
        // empty page keeps the oversized block instead of being wasted.
        const blocks = [para(10), para(200), para(2)];
        const heights = heightsOf(blocks);
        expect(heights[1]).toBeGreaterThan(usable());
        const pages = view._splitIntoPages(blocks, PAGE_HEIGHT, PAGE_WIDTH);
        const giant = pages.find((p) => p.some((b) => b.index === 1));
        expect(giant.map((b) => b.index)).toEqual([1]);
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
