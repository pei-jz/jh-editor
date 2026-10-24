import { describe, it, expect } from 'vitest';
import {
    parseMerged, assemble, resolutionText, equalLinePairs, alignThree, sideConflictLines, lineCount,
} from '../src/modules/utils/ConflictRegions.js';

const N = 32;
const m = (ch, label = '') => ch.repeat(N) + (label ? ` ${label}` : '') + '\n';
const conflict = (ours, base, theirs) =>
    m('<', 'ours') + ours + m('|', 'base') + base + m('=') + theirs + m('>', 'theirs');

describe('parseMerged', () => {
    it('reads a file with no conflict as one stretch', () => {
        expect(parseMerged('a\nb\n')).toEqual([{ kind: 'same', text: 'a\nb\n' }]);
        expect(parseMerged('')).toEqual([]);
    });

    it('splits stretches and conflicts, keeping every line break', () => {
        const text = 'top\n' + conflict('o1\no2\n', 'b\n', 't\n') + 'mid\n' + conflict('', 'x\n', 'y\n') + 'end';
        const r = parseMerged(text);
        expect(r).toEqual([
            { kind: 'same', text: 'top\n' },
            { kind: 'conflict', ours: 'o1\no2\n', base: 'b\n', theirs: 't\n' },
            { kind: 'same', text: 'mid\n' },
            { kind: 'conflict', ours: '', base: 'x\n', theirs: 'y\n' },
            { kind: 'same', text: 'end' },
        ]);
    });

    it('takes ordinary seven-character markers in the text as text', () => {
        const text = '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n';
        expect(parseMerged(text)).toEqual([{ kind: 'same', text }]);
    });

    it('keeps an unclosed conflict as text rather than dropping it', () => {
        const text = 'a\n' + m('<', 'ours') + 'o\n' + m('=') + 't\n';
        expect(parseMerged(text)).toEqual([{ kind: 'same', text }]);
    });

    it('reads a conflict without a base section', () => {
        const text = m('<', 'ours') + 'o\n' + m('=') + 't\n' + m('>', 'theirs');
        expect(parseMerged(text)).toEqual([{ kind: 'conflict', ours: 'o\n', base: '', theirs: 't\n' }]);
    });
});

describe('assemble and resolutions', () => {
    const regions = parseMerged('a\n' + conflict('o\n', 'b\n', 't\n') + 'z\n');

    it('puts the chosen text in each conflict and says where it went', () => {
        const { text, ranges } = assemble(regions, (c) => c.base);
        expect(text).toBe('a\nb\nz\n');
        expect(ranges).toEqual([{ from: 2, to: 4 }]);
    });

    it('rebuilds each side whole', () => {
        expect(assemble(regions, (c) => c.ours).text).toBe('a\no\nz\n');
        expect(assemble(regions, (c) => c.theirs).text).toBe('a\nt\nz\n');
    });

    it('keeps both versions on lines of their own', () => {
        const c = { ours: 'o', base: '', theirs: 't\n' };
        expect(resolutionText(c, 'ours-theirs')).toBe('o\nt\n');
        expect(resolutionText(c, 'theirs-ours')).toBe('t\no');
        expect(resolutionText({ ours: '', theirs: 't\n' }, 'ours-theirs')).toBe('t\n');
    });
});

describe('equalLinePairs', () => {
    it('pairs the unchanged lines around a change', () => {
        expect(equalLinePairs('a\nb\nc\n', 'a\nX\nc\n')).toEqual([[0, 0], [2, 2], [3, 3]]);
    });

    it('follows insertions and deletions', () => {
        expect(equalLinePairs('a\nc', 'a\nb1\nb2\nc')).toEqual([[0, 0], [1, 3]]);
        expect(equalLinePairs('a\nb1\nb2\nc', 'a\nc')).toEqual([[0, 0], [3, 1]]);
        expect(equalLinePairs('same', 'same')).toEqual([[0, 0]]);
        expect(equalLinePairs('', 'x\ny')).toEqual([]);
    });
});

