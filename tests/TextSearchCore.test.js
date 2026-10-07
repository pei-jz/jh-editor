import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { findAllMatches, replaceAllMatches, CHUNK_SIZE } from '../src/modules/utils/TextSearchCore.js';

// What CodeMirror's own search finds — the worker must agree with it.
function cmMatches(text, opts) {
    const q = new SearchQuery({
        search: opts.query, regexp: opts.isRegex, literal: !opts.isRegex,
        caseSensitive: opts.caseSensitive, wholeWord: opts.wholeWord,
    });
    const cursor = q.getCursor(EditorState.create({ doc: text }));
    const out = [];
    let m;
    while (!(m = cursor.next()).done) out.push([m.value.from, m.value.to]);
    return out;
}

function workerMatches(text, opts) {
    const r = findAllMatches(text, opts);
    return Array.from(r.starts, (s, i) => [s, r.ends[i]]);
}

const base = { isRegex: false, caseSensitive: false, wholeWord: false };
const sample = 'Foo bar foobar\nfoo_bar BAR baz\n日本語 foo.bar\n\nend foo';

describe('findAllMatches agrees with CodeMirror', () => {
    const cases = [
        { query: 'foo' },
        { query: 'foo', caseSensitive: true },
        { query: 'bar', wholeWord: true },
        { query: 'foo.bar' },
        { query: 'fo+', isRegex: true },
        { query: '^foo', isRegex: true },
        { query: 'ba[rz]$', isRegex: true },
        { query: 'bar\\s+foo', isRegex: true },
        { query: 'foo', isRegex: true, wholeWord: true },
        { query: '日本', },
    ];
    for (const c of cases) {
        it(JSON.stringify(c), () => {
            const opts = { ...base, ...c };
            expect(workerMatches(sample, opts)).toEqual(cmMatches(sample, opts));
        });
    }
});

describe('findAllMatches', () => {
    it('finds hits on both sides of a chunk boundary', () => {
        const line = 'x'.repeat(99) + '\n';
        const text = line.repeat(Math.ceil((CHUNK_SIZE * 2.5) / line.length)) + 'needle';
        const head = 'needle ' + text;
        const r = findAllMatches(head, { ...base, query: 'needle' });
        expect(r.count).toBe(2);
        expect(r.starts[0]).toBe(0);
        expect(r.starts[1]).toBe(head.length - 6);
    });

    it('reports progress through the text', () => {
        const text = ('abc\n').repeat(CHUNK_SIZE / 2);
        const seen = [];
        findAllMatches(text, { ...base, query: 'zzz' }, (scanned) => seen.push(scanned));
        expect(seen.length).toBeGreaterThan(1);
        expect(seen[seen.length - 1]).toBe(text.length);
    });

    it('stops at the limit', () => {
        const r = findAllMatches('a a a a a', { ...base, query: 'a', limit: 3 });
        expect(r.count).toBe(3);
        expect(r.truncated).toBe(true);
    });

    it('replaces every hit as one span, with groups', () => {
        const text = 'a1 b2 a3 c4';
        const r = replaceAllMatches(text, { ...base, isRegex: true, query: 'a(\\d)' }, 'A$1$1');
        expect(r.count).toBe(2);
        expect(text.slice(0, r.from) + r.insert + text.slice(r.to)).toBe('A11 b2 A33 c4');
        expect([r.from, r.to]).toEqual([0, 8]);
    });

    it('takes the replacement literally when regex is off', () => {
        const r = replaceAllMatches('x.y', { ...base, query: '.' }, '$1\\n');
        expect(r.insert).toBe('$1\\n');
    });

    it('maps positions through the replacement', () => {
        const text = 'foo bar foo bar';
        //            0123456789
        const r = replaceAllMatches(text, { ...base, query: 'foo' }, 'f', [0, 2, 5, 15]);
        // After 'f bar f bar': 0 stays, 2 (inside hit) → 0, 5 shifts by -2, end → 11
        expect(r.positions).toEqual([0, 0, 3, 11]);
    });

    it('reports nothing to change when there are no hits', () => {
        expect(replaceAllMatches('abc', { ...base, query: 'z' }, 'y').count).toBe(0);
    });

    it('throws on an invalid pattern', () => {
        expect(() => findAllMatches('x', { ...base, query: '(', isRegex: true })).toThrow();
    });
});
