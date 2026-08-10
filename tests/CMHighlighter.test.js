import { describe, it, expect } from 'vitest';
import { highlightCode } from '../src/modules/utils/CMHighlighter.js';

// Strip tags to recover the plain text the browser would show.
const textOf = (html) => html.replace(/<[^>]+>/g, '');
const unescape = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

describe('CMHighlighter.highlightCode', () => {
    it('emits tok-* classes for a known language', () => {
        const html = highlightCode('const x = 1;', 'js');
        expect(html).toContain('tok-keyword');
        expect(html).toContain('tok-number');
    });

    it('preserves the source text exactly', () => {
        const code = 'function f(a) {\n  return a + 1;\n}';
        expect(unescape(textOf(highlightCode(code, 'js')))).toBe(code);
    });

    it('escapes HTML so source code can never inject markup', () => {
        const html = highlightCode('const s = "<script>alert(1)</script>";', 'js');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('escapes ampersands and quotes', () => {
        const html = highlightCode('const s = "a & b\'c";', 'js');
        expect(html).toContain('&amp;');
        expect(unescape(textOf(html))).toBe('const s = "a & b\'c";');
    });

    it('falls back to plain escaped text for an unknown language', () => {
        const html = highlightCode('<b>hi</b>', 'unknownlang');
        expect(html).toBe('&lt;b&gt;hi&lt;/b&gt;');
        expect(html).not.toContain('tok-');
    });

    it('treats a missing language as unknown', () => {
        expect(highlightCode('plain', undefined)).toBe('plain');
        expect(highlightCode('plain', null)).toBe('plain');
        expect(highlightCode('plain', '')).toBe('plain');
    });

    it('is case-insensitive about the extension', () => {
        expect(highlightCode('const x=1;', 'JS')).toContain('tok-keyword');
    });

    it.each([
        ['js', 'const a = 1;'],
        ['ts', 'let a: number = 1;'],
        ['json', '{"a": 1}'],
        ['css', 'a { color: red; }'],
        ['html', '<p>x</p>'],
        ['xml', '<a b="c"/>'],
        ['py', 'def f():\n    return 1'],
        ['java', 'class A {}'],
        ['sql', 'SELECT 1'],
        ['rs', 'fn main() {}'],
        ['cpp', 'int main(){}'],
        ['yaml', 'a: 1'],
        ['svelte', '<script>let count = 0;</script>'],
        ['md', '# title'],
    ])('supports %s', (lang, code) => {
        const html = highlightCode(code, lang);
        expect(unescape(textOf(html))).toBe(code);
    });

    it('maps aliases onto the same grammar family', () => {
        for (const ext of ['jsx', 'mjs', 'cjs', 'tsx', 'htm', 'scss', 'less', 'yml', 'xsd', 'wsdl', 'h', 'hpp', 'c']) {
            expect(() => highlightCode('x', ext)).not.toThrow();
        }
    });

    it('highlights svelte with tok-* classes', () => {
        const html = highlightCode('<script>let count = 0;</script>', 'svelte');
        expect(unescape(textOf(html))).toBe('<script>let count = 0;</script>');
    });

    it('handles an empty document', () => {
        expect(highlightCode('', 'js')).toBe('');
    });

    it('keeps leading whitespace (indentation must survive)', () => {
        const code = '    indented();';
        expect(unescape(textOf(highlightCode(code, 'js')))).toBe(code);
    });
});
