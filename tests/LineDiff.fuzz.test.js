import { describe, it, expect } from 'vitest';
import { computeDiff, normalizeAnchors } from '../src/modules/utils/LineDiff.js';
import { whitespaceKey, blockCombineEdit, applyBlockCopy } from '../src/modules/utils/MergeSides.js';
import {
    rng, randomPair, randomLines, mutateLines, joinLines, checkChunks, copyAll, sideLines,
} from './helpers/diffInvariants.js';

/*
   Random comparisons, each checked against what must hold for ANY texts.
   Seeds are fixed, so a failure is reproducible: the message carries the
   texts, and the seed is in the test name.
*/

const SEEDS = 4000;
const keys = (text) => text.split('\n').map(whitespaceKey);

describe('LineDiff fuzz: structure', () => {
    it(`holds every invariant for ${SEEDS} random pairs`, () => {
        for (let seed = 1; seed <= SEEDS; seed++) {
            const r = rng(seed);
            const [a, b] = randomPair(r);
            try {
                checkChunks(a, b, computeDiff(a, b));
            } catch (e) {
                e.message = `seed ${seed}: ${e.message}`;
                throw e;
            }
        }
    });

    it(`holds every invariant with whitespace ignored, for ${SEEDS} random pairs`, () => {
        for (let seed = 1; seed <= SEEDS; seed++) {
            const r = rng(seed + 100000);
            const [a, b] = randomPair(r);
            try {
                checkChunks(a, b, computeDiff(a, b, { ignoreWhitespace: true }), { ignoreWhitespace: true });
            } catch (e) {
                e.message = `seed ${seed}: ${e.message}`;
                throw e;
            }
        }
    });

    it('finds nothing in a text compared with itself', () => {
        for (let seed = 1; seed <= 1000; seed++) {
            const r = rng(seed + 200000);
            const a = joinLines(r, randomLines(r));
            expect(computeDiff(a, a)).toEqual([]);
            expect(computeDiff(a, a, { ignoreWhitespace: true })).toEqual([]);
        }
    });
});

