import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureMarkdown, initMermaid, renderMermaid } from '../src/modules/utils/Markdown.js';

// `marked` and `mermaid` are loaded as page globals (script tags), so the tests
// install stubs on globalThis rather than mocking a module.
let markedUse, mermaidInit, mermaidRun;

const installGlobals = () => {
    markedUse = vi.fn();
    mermaidInit = vi.fn();
    mermaidRun = vi.fn(async () => {});
    globalThis.marked = { use: markedUse };
    globalThis.mermaid = { initialize: mermaidInit, run: mermaidRun };
};

const clearGlobals = () => {
    delete globalThis.marked;
    delete globalThis.mermaid;
};

beforeEach(() => {
    installGlobals();
    document.body.className = '';
    document.body.innerHTML = '';
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { clearGlobals(); vi.restoreAllMocks(); });

describe('configureMarkdown', () => {
    it('registers options with marked', () => {
        configureMarkdown();
        expect(markedUse).toHaveBeenCalledTimes(1);
        const cfg = markedUse.mock.calls[0][0];
        expect(cfg.gfm).toBe(true);
        expect(cfg.breaks).toBe(true);
        expect(cfg.pedantic).toBe(false);
    });

    it('is a no-op (and complains) when marked is missing', () => {
        delete globalThis.marked;
        expect(() => configureMarkdown()).not.toThrow();
        expect(console.error).toHaveBeenCalled();
    });

    describe('code renderer', () => {
        const codeRenderer = () => {
            configureMarkdown();
            return markedUse.mock.calls[0][0].renderer.code;
        };

        /* The source is ESCAPED into the div, not interpolated raw. Mermaid
           labels legitimately contain markup — `A[Editor.js<br/>tabs]` is how
           you get two lines in a node — and injecting the fence as HTML let the
           browser consume that `<br/>` as a real element before mermaid ever
           saw it. What reached the parser was `A[Editor.jstabs, panes]`: a
           comma in an unquoted label, i.e. "Syntax error in text" on the first
           render, which then "fixed itself" on a later one. */
        it('wraps an explicit ```mermaid block, escaped', () => {
            expect(codeRenderer()('graph TD; A-->B;', 'mermaid'))
                .toBe('<div class="mermaid">graph TD; A--&gt;B;</div>');
        });

        it('hands mermaid back the markup its labels rely on', () => {
            const html = codeRenderer()('graph TB\n A[Editor.js<br/>tabs]', 'mermaid');
            const div = document.createElement('div');
            div.innerHTML = html;
            // textContent is what mermaid.run() parses.
            expect(div.querySelector('.mermaid').textContent)
                .toBe('graph TB\n A[Editor.js<br/>tabs]');
        });

        it('detects diagram syntax even without the language tag', () => {
            expect(codeRenderer()('sequenceDiagram\n A->>B: hi', ''))
                .toContain('class="mermaid"');
        });

        it.each(['graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'gantt', 'pie', 'erDiagram', 'flowchart'])(
            'recognises %s', (kw) => {
                expect(codeRenderer()(`${kw} X`, '')).toContain('class="mermaid"');
            });

        it('defers ordinary code to the default renderer', () => {
            expect(codeRenderer()('const a = 1;', 'js')).toBe(false);
        });

        it('accepts marked v5+ token objects', () => {
            expect(codeRenderer()({ text: 'graph TD; A-->B;', lang: 'mermaid' }))
                .toContain('class="mermaid"');
        });

        it('accepts a token object that uses `code` instead of `text`', () => {
            expect(codeRenderer()({ code: 'graph TD; A-->B;', lang: 'mermaid' }))
                .toContain('class="mermaid"');
        });

        it('takes only the first word of the info string', () => {
            expect(codeRenderer()('graph TD;', 'mermaid something-else'))
                .toContain('class="mermaid"');
        });
    });
});

describe('initMermaid', () => {
    it('initialises with the light theme by default', () => {
        initMermaid();
        expect(mermaidInit).toHaveBeenCalledWith(expect.objectContaining({ theme: 'default', startOnLoad: false }));
    });

    it.each(['theme-dark', 'theme-midnight', 'theme-solarized-dark'])('uses the dark theme for %s', (cls) => {
        document.body.className = cls;
        initMermaid();
        expect(mermaidInit.mock.calls[0][0].theme).toBe('dark');
    });

    it('is a no-op when mermaid is missing', () => {
        delete globalThis.mermaid;
        expect(() => initMermaid()).not.toThrow();
        expect(console.error).toHaveBeenCalled();
    });

    it('survives mermaid throwing during initialize', () => {
        mermaidInit.mockImplementation(() => { throw new Error('bad config'); });
        expect(() => initMermaid()).not.toThrow();
        expect(console.error).toHaveBeenCalled();
    });
});

describe('renderMermaid', () => {
    it('renders .mermaid nodes', async () => {
        document.body.innerHTML = '<div class="mermaid">graph TD; A-->B;</div>';
        await renderMermaid(document);
        expect(mermaidRun).toHaveBeenCalledTimes(1);
        expect(mermaidRun.mock.calls[0][0].nodes).toHaveLength(1);
    });

    it('upgrades <pre><code class="language-mermaid"> into a .mermaid div', async () => {
        document.body.innerHTML = '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>';
        await renderMermaid(document);
        expect(document.querySelector('pre')).toBeNull();
        const div = document.querySelector('.mermaid');
        expect(div).not.toBeNull();
        expect(div.textContent).toBe('graph TD; A-->B;');
    });

    it('does nothing when the container holds no diagrams', async () => {
        document.body.innerHTML = '<p>text</p>';
        await renderMermaid(document);
        expect(mermaidRun).not.toHaveBeenCalled();
    });

    // Mermaid is no longer a page global loaded at startup — it is 2.7 MB that
    // most sessions never draw a diagram with, so renderMermaid fetches it on
    // the first diagram. The contract that matters is unchanged: a document
    // whose diagrams cannot be drawn still renders, quietly.
    it('injects the mermaid bundle on the first diagram', async () => {
        delete globalThis.mermaid;
        document.body.innerHTML = '<div class="mermaid">graph TD;</div>';

        const pending = renderMermaid(document);
        const tag = document.querySelector('script[src="/lib/mermaid.min.js"]');
        expect(tag).not.toBeNull();

        // jsdom does not fetch scripts, so drive the failure path explicitly.
        tag.dispatchEvent(new Event('error'));
        await expect(pending).resolves.toBeUndefined();
        expect(mermaidRun).not.toHaveBeenCalled();
    });

    it('does not inject the bundle when mermaid is already present', async () => {
        // beforeEach only resets <body>; a tag left in <head> by the test above
        // would otherwise be mistaken for one this test caused.
        document.querySelectorAll('script[src="/lib/mermaid.min.js"]').forEach((s) => s.remove());

        document.body.innerHTML = '<div class="mermaid">graph TD;</div>';
        await renderMermaid(document);
        expect(document.querySelector('script[src="/lib/mermaid.min.js"]')).toBeNull();
        expect(mermaidRun).toHaveBeenCalledTimes(1);
    });

    it('swallows render errors so one bad diagram cannot break the page', async () => {
        document.body.innerHTML = '<div class="mermaid">!!!invalid!!!</div>';
        mermaidRun.mockImplementation(async () => { throw new Error('parse error'); });
        await expect(renderMermaid(document)).resolves.toBeUndefined();
        expect(console.error).toHaveBeenCalled();
    });

    it('scopes to the given container', async () => {
        document.body.innerHTML = '<div id="a"><div class="mermaid">graph TD;</div></div><div id="b"></div>';
        await renderMermaid(document.getElementById('b'));
        expect(mermaidRun).not.toHaveBeenCalled();
    });
});

describe('renderMermaid — re-render safety (regressions)', () => {
    it('skips nodes it has already turned into an SVG', async () => {
        // Re-parsing rendered SVG is what produced the phantom
        // "Syntax error in text" in already-drawn blocks.
        document.body.innerHTML = '<div class="mermaid" data-processed="true"><svg></svg></div>';
        await renderMermaid(document);
        expect(mermaidRun).not.toHaveBeenCalled();
    });

    it('skips a node that holds an svg even without the processed flag', async () => {
        document.body.innerHTML = '<div class="mermaid"><svg></svg></div>';
        await renderMermaid(document);
        expect(mermaidRun).not.toHaveBeenCalled();
    });

    it('gives every diagram a unique id (duplicates make mermaid drop one)', async () => {
        document.body.innerHTML = '<div class="mermaid">graph TD;</div><div class="mermaid">pie</div>';
        await renderMermaid(document);
        const ids = Array.from(document.querySelectorAll('.mermaid')).map(n => n.id);
        expect(ids.every(Boolean)).toBe(true);
        expect(new Set(ids).size).toBe(2);
    });

    it('restores the source when mermaid produced nothing', async () => {
        document.body.innerHTML = '<div class="mermaid">graph TD; A-->B;</div>';
        mermaidRun.mockImplementation(async () => { /* draws nothing */ });
        await renderMermaid(document);
        // The block must show its source, not sit there empty.
        expect(document.querySelector('.mermaid').textContent).toBe('graph TD; A-->B;');
    });

    it('restores the source when mermaid throws', async () => {
        document.body.innerHTML = '<div class="mermaid">bad syntax</div>';
        mermaidRun.mockImplementation(async () => { throw new Error('parse'); });
        await renderMermaid(document);
        expect(document.querySelector('.mermaid').textContent).toBe('bad syntax');
    });

    it('serialises overlapping runs (the live preview fires on every keystroke)', async () => {
        document.body.innerHTML = '<div class="mermaid" id="a">graph TD;</div>';
        let active = 0, overlapped = false;
        mermaidRun.mockImplementation(async () => {
            if (active > 0) overlapped = true;
            active++;
            await new Promise(r => setTimeout(r, 5));
            active--;
        });
        const first = renderMermaid(document);
        document.body.innerHTML += '<div class="mermaid" id="b">pie</div>';
        const second = renderMermaid(document);
        await Promise.all([first, second]);
        expect(overlapped).toBe(false);
    });

    it('normalises a percentage height (mindmap collapsed to 0 otherwise)', async () => {
        document.body.innerHTML = '<div class="mermaid">mindmap</div>';
        mermaidRun.mockImplementation(async ({ nodes }) => {
            for (const n of nodes) {
                n.innerHTML = '<svg height="100%" viewBox="0 0 400 200"></svg>';
            }
        });
        await renderMermaid(document);
        const svg = document.querySelector('.mermaid svg');
        expect(svg.getAttribute('height')).toBeNull();
        expect(svg.style.height).toMatch(/px$|^auto$/);
    });

    it('leaves a concrete pixel height alone', async () => {
        document.body.innerHTML = '<div class="mermaid">graph TD;</div>';
        mermaidRun.mockImplementation(async ({ nodes }) => {
            for (const n of nodes) n.innerHTML = '<svg height="250" viewBox="0 0 400 250"></svg>';
        });
        await renderMermaid(document);
        expect(document.querySelector('.mermaid svg').getAttribute('height')).toBe('250');
    });
});
