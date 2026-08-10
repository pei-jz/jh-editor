import { describe, it, expect, beforeEach, vi } from 'vitest';

// KaTeX itself is third-party; stub it so the tests assert OUR logic — which
// fragments get treated as math, display vs inline, and that the surrounding
// markup survives.
const renderCalls = [];
vi.mock('katex', () => ({
    default: {
        render(src, el, opts) {
            renderCalls.push({ src, display: !!(opts && opts.displayMode) });
            el.className = 'katex';
            el.textContent = `⟪${src}⟫`;
        },
    },
}));
vi.mock('katex/dist/katex.min.css', () => ({}));

const { renderMath, ensureKatex } = await import('../src/modules/utils/MarkdownAssets.js');

const div = (html) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
};

describe('MarkdownAssets — math rendering', () => {
    beforeEach(() => { renderCalls.length = 0; });

    it('renders inline $…$', async () => {
        const el = div('<p>value $a_1$ here</p>');
        await renderMath(el);
        expect(renderCalls).toEqual([{ src: 'a_1', display: false }]);
        expect(el.textContent).toBe('value ⟪a_1⟫ here');
    });

    it('renders display $$…$$ in display mode', async () => {
        const el = div('<p>$$x^2$$</p>');
        await renderMath(el);
        expect(renderCalls).toEqual([{ src: 'x^2', display: true }]);
    });

    it('prefers $$ over $ so a display block is not split', async () => {
        const el = div('<p>$$a + b$$</p>');
        await renderMath(el);
        expect(renderCalls).toHaveLength(1);
        expect(renderCalls[0].display).toBe(true);
    });

    it('handles several expressions in one text node', async () => {
        const el = div('<p>$a$ and $b$</p>');
        await renderMath(el);
        expect(renderCalls.map(c => c.src)).toEqual(['a', 'b']);
    });

    it('leaves code and pre alone — $ is just a character there', async () => {
        const el = div('<pre><code>cost is $5 and $6</code></pre>');
        await renderMath(el);
        expect(renderCalls).toHaveLength(0);
        expect(el.textContent).toBe('cost is $5 and $6');
    });

    it('skips mermaid blocks', async () => {
        const el = div('<div class="mermaid">graph TD; A-->B; $x$</div>');
        await renderMath(el);
        expect(renderCalls).toHaveLength(0);
    });

    it('preserves the surrounding element structure', async () => {
        const el = div('<p><strong>bold</strong> $x$ tail</p>');
        await renderMath(el);
        expect(el.querySelector('strong')).not.toBeNull();
        expect(el.querySelector('.katex')).not.toBeNull();
    });

    it('does nothing when there is no math', async () => {
        const el = div('<p>plain text</p>');
        await renderMath(el);
        expect(renderCalls).toHaveLength(0);
        expect(el.innerHTML).toBe('<p>plain text</p>');
    });

    it('tolerates a null container', async () => {
        await expect(renderMath(null)).resolves.toBeUndefined();
    });

    it('caches the lazily loaded library', async () => {
        const a = await ensureKatex();
        const b = await ensureKatex();
        expect(a).toBe(b);
    });
});