describe('LineDiff fuzz: copying', () => {
    it('"copy all" toward either side reproduces the other text exactly', () => {
        for (let seed = 1; seed <= SEEDS; seed++) {
            const r = rng(seed + 300000);
            const [a, b] = randomPair(r);
            const chunks = computeDiff(a, b);
            expect(copyAll(a, b, chunks, 'right'), `seed ${seed}`).toBe(a);
            expect(copyAll(a, b, chunks, 'left'), `seed ${seed}`).toBe(b);
        }
    });

    it('with whitespace ignored, "copy all" (whitespace-only chunks left alone) matches ignoring whitespace', () => {
        for (let seed = 1; seed <= SEEDS; seed++) {
            const r = rng(seed + 400000);
            const [a, b] = randomPair(r);
            const chunks = computeDiff(a, b, { ignoreWhitespace: true }).filter((c) => c.kind !== 'ws');
            expect(keys(copyAll(a, b, chunks, 'right')), `seed ${seed}`).toEqual(keys(a));
            expect(keys(copyAll(a, b, chunks, 'left')), `seed ${seed}`).toEqual(keys(b));
        }
    });

    it('copying chunks one at a time, in any order, ends at the other text', () => {
        for (let seed = 1; seed <= 600; seed++) {
            const r = rng(seed + 500000);
            const [a] = randomPair(r);
            let [, b] = randomPair(r);
            // Copy a random chunk left → right, recompute, repeat.
            for (let step = 0; step < 50; step++) {
                const chunks = computeDiff(a, b);
                if (!chunks.length) break;
                const c = chunks[r.int(chunks.length)];
                b = applyBlockCopy(a, b, c.fromA, c.toA, c.fromB, c.toB);
            }
            expect(b, `seed ${seed}`).toBe(a);
        }
    });

    it('copying one chunk changes only that block', () => {
        for (let seed = 1; seed <= 2000; seed++) {
            const r = rng(seed + 600000);
            const [a, b] = randomPair(r);
            const chunks = computeDiff(a, b);
            if (!chunks.length) continue;
            const k = r.int(chunks.length);
            const c = chunks[k];
            const out = applyBlockCopy(a, b, c.fromA, c.toA, c.fromB, c.toB);
            const linesB = b.split('\n');
            const startB = b.slice(0, c.fromB).split('\n').length - 1;
            const expected = [
                ...linesB.slice(0, startB),
                ...sideLines(a, c.fromA, c.toA),
                ...linesB.slice(startB + sideLines(b, c.fromB, c.toB).length),
            ];
            // A block at the very end may also settle the final line break.
            const got = out.split('\n');
            if (c.toB > b.length || c.toA > a.length) {
                expect(got.slice(0, startB), `seed ${seed}`).toEqual(linesB.slice(0, startB));
                expect(out.endsWith('\n'), `seed ${seed}`).toBe(a.endsWith('\n') || (c.toA <= a.length && b.endsWith('\n')));
            } else {
                expect(got, `seed ${seed}`).toEqual(expected);
            }
        }
    });

    it('keeping both puts both blocks, whole and in order, in place of the destination block', () => {
        for (let seed = 1; seed <= 2000; seed++) {
            const r = rng(seed + 700000);
            const [a, b] = randomPair(r);
            for (const c of computeDiff(a, b).filter((x) => x.kind === 'both')) {
                for (const srcFirst of [true, false]) {
                    const e = blockCombineEdit(a, b, c.fromA, c.toA, c.fromB, c.toB, srcFirst);
                    const out = b.slice(0, e.from) + e.insert + b.slice(e.to);
                    const la = sideLines(a, c.fromA, c.toA);
                    const lb = sideLines(b, c.fromB, c.toB);
                    const block = srcFirst ? [...la, ...lb] : [...lb, ...la];
                    expect(out.slice(e.select.from, e.select.to).split('\n'), `seed ${seed}`).toEqual(block);
                    expect(out.slice(0, c.fromB), `seed ${seed}`).toBe(b.slice(0, c.fromB));
                    expect(out.slice(e.select.to), `seed ${seed}`).toBe(b.slice(Math.min(b.length, c.toB) - (c.toB <= b.length ? 1 : 0)));
                }
            }
        }
    });
});

describe('LineDiff fuzz: sync points', () => {
    it('keeps every invariant, and every sync point lines its two lines up', () => {
        for (let seed = 1; seed <= 2500; seed++) {
            const r = rng(seed + 800000);
            const [a, b] = randomPair(r);
            const nA = a.split('\n').length;
            const nB = b.split('\n').length;
            const raw = Array.from({ length: r.int(4) }, () => [r.int(nA + 1), r.int(nB + 1)]);
            const ignoreWhitespace = r() < 0.3;
            const chunks = computeDiff(a, b, { anchors: raw, ignoreWhitespace });
            try {
                checkChunks(a, b, chunks, { ignoreWhitespace, anchored: raw.length > 0 });
            } catch (e) {
                e.message = `seed ${seed} anchors ${JSON.stringify(raw)}: ${e.message}`;
                throw e;
            }
            expect(copyAll(a, b, chunks, 'right'), `seed ${seed}`).toBe(ignoreWhitespace ? copyAll(a, b, chunks, 'right') : a);

            const lineOf = (text, pos) => text.slice(0, pos).split('\n').length - 1;
            for (const [la, lb] of normalizeAnchors(raw, nA, nB)) {
                const c = chunks.find((x) => lineOf(a, x.fromA) <= la && la < lineOf(a, x.fromA) + sideLines(a, x.fromA, x.toA).length);
                if (c) {
                    // Inside a change: paired with exactly that line.
                    const pair = c.pairs.find(([i]) => i === la - lineOf(a, c.fromA));
                    expect(pair && pair[1] + lineOf(b, c.fromB), `seed ${seed} anchor ${la},${lb}`).toBe(lb);
                } else {
                    // Unchanged: the two lines sit at the same place.
                    const before = chunks.filter((x) => x.toA <= a.length && lineOf(a, x.toA) <= la);
                    const shift = before.reduce((s, x) => s + sideLines(b, x.fromB, x.toB).length - sideLines(a, x.fromA, x.toA).length, 0);
                    expect(la + shift, `seed ${seed} anchor ${la},${lb}`).toBe(lb);
                }
            }
        }
    });
});