describe('alignThree', () => {
    it('pads every pane to the tallest between rows matched in all three', () => {
        // ours: a o1 o2 z | result: a r z | theirs: a z
        const pads = alignThree(4, 3, 2, [[0, 0], [3, 2]], [[0, 0], [1, 2]]);
        expect(pads.ours).toEqual([]);
        expect(pads.result).toEqual([{ line: 2, count: 1 }]);
        expect(pads.theirs).toEqual([{ line: 1, count: 2 }]);
    });

    it('pads at the end when the last stretch differs in height', () => {
        const pads = alignThree(1, 3, 2, [[0, 0]], [[0, 0]]);
        expect(pads.ours).toEqual([{ line: 1, count: 2 }]);
        expect(pads.theirs).toEqual([{ line: 2, count: 1 }]);
        expect(pads.result).toEqual([]);
    });

    it('lines the three texts up row for row', () => {
        const ours = 'a\nmine\nb\nc\n';
        const theirs = 'a\nb\nc\ntheirs 1\ntheirs 2\n';
        const result = 'a\nmine\nb\nc\ntheirs 1\ntheirs 2\n';
        const pads = alignThree(lineCount(ours), lineCount(result), lineCount(theirs),
            equalLinePairs(ours, result), equalLinePairs(theirs, result));
        const rows = (text, list) => {
            const out = [];
            text.split('\n').forEach((line, i) => {
                for (const p of list) if (p.line === i) out.push(...Array(p.count).fill('~'));
                out.push(line);
            });
            for (const p of list) if (p.line === lineCount(text)) out.push(...Array(p.count).fill('~'));
            return out;
        };
        const o = rows(ours, pads.ours);
        const r = rows(result, pads.result);
        const t = rows(theirs, pads.theirs);
        expect(o.length).toBe(r.length);
        expect(t.length).toBe(r.length);
        // Every line equal in all three sits on one row.
        for (const line of ['a', 'b', 'c']) {
            expect(o.indexOf(line)).toBe(r.indexOf(line));
            expect(t.indexOf(line)).toBe(r.indexOf(line));
        }
    });
});

describe('sideConflictLines', () => {
    it('finds each conflict in a side whose other parts merged from the other side', () => {
        // theirs changed line 1 cleanly; both changed line 3.
        const ours = 'one\ntwo\nmine\nfour\n';
        const merged = 'ONE\ntwo\n' + conflict('mine\n', 'three\n', 'yours\n') + 'four\n';
        const regions = parseMerged(merged);
        expect(sideConflictLines(ours, regions, 'ours')).toEqual([{ from: 2, to: 3 }]);
        const theirs = 'ONE\ntwo\nyours\nfour\n';
        expect(sideConflictLines(theirs, regions, 'theirs')).toEqual([{ from: 2, to: 3 }]);
    });

    it('places a side with no lines in the conflict where they would be', () => {
        const ours = 'a\nz\n';
        const regions = parseMerged('a\n' + conflict('', 'b\n', 'c\n') + 'z\n');
        expect(sideConflictLines(ours, regions, 'ours')).toEqual([{ from: 1, to: 1 }]);
    });
});

describe('round trip (fuzz)', () => {
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const block = () => Array.from({ length: rand(3) }, () => `l${rand(5)}\n`).join('');

    it('parse then assemble gives back each side', () => {
        for (let k = 0; k < 300; k++) {
            const parts = [];
            const n = 1 + rand(4);
            for (let i = 0; i < n; i++) {
                parts.push({ kind: 'same', text: block() || 's\n' });
                if (rand(2)) parts.push({ kind: 'conflict', ours: block(), base: block(), theirs: block() });
            }
            const merged = parts.map((p) => (p.kind === 'same' ? p.text : conflict(p.ours, p.base, p.theirs))).join('');
            const back = parseMerged(merged);
            const side = (regions, w) => assemble(regions, (c) => c[w]).text;
            for (const w of ['ours', 'base', 'theirs']) {
                expect(side(back, w)).toBe(side(parts, w));
            }
        }
    });
});
