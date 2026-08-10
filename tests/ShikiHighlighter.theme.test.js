import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shiki loads WASM grammars; stub it so the surrounding logic (theme choice,
// language aliasing, escaping, the not-initialised fallback) can be tested.
const codeToHtml = vi.fn(() => '<pre class="shiki"><code><span>OK</span></code></pre>');
const getLoadedLanguages = vi.fn(() => ['javascript', 'xml', 'python']);
vi.mock('shiki', () => ({
    createHighlighter: vi.fn(async () => ({ codeToHtml, getLoadedLanguages })),
}));

const { ShikiHighlighter } = await import('../src/modules/utils/ShikiHighlighter.js');
const { SyntaxHighlighter } = await import('../src/modules/utils/SyntaxHighlighter.js');

describe('ShikiHighlighter — theme selection', () => {
    beforeEach(() => { document.body.className = ''; });

    it.each(['theme-dark', 'theme-midnight', 'theme-solarized-dark'])('%s is dark', (cls) => {
        document.body.className = cls;
        expect(ShikiHighlighter.isDarkTheme()).toBe(true);
        expect(ShikiHighlighter.getActiveTheme()).toBe('github-dark-high-contrast');
    });

    it.each(['', 'theme-latte', 'theme-solarized-light', 'theme-paper', 'theme-paper-subtle'])(
        '"%s" is light', (cls) => {
            document.body.className = cls;
            expect(ShikiHighlighter.isDarkTheme()).toBe(false);
            expect(ShikiHighlighter.getActiveTheme()).toBe('github-light');
        });
});

describe('ShikiHighlighter — language aliases', () => {
    it.each([
        ['js', 'javascript'], ['jsx', 'javascript'],
        ['ts', 'typescript'], ['tsx', 'typescript'],
        ['rs', 'rust'], ['py', 'python'],
        ['xsd', 'xml'], ['wsdl', 'xml'],
        ['properties', 'ini'], ['sh', 'shell'],
        ['c++', 'cpp'], ['c#', 'csharp'],
        ['docker', 'dockerfile'], ['ps1', 'powershell'],
    ])('maps %s → %s', (from, to) => {
        expect(ShikiHighlighter._mapLang(from)).toBe(to);
    });

    it('passes an unknown language through, lower-cased', () => {
        expect(ShikiHighlighter._mapLang('JAVA')).toBe('java');
        expect(ShikiHighlighter._mapLang('weird')).toBe('weird');
    });
});

describe('ShikiHighlighter — escaping', () => {
    it('escapes every HTML-significant character', () => {
        expect(ShikiHighlighter.escapeHtml(`<a href="x">&'`))
            .toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    });

    it('leaves ordinary text alone', () => {
        expect(ShikiHighlighter.escapeHtml('plain text 123')).toBe('plain text 123');
    });
});

describe('ShikiHighlighter — highlight()', () => {
    it('falls back to escaped text before init', () => {
        expect(ShikiHighlighter.highlight('<x>', 'js')).toBe('&lt;x&gt;');
    });

    it('extracts the inner HTML of the pre/code block once initialised', async () => {
        await ShikiHighlighter.init();
        expect(ShikiHighlighter.highlight('const a=1', 'js')).toBe('<span>OK</span>');
    });

    it('reuses the highlighter instead of re-creating it', async () => {
        const { createHighlighter } = await import('shiki');
        const before = createHighlighter.mock.calls.length;
        await ShikiHighlighter.init();
        expect(createHighlighter.mock.calls.length).toBe(before);
    });

    it('escapes instead of throwing for a language shiki has not loaded', async () => {
        await ShikiHighlighter.init();
        expect(ShikiHighlighter.highlight('<x>', 'brainfuck')).toBe('&lt;x&gt;');
    });

    it('escapes when shiki itself throws', async () => {
        await ShikiHighlighter.init();
        codeToHtml.mockImplementationOnce(() => { throw new Error('boom'); });
        expect(ShikiHighlighter.highlight('<x>', 'js')).toBe('&lt;x&gt;');
    });

    it('returns the raw html when the pre/code shape is unexpected', async () => {
        await ShikiHighlighter.init();
        codeToHtml.mockImplementationOnce(() => '<div>odd</div>');
        expect(ShikiHighlighter.highlight('x', 'js')).toBe('<div>odd</div>');
    });
});

describe('SyntaxHighlighter — delegates to Shiki with the active theme', () => {
    beforeEach(() => { document.body.className = ''; codeToHtml.mockClear(); });

    it('passes the light theme through', async () => {
        await SyntaxHighlighter.init();
        SyntaxHighlighter.highlight('const a=1', 'js');
        expect(codeToHtml.mock.calls[0][1].theme).toBe('github-light');
    });

    it('passes the dark theme through', async () => {
        document.body.className = 'theme-dark';
        await SyntaxHighlighter.init();
        SyntaxHighlighter.highlight('const a=1', 'js');
        expect(codeToHtml.mock.calls[0][1].theme).toBe('github-dark-high-contrast');
    });

    it('forwards escapeHtml', () => {
        expect(SyntaxHighlighter.escapeHtml('<b>')).toBe('&lt;b&gt;');
    });
});