describe('LineDiff fuzz: long texts', () => {
    it('holds every invariant and copies exactly for texts of hundreds of lines', () => {
        for (let seed = 1; seed <= 300; seed++) {
            const r = rng(seed + 1100000);
            const base = randomLines(r, 300);
            let other = base;
            for (let k = 0; k < 1 + r.int(6); k++) other = mutateLines(r, other);
            const a = joinLines(r, base);
            const b = joinLines(r, other);
            for (const ignoreWhitespace of [false, true]) {
                const chunks = computeDiff(a, b, { ignoreWhitespace });
                try {
                    checkChunks(a, b, chunks, { ignoreWhitespace });
                } catch (e) {
                    e.message = `seed ${seed}: ${e.message}`;
                    throw e;
                }
                if (!ignoreWhitespace) {
                    expect(copyAll(a, b, chunks, 'right'), `seed ${seed}`).toBe(a);
                    expect(copyAll(a, b, chunks, 'left'), `seed ${seed}`).toBe(b);
                }
            }
        }
    });
});

describe('LineDiff: hard inputs', () => {
    it('survives inputs built to nest the patience recursion deeply', () => {
        // Each level's unique lines sit inside a stretch of lines that repeat.
        const a = [];
        const b = [];
        for (let i = 0; i < 3000; i++) {
            a.push(`u${i}`, 'dup', `v${i}`);
            b.push(`v${i}`, 'dup', `u${i}`);
        }
        const A = a.join('\n');
        const B = b.join('\n');
        const chunks = computeDiff(A, B);
        checkChunks(A, B, chunks);
        expect(copyAll(A, B, chunks, 'right')).toBe(A);
    });

    it('handles large, completely different texts quickly', () => {
        const r = rng(42);
        const a = Array.from({ length: 20000 }, () => `${r.int(1e9)}`).join('\n');
        const b = Array.from({ length: 20000 }, () => `${r.int(1e9)}`).join('\n');
        const t0 = Date.now();
        const chunks = computeDiff(a, b);
        expect(Date.now() - t0).toBeLessThan(5000);
        checkChunks(a, b, chunks);
        expect(copyAll(a, b, chunks, 'left')).toBe(b);
    });

    it('handles long lines and minified text', () => {
        const r = rng(7);
        const line = Array.from({ length: 6000 }, () => r.pick(['a', 'b', ' ', ';', '{', '}'])).join('');
        const other = line.slice(0, 3000) + 'X' + line.slice(3001);
        const chunks = computeDiff(line, other);
        checkChunks(line, other, chunks);
        expect(copyAll(line, other, chunks, 'right')).toBe(line);
    });

    it('treats \\r inside a line as text, not as a line break', () => {
        const a = 'a\r\nb\n';
        const b = 'a\nb\n';
        const chunks = computeDiff(a, b);
        checkChunks(a, b, chunks);
        expect(chunks).toHaveLength(1);
        expect(copyAll(a, b, chunks, 'left')).toBe(b);
    });

    it('covers the edges of empty texts and lone line breaks', () => {
        const texts = ['', '\n', '\n\n', 'x', 'x\n', '\nx', 'x\n\n', '\n\nx', 'x\ny', 'x\ny\n'];
        for (const a of texts) {
            for (const b of texts) {
                for (const ignoreWhitespace of [false, true]) {
                    const chunks = computeDiff(a, b, { ignoreWhitespace });
                    checkChunks(a, b, chunks, { ignoreWhitespace });
                    if (!ignoreWhitespace) {
                        expect(copyAll(a, b, chunks, 'right'), `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(a);
                        expect(copyAll(a, b, chunks, 'left'), `${JSON.stringify(a)} ${JSON.stringify(b)}`).toBe(b);
                    }
                }
            }
        }
    });
});
