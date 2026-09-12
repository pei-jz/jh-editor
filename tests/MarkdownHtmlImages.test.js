/* Images written as raw HTML inside a Markdown document.
 *
 * marked's `renderer.image` only sees its own `![](…)` syntax. A document that
 * writes `<img src="docs/images/x.png">` — which this project's own README
 * does, for the width attribute — passes through untouched, and the relative
 * path is then resolved against the app's origin rather than the document's
 * folder.
 *
 * Under `tauri dev` that happens to work: Vite serves the project directory,
 * so `http://localhost:1425/docs/images/x.png` exists. In a packaged build the
 * origin is the bundled dist, where it does not. Measured in the installed
 * app, the difference was exactly this:
 *
 *     URL (convertFileSrc)  http://asset.localhost/C%3A%2F…%2Fhero-light.png
 *     fetch                 200 OK        — scope and CSP both fine
 *     img src               http://tauri.localhost/docs/images/hero-light.png
 *     img naturalWidth      0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// convertFileSrc needs a Tauri runtime; stand in for it so the rewrite itself
// is what gets tested.
vi.mock('@tauri-apps/api/core', () => ({
    convertFileSrc: (p) => `http://asset.localhost/${encodeURIComponent(p)}`,
    invoke: vi.fn(),
}));

const { resolveHtmlImages, resolveImageSrc } = await import(
    '../src/modules/utils/MarkdownAssets.js');

const DOC = 'C:/work/notes/README.md';
const srcOf = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html;
    return t.content.querySelector('img')?.getAttribute('src');
};

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('raw <img> in a Markdown document', () => {
    it('is pointed at the file the document meant', () => {
        const out = resolveHtmlImages(
            '<img src="docs/images/hero.png" width="820">', DOC);

        expect(srcOf(out)).toContain('asset.localhost');
        expect(decodeURIComponent(srcOf(out)))
            .toContain('C:/work/notes/docs/images/hero.png');
    });

    it('keeps the attributes the document asked for', () => {
        const out = resolveHtmlImages(
            '<img src="a.png" width="820" alt="A grid">', DOC);

        const t = document.createElement('template');
        t.innerHTML = out;
        const img = t.content.querySelector('img');
        expect(img.getAttribute('width')).toBe('820');
        expect(img.getAttribute('alt')).toBe('A grid');
    });

    // Anything marked produced has already been through convertFileSrc, and a
    // document may link an image on the web. Neither should be touched.
    it('leaves an address that is already absolute alone', () => {
        for (const src of [
            'https://example.com/a.png',
            'http://asset.localhost/C%3A%2Fx.png',
            'data:image/png;base64,AAAA',
        ]) {
            expect(srcOf(resolveHtmlImages(`<img src="${src}">`, DOC))).toBe(src);
        }
    });

    // <picture> carries its candidates on <source>, each with its own
    // descriptor — the URL is only the first token of an entry.
    it('resolves the candidates a <picture> offers', () => {
        const out = resolveHtmlImages(
            '<picture><source srcset="img/a.png 1x, img/b.png 2x">'
            + '<img src="img/a.png"></picture>', DOC);

        const t = document.createElement('template');
        t.innerHTML = out;
        const set = t.content.querySelector('source').getAttribute('srcset');

        expect(set).toContain('asset.localhost');
        expect(set, 'the descriptor tells the browser which one to pick')
            .toMatch(/1x/);
        expect(set).toMatch(/2x/);
        expect(set.split(',').length).toBe(2);
    });

    it('is left as it is when there is nothing to resolve', () => {
        const html = '<p>no pictures here</p>';
        expect(resolveHtmlImages(html, DOC)).toBe(html);
    });
});

describe('Markdown image syntax', () => {
    // The two paths have to agree, or the same file resolves differently
    // depending on how it was written.
    it('resolves to the same address as the raw tag', () => {
        const viaMarkdown = resolveImageSrc('docs/images/hero.png', DOC);
        const viaHtml = srcOf(
            resolveHtmlImages('<img src="docs/images/hero.png">', DOC));
        expect(viaHtml).toBe(viaMarkdown);
    });
});
