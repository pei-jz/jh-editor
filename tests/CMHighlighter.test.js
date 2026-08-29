import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { highlightCode, escapeHtml, supportedLanguages } from '../src/modules/utils/CMHighlighter.js';
import { SyntaxHighlighter } from '../src/modules/utils/SyntaxHighlighter.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/* Two engines did this job: CodeMirror inside the editor, shiki everywhere
   else. shiki shipped 6.8 MB of TextMate grammars for languages nothing here
   asked for, and burned its colours into style="color:#…" so the output could
   not follow the app's themes. The editor's own parsers do both jobs now. */

describe('highlighting code', () => {
    /** Token classes in the output, without the tok- prefix. */
    const tokens = (html) => [...html.matchAll(/class="([^"]+)"/g)]
        .flatMap((m) => m[1].split(/\s+/))
        .filter((c) => c.startsWith('tok-'))
        .map((c) => c.slice(4));

    it('colours the languages the editor itself knows', () => {
        for (const [code, lang] of [
            ['const a = 1;', 'js'],
            ['x = 1', 'python'],
            ['SELECT 1 FROM t', 'sql'],
            ['fn main() {}', 'rs'],
            ['{"a": 1}', 'json'],
            ['a: 1', 'yaml'],
        ]) {
            expect(tokens(highlightCode(code, lang)).length, lang).toBeGreaterThan(0);
        }
    });

    /* These are the ones shiki used to cover and CodeMirror's own packages do
       not. They come from @codemirror/legacy-modes, and getting the wrapper
       wrong is silent: StreamLanguage.define() IS the Language, while a
       lang-* package wraps it in `.language`, so reading only `.language` left
       every one of them falling through to plain text. */
    it('colours the ones that come from the legacy modes', () => {
        for (const [code, lang] of [
            ['echo $PWD', 'bash'],
            ['func main() {}', 'go'],
            ['def f; end', 'ruby'],
            ['a = 1', 'toml'],
            ['FROM node:20', 'dockerfile'],
            ['Write-Host 1', 'powershell'],
            ['key=value', 'ini'],
        ]) {
            expect(tokens(highlightCode(code, lang)).length, lang).toBeGreaterThan(0);
        }
    });

    it('reads a fence tag as well as a file extension', () => {
        expect(highlightCode('const a=1', 'javascript')).toContain('tok-');
        expect(highlightCode('const a=1', 'js')).toContain('tok-');
        expect(highlightCode('const a=1', '.JS')).toContain('tok-');
    });

    // Plain text is readable; a wrong grammar is not.
    it('falls back to escaped text rather than guessing', () => {
        expect(highlightCode('<b>&</b>', 'nosuchlang')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
        expect(highlightCode('a < b', '')).toBe('a &lt; b');
        expect(highlightCode('a < b', null)).toBe('a &lt; b');
    });

    it('escapes what it colours, too', () => {
        const html = highlightCode('const s = "<script>";', 'js');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('handles empty and null input without throwing', () => {
        expect(highlightCode('', 'js')).toBe('');
        expect(highlightCode(null, 'js')).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('covers more languages than it did before', () => {
        // The old map had ~25 extensions; the point of the move was not to lose
        // the shells and config formats shiki carried.
        expect(supportedLanguages().length).toBeGreaterThan(50);
        for (const lang of ['bash', 'go', 'toml', 'ini', 'dockerfile', 'powershell']) {
            expect(supportedLanguages(), lang).toContain(lang);
        }
    });
});

describe('the app-wide façade', () => {
    it('routes every caller to the same engine', () => {
        const src = read('src/modules/utils/SyntaxHighlighter.js');
        expect(src).toContain("from './CMHighlighter.js'");
        expect(src).not.toContain('Shiki');
        expect(SyntaxHighlighter.highlight('const a=1', 'js')).toContain('tok-');
    });

    // Several views await init() before their first render.
    it('keeps init() so existing callers still work', async () => {
        await expect(SyntaxHighlighter.init()).resolves.toBe(true);
    });
});

describe('shiki is gone', () => {
    it('is not imported anywhere', () => {
        for (const f of [
            'src/modules/utils/SyntaxHighlighter.js',
            'src/modules/editors/DiffEditor.js',
            'src/modules/views/CodeMirrorView.js',
            'src/modules/views/MarkdownView.js',
            'src/modules/ui/InlineAI.js',
            'src/modules/utils/Markdown.js',
        ]) {
            expect(read(f), f).not.toMatch(/ShikiHighlighter|from ['"]shiki/);
        }
    });

    it('is not a dependency', () => {
        const pkg = JSON.parse(read('package.json'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        expect(Object.keys(deps)).not.toContain('shiki');
        // ...and the chunking rule that existed only to keep it out of vendor.
        expect(read('vite.config.js')).not.toContain("id.includes('shikijs')");
    });
});

/* The token colours were two hard-coded One Dark palettes, chosen by
   `body:not(.theme-dark):not(.theme-midnight):not(.theme-solarized-dark)` — a
   hand-written list of dark themes that never kept up. Bamboo, sumi-e, nord and
   hanging-scroll all fell on the wrong side of it. */
describe('token colours follow the theme', () => {
    const css = read('src/styles/editor.css');

    it('takes them from the theme palette, not a fixed one', () => {
        for (const token of ['--hl-keyword', '--hl-string', '--hl-comment', '--hl-function']) {
            expect(css, token).toContain(`var(${token})`);
        }
    });

    it('keeps no hand-written list of dark themes', () => {
        // Only SELECTORS count: the comment above the block quotes the old one
        // so the reason it went is on the record.
        const selectors = css.split('\n').filter((l) => l.includes('{'));
        expect(selectors.join('\n')).not.toContain(':not(.theme-midnight)');
    });

    // They are no longer scoped to BookMode: the same classes are used by the
    // preview, the diff panes and inline AI.
    it('applies outside the printed page', () => {
        expect(css).toMatch(/\n\.tok-keyword,/);
        expect(css).not.toContain('.stf__page .tok-keyword');
    });
});
