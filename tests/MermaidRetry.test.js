/* What renderMermaid does with a diagram it could not draw.
 *
 * Book mode folds away every page but the open spread, and mermaid sizes its
 * labels with getBBox, which measures nothing inside a display:none subtree.
 * So the diagrams on folded pages fail on the first pass no matter what — the
 * question is only whether they can still be drawn once their page opens.
 *
 * Measured against the bundled mermaid 11.12.2 with the README's own diagram:
 *
 *     parse                 OK
 *     render while open     ok
 *     render while folded   ERROR
 *     same node, revealed   ERROR     <- resetting text + marks is not enough
 *     fresh node            ok
 *     trivial diagram after ok        <- mermaid's own state is fine
 *
 * mermaid is stubbed here: these tests are about our recovery, not about its
 * renderer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderMermaid } from '../src/modules/utils/Markdown.js';

const SRC = 'graph TD\n  A --> B';

/** Stand in for mermaid: `run` decides whether each node renders or fails. */
function stubMermaid({ fail, parses = true }) {
    globalThis.mermaid = {
        initialize: () => {},
        parse: async () => {
            if (!parses) throw new Error('Parse error on line 2');
            return true;
        },
        run: async ({ nodes }) => {
            for (const n of nodes) {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                if (fail) {
                    svg.setAttribute('aria-roledescription', 'error');
                    svg.textContent = 'Syntax error in text';
                } else {
                    svg.setAttribute('viewBox', '0 0 100 50');
                }
                n.textContent = '';
                n.appendChild(svg);
                n.setAttribute('data-processed', 'true');
            }
        },
    };
}

const host = () => {
    const div = document.createElement('div');
    div.innerHTML = '<div class="mermaid"></div>';
    div.querySelector('.mermaid').textContent = SRC;
    document.body.appendChild(div);
    return div;
};

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));

afterEach(() => {
    document.body.innerHTML = '';
    delete globalThis.mermaid;
    vi.restoreAllMocks();
});

describe('a diagram that could not be drawn', () => {
    // Left as it is, the error graphic counts as a rendered diagram:
    // querySelector('svg') finds it, so every later pass skips the node and
    // turning to the page never helps.
    it('does not keep the error graphic', async () => {
        stubMermaid({ fail: true });
        const h = host();

        await renderMermaid(h);

        expect(h.querySelector('svg'), 'the bomb must not be left behind').toBeNull();
        expect(h.textContent).toContain('graph TD');
    });

    // The element itself is spent — mermaid keeps refusing one it already gave
    // up on, however the content is put back. Only a new element draws.
    it('is handed a fresh element to try again with', async () => {
        stubMermaid({ fail: true });
        const h = host();
        const original = h.querySelector('.mermaid');

        await renderMermaid(h);

        const now = h.querySelector('.mermaid');
        expect(now, 'no node left to retry with').toBeTruthy();
        expect(now).not.toBe(original);
        expect(now.getAttribute('data-processed')).toBeNull();
        expect(now.id, 'a reused id is refused; the next pass assigns one').toBe('');
        expect(now.dataset.mermaidSrc).toBe(SRC);
    });

    it('draws on the second pass, once the page is open', async () => {
        stubMermaid({ fail: true });
        const h = host();
        await renderMermaid(h);

        // The page has been turned to; mermaid can measure now.
        stubMermaid({ fail: false });
        await renderMermaid(h);

        const svg = h.querySelector('svg');
        expect(svg, 'the retry produced nothing').toBeTruthy();
        expect(svg.getAttribute('aria-roledescription')).not.toBe('error');
    });
});

describe('a diagram that is actually broken', () => {
    // Retrying something that cannot succeed only fills the console, and the
    // error is what tells the author their syntax is wrong.
    it('keeps the error rather than looping on it', async () => {
        stubMermaid({ fail: true, parses: false });
        const h = host();

        await renderMermaid(h);

        const svg = h.querySelector('svg');
        expect(svg, 'the author needs to see the failure').toBeTruthy();
        expect(svg.getAttribute('aria-roledescription')).toBe('error');
    });

    it('says what mermaid objected to', async () => {
        stubMermaid({ fail: true, parses: false });
        await renderMermaid(host());

        const said = console.error.mock.calls.flat().join(' ');
        expect(said).toContain('Parse error on line 2');
        expect(said, 'the source is half the report').toContain('graph TD');
    });
});

describe('drawing the same diagram twice', () => {
    // Nodes are collected before the call joins the queue, so two overlapping
    // calls both hold the same list. Handing mermaid an element that is
    // already an <svg> makes it parse that SVG — the phantom syntax error.
    it('skips what another pass already finished', async () => {
        stubMermaid({ fail: false });
        const h = host();

        await Promise.all([renderMermaid(h), renderMermaid(h)]);

        expect(h.querySelectorAll('svg').length).toBe(1);
    });
});
