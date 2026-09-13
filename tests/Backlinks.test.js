import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { backlinkQuery } from '../src/modules/utils/Backlinks.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/* Backlinks matched `[[Name]]` only. The repository they were tried on links
   its notices file the ordinary way, so the search found nothing. */
describe('backlink pattern', () => {
    const q = backlinkQuery('C:\\ws\\THIRD-PARTY-NOTICES.md');
    const re = new RegExp(q.pattern, 'i');

    it('is titled with the file name, extension included', () => {
        expect(q.label).toBe('THIRD-PARTY-NOTICES.md');
    });

    it.each([
        '一覧は [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) にあります。',
        'see [notices](THIRD-PARTY-NOTICES.md)',
        'see [notices](../docs/THIRD-PARTY-NOTICES.md#section-1)',
        'see [notices](<THIRD-PARTY-NOTICES.md> "title")',
        '[notices]: ./THIRD-PARTY-NOTICES.md',
        '[[THIRD-PARTY-NOTICES]]',
        '[[THIRD-PARTY-NOTICES.md]]',
        '[[docs/THIRD-PARTY-NOTICES|the notices]]',
        '[[THIRD-PARTY-NOTICES#licences]]',
        'lower case [x](./third-party-notices.md)',
    ])('finds %s', (line) => {
        expect(re.test(line)).toBe(true);
    });

    it.each([
        // A mention is not a link.
        'update `THIRD-PARTY-NOTICES.md` when adding a binary',
        // A different file whose name merely ends the same way.
        '[x](./MY-THIRD-PARTY-NOTICES.md)',
        '[[MY-THIRD-PARTY-NOTICES]]',
        // A different file whose name merely starts the same way.
        '[x](./THIRD-PARTY-NOTICES.md.bak)',
        '[[THIRD-PARTY-NOTICES-old]]',
    ])('ignores %s', (line) => {
        expect(re.test(line)).toBe(false);
    });

    it('accepts a space written either way', () => {
        const spaced = new RegExp(backlinkQuery('/ws/My Notes.md').pattern, 'i');
        expect(spaced.test('[a](My%20Notes.md)')).toBe(true);
        expect(spaced.test('[[My Notes]]')).toBe(true);
    });

    it('treats regex characters in a name literally', () => {
        const odd = new RegExp(backlinkQuery('/ws/a+b (1).md').pattern, 'i');
        expect(odd.test('[[a+b (1)]]')).toBe(true);
        expect(odd.test('[[aab (1)]]')).toBe(false);
    });

    // Rust's regex crate compiles the same string: nothing JS-only.
    it('uses no syntax the Rust engine lacks', () => {
        expect(q.pattern).not.toMatch(/\(\?<[=!]|\(\?<\w|\(\?=|\(\?!/);
    });
});

/* The results tab registered its grep listeners asynchronously and the grep
   started straight away. A search that finished first — a Markdown-only one
   with no hits takes milliseconds — sent grep-done to nobody. */
describe('the results tab is listening before the search starts', () => {
    it('resolves once both listeners are registered', () => {
        const editor = read('src/modules/core/Editor.js');
        const i = editor.indexOf('window.app.openSearchResults = function');
        const fn = editor.slice(i, editor.indexOf('\n};', i));
        expect(fn).toContain('ready = Promise.all([onMatch, onDone])');
        expect(fn).toContain('return ready;');
    });

    it.each([
        ['src/modules/views/MarkdownView.js', 'await window.app.openSearchResults({'],
        ['src/modules/ui/GrepModal.js', 'await window.app.openSearchResults({ query: q, matches: [], options: opts, searchId, streaming: true });'],
    ])('%s awaits it before start_grep', (file, awaited) => {
        const src = read(file);
        const at = src.indexOf(awaited);
        expect(at).toBeGreaterThan(-1);
        expect(src.indexOf("invoke('start_grep'", at)).toBeGreaterThan(at);
    });

    it('marks hits with the pattern, not the file name shown', () => {
        expect(read('src/modules/views/SearchResultsView.js'))
            .toContain("if (this.file.highlight) return new RegExp(this.file.highlight, 'gi');");
    });
});

/* `overflow` is ignored on a `display: table` box, so a wide table in BookMode
   was cut off at the page edge with no way to reach the rest. */
describe('a wide Markdown table scrolls sideways', () => {
    it('is a block scroll container', () => {
        const css = read('src/styles/editor.css');
        const i = css.indexOf('.md-block table:not(.visual-table-editor) {');
        const rule = css.slice(i, css.indexOf('}', i));
        expect(rule).toContain('display: block;');
        expect(rule).toContain('overflow-x: auto;');
        expect(rule).toContain('width: fit-content;');
        expect(rule).not.toMatch(/\boverflow: hidden/);
    });
});
