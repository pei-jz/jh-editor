import { describe, it, expect } from 'vitest';
import { computeDiff, pairLines, wordChanges, normalizeAnchors } from '../src/modules/utils/LineDiff.js';

const lines = (...xs) => `${xs.join('\n')}\n`;
/** A chunk's lines on each side, as text. */
const sides = (a, b, c) => [a.slice(c.fromA, Math.max(c.fromA, c.toA - 1)), b.slice(c.fromB, Math.max(c.fromB, c.toB - 1))];

describe('LineDiff: kinds of change', () => {
    it('tells lines only on the left, only on the right, and on both apart', () => {
        const a = lines('keep', 'gone', 'keep2', 'old', 'end');
        const b = lines('keep', 'keep2', 'new', 'end', 'added');
        const chunks = computeDiff(a, b);
        expect(chunks.map((c) => c.kind)).toEqual(['left', 'both', 'right']);
        expect(sides(a, b, chunks[0])).toEqual(['gone', '']);
        expect(sides(a, b, chunks[1])).toEqual(['old', 'new']);
        expect(sides(a, b, chunks[2])).toEqual(['', 'added']);
    });

    it('finds nothing in equal texts', () => {
        expect(computeDiff('a\nb\n', 'a\nb\n')).toEqual([]);
        expect(computeDiff('', '')).toEqual([]);
    });

    it('takes in the last line when only one side has a break after it', () => {
        // "x" vs "x\n…": the line is the same, its line break is not. The text
        // between chunks must be identical, so "x" joins the chunk — which is
        // still an addition: nothing but "x" itself is on the left.
        expect(computeDiff('x', 'x\ny')).toEqual([expect.objectContaining({ fromA: 0, toA: 2, fromB: 0, toB: 4, kind: 'right', pairs: [[0, 0]], changes: [] })]);
        expect(computeDiff('x\ny', 'x')).toEqual([expect.objectContaining({ fromA: 0, toA: 4, fromB: 0, toB: 2, kind: 'left' })]);
    });
});

describe('LineDiff: matching lines', () => {
    it('does not turn a long file into one change when much of it differs', () => {
        // The package's scan limit gave up on exactly this and called it all changed.
        const a = [];
        const b = [];
        for (let i = 0; i < 3000; i++) {
            a.push(`line ${i} = value_${i};`);
            b.push(i % 3 === 0 ? `line ${i} = other_${i};` : `line ${i} = value_${i};`);
        }
        const chunks = computeDiff(a.join('\n'), b.join('\n'));
        expect(chunks).toHaveLength(1000);
        expect(chunks.every((c) => c.kind === 'both' && c.pairs.length === 1)).toBe(true);
    });

    it('anchors on lines that occur once on each side (patience)', () => {
        const a = lines('}', 'function a() {', '}', '}');
        const b = lines('}', 'function b() {', '}', 'function a() {', '}', '}');
        const chunks = computeDiff(a, b);
        expect(chunks).toHaveLength(1);
        expect(sides(a, b, chunks[0])[1]).toBe('function b() {\n}');
    });

    it('slides an inserted block to end on a blank line', () => {
        const a = lines('a() {', '}', '', 'b() {', '}');
        const b = lines('a() {', '}', '', 'n() {', '}', '', 'b() {', '}');
        const [c] = computeDiff(a, b);
        expect(c.kind).toBe('right');
        expect(sides(a, b, c)[1]).toBe('n() {\n}\n');
    });

    it('ignores whitespace-only differences when asked, and still diffs words', () => {
        // Still chunks, so the panes stay aligned — but of kind 'ws', not changes.
        const ws = computeDiff('a\n  b\t\nc', 'a\nb\n c', { ignoreWhitespace: true });
        expect(ws.map((c) => c.kind)).toEqual(['ws']);
        expect(ws[0].changes).toEqual([]);
        // Whitespace appearing between two words is a change, and is marked.
        const [gap] = computeDiff('a(b)\n', 'a( b)\n', { ignoreWhitespace: true });
        expect(gap.changes).toHaveLength(1);
        const [c] = computeDiff('x\n  foo(a);\n', 'x\nfoo( b );\n', { ignoreWhitespace: true });
        expect(c.changes).toHaveLength(1);
        expect('  foo(a);'.slice(c.changes[0].fromA, c.changes[0].toA)).toBe('a');
    });
});

describe('LineDiff: lines inside a change', () => {
    it('pairs the edited lines around an inserted one, so they can face each other', () => {
        const a = lines('top', 'foo(a, b);', 'let x = 1;', 'bottom');
        const b = lines('top', 'foo(a, c);', 'something else entirely', 'let x = 2;', 'bottom');
        const [c] = computeDiff(a, b);
        expect(c.pairs).toEqual([[0, 0], [1, 2]]);
        expect(c.runs).toHaveLength(1);
        // Only the changed words are marked, not the whole lines.
        const changed = c.changes.map((x) => a.slice(c.fromA + x.fromA, c.fromA + x.toA));
        expect(changed).toEqual(['b', '1']);
    });

    it('leaves dissimilar lines unpaired', () => {
        expect(pairLines(['alpha beta', 'return x;'], ['gamma', 'zzz'])).toEqual([]);
        expect(pairLines(['a', 'b'], ['b'])).toEqual([[1, 0]]);
    });

    it('always pairs a one-line edit, however much changed', () => {
        expect(pairLines(['one'], ['TWO'])).toEqual([[0, 0]]);
    });
});

describe('LineDiff: words', () => {
    it('joins changes separated only by a space', () => {
        expect(wordChanges('const foo bar = 1', 'const baz qux = 1')).toEqual([{ fromA: 6, toA: 13, fromB: 6, toB: 13 }]);
    });

    it('compares Japanese character by character', () => {
        expect(wordChanges('日本語の文章です', '日本語の文書です')).toEqual([{ fromA: 5, toA: 6, fromB: 5, toB: 6 }]);
    });

    it('drops changes in the amount of whitespace, and at the ends, when whitespace is ignored', () => {
        expect(wordChanges('  a  b \t', 'a b', { ignoreWhitespace: true })).toEqual([]);
        expect(wordChanges('a\tb', 'a    b', { ignoreWhitespace: true })).toEqual([]);
    });

    it('keeps whitespace that appears between two words, as whitespaceKey does', () => {
        expect(wordChanges('a( b )', 'a(b)', { ignoreWhitespace: true })).toHaveLength(1);
    });
});

describe('LineDiff: sync points', () => {
    it('makes two different lines face each other', () => {
        const a = lines('one', 'two');
        const b = lines('alpha', 'beta');
        const [c] = computeDiff(a, b, { anchors: [[1, 0]] });
        expect(c.pairs).toEqual([[1, 0]]);
    });

    it('cuts the comparison so lines cannot match across the point', () => {
        const a = lines('x', 'shared', 'y');
        const b = lines('shared', 'p', 'q');
        // Without the point, "shared" matches. With x ↔ q, it cannot.
        expect(computeDiff(a, b).some((c) => c.kind === 'left')).toBe(true);
        const chunks = computeDiff(a, b, { anchors: [[0, 2]] });
        expect(chunks.every((c) => c.fromA === 0)).toBe(true);
    });

    it('drops points that cross an earlier one or fall outside the text', () => {
        expect(normalizeAnchors([[3, 1], [1, 3], [9, 9]], 5, 5)).toEqual([[1, 3]]);
    });
});
