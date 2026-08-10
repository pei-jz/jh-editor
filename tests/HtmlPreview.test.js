import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
    convertFileSrc: (p) => `asset://localhost/${p}`,
}));
vi.mock('../src/modules/utils/FileSystem.js', () => ({
    getParentDir: (p) => String(p).replace(/\\/g, '/').replace(/\/[^/]*$/, ''),
}));

const {
    resolveRelative, rewriteRelativeUrls, buildPreviewDocument,
    sandboxFor, scriptsEnabled, setScriptsEnabled,
} = await import('../src/modules/ui/HtmlPreview.js');

const DOC = '/ws/site/index.html';

describe('HtmlPreview — resolving relative references', () => {
    it('resolves a sibling file against the document folder', () => {
        expect(resolveRelative('style.css', DOC)).toBe('asset://localhost//ws/site/style.css');
    });

    it('resolves a subfolder path', () => {
        expect(resolveRelative('img/logo.png', DOC)).toBe('asset://localhost//ws/site/img/logo.png');
    });

    it('resolves ./ and ../ segments', () => {
        expect(resolveRelative('./a.css', DOC)).toBe('asset://localhost//ws/site/a.css');
        expect(resolveRelative('../shared/a.css', DOC)).toBe('asset://localhost//ws/shared/a.css');
    });

    it('keeps a query string / fragment attached', () => {
        expect(resolveRelative('a.css?v=2', DOC)).toBe('asset://localhost//ws/site/a.css?v=2');
        expect(resolveRelative('a.html#top', DOC)).toBe('asset://localhost//ws/site/a.html#top');
    });

    it.each([
        'https://cdn/x.css', 'http://x/y.png', '//cdn/x.js',
        'data:image/png;base64,AA', 'blob:abc', 'mailto:a@b.c', '#anchor',
    ])('leaves %s untouched', (u) => {
        expect(resolveRelative(u, DOC)).toBe(u);
    });

    it('passes through when there is no document path', () => {
        expect(resolveRelative('a.css', null)).toBe('a.css');
    });

    it('passes through empty input', () => {
        expect(resolveRelative('', DOC)).toBe('');
    });
});

describe('HtmlPreview — rewriting a document', () => {
    it('rewrites src and href attributes', () => {
        const html = '<link href="a.css" rel="stylesheet"><img src="b.png">';
        const out = rewriteRelativeUrls(html, DOC);
        expect(out).toContain('href="asset://localhost//ws/site/a.css"');
        expect(out).toContain('src="asset://localhost//ws/site/b.png"');
    });

    it('handles single-quoted attributes', () => {
        expect(rewriteRelativeUrls("<img src='b.png'>", DOC))
            .toContain('src="asset://localhost//ws/site/b.png"');
    });

    it('rewrites poster on media elements', () => {
        expect(rewriteRelativeUrls('<video poster="p.jpg"></video>', DOC))
            .toContain('poster="asset://localhost//ws/site/p.jpg"');
    });

    it('leaves absolute references alone', () => {
        const html = '<script src="https://cdn/x.js"></script>';
        expect(rewriteRelativeUrls(html, DOC)).toBe(html);
    });

    // A live preview re-renders half-typed markup on every keystroke; it must
    // never be "repaired" into something the user didn't write.
    it('does not restructure invalid or partial markup', () => {
        const partial = '<div><p>unclosed <img src="a.png"';
        const out = rewriteRelativeUrls(partial, DOC);
        expect(out.startsWith('<div><p>unclosed <img src="asset://')).toBe(true);
        expect(out).not.toContain('</p>');
        expect(out).not.toContain('<html');
    });

    it('is a no-op without a document path', () => {
        const html = '<img src="a.png">';
        expect(rewriteRelativeUrls(html, null)).toBe(html);
    });
});

describe('HtmlPreview — building the preview document', () => {
    it('rewrites URLs and injects a base into <head>', () => {
        const out = buildPreviewDocument('<html><head><title>t</title></head><body><img src="a.png"></body></html>', DOC);
        expect(out).toContain('<base href="asset://localhost//ws/site/"');
        expect(out).toContain('src="asset://localhost//ws/site/a.png"');
        // The base must precede the resources that might rely on it.
        expect(out.indexOf('<base')).toBeLessThan(out.indexOf('<img'));
    });

    it('creates a head when the document has <html> but no <head>', () => {
        const out = buildPreviewDocument('<html><body>x</body></html>', DOC);
        expect(out).toContain('<head><base');
    });

    it('prefixes a bare fragment', () => {
        expect(buildPreviewDocument('<p>x</p>', DOC).startsWith('<base ')).toBe(true);
    });

    it('handles empty / null input', () => {
        expect(typeof buildPreviewDocument('', DOC)).toBe('string');
        expect(typeof buildPreviewDocument(null, DOC)).toBe('string');
    });
});

describe('HtmlPreview — sandbox policy', () => {
    beforeEach(() => localStorage.clear());

    it('never grants scripts and same-origin together', () => {
        for (const on of [true, false]) {
            const s = sandboxFor(on);
            expect(s.includes('allow-scripts') && s.includes('allow-same-origin')).toBe(false);
        }
    });

    it('allows same-origin (but not scripts) by default', () => {
        expect(sandboxFor(false)).toBe('allow-same-origin');
    });

    it('allows scripts only when explicitly enabled', () => {
        expect(sandboxFor(true)).toBe('allow-scripts');
    });

    it('defaults the script setting to off and persists changes', () => {
        expect(scriptsEnabled()).toBe(false);
        setScriptsEnabled(true);
        expect(scriptsEnabled()).toBe(true);
        setScriptsEnabled(false);
        expect(scriptsEnabled()).toBe(false);
    });
});
