/**
 * What every comparison result must satisfy, whatever the texts. Used by the
 * LineDiff and MergeEditor tests; each check throws with a readable message
 * so a failing random case says what broke.
 */
import { whitespaceKey, blockCopyEdit } from '../../src/modules/utils/MergeSides.js';

/** A small deterministic PRNG (mulberry32), so a failing seed can be replayed. */
export function rng(seed) {
    let s = seed >>> 0;
    const next = () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = (n) => Math.floor(next() * n);
    next.pick = (xs) => xs[next.int(xs.length)];
    return next;
}

// Lines chosen to collide: repeats, blanks, braces, whitespace variants,
// near-identical code, CJK and astral characters.
export const LINE_POOL = [
    '', '', ' ', '\t', 'a', 'b', 'c', '}', '{', '  }', 'a ', ' a', '  a', 'a  b', 'a b',
    'foo(x);', 'foo(y);', 'foo( x );', 'const x = 1;', 'const x = 2;', 'let x = 1;',
    'return total;', '    return total;', 'if (a) {', 'if (b) {', '} else {',
    '日本語の文章です', '日本語の文書です', '한국어', '中文', '😀 emoji', '😀 emojo', 'x​y',
];

export function randomLines(r, max = 30) {
    const n = r.int(max + 1);
    const out = [];
    for (let i = 0; i < n; i++) out.push(r.pick(LINE_POOL));
    return out;
}

/** B as a set of edits of A: inserts, deletes, replacements, word tweaks. */
export function mutateLines(r, lines) {
    const out = lines.slice();
    const edits = r.int(6);
    for (let e = 0; e < edits; e++) {
        const at = r.int(out.length + 1);
        switch (r.int(5)) {
            case 0: out.splice(at, 0, ...randomLines(r, 4)); break;
            case 1: out.splice(at, 1 + r.int(3)); break;
            case 2: out.splice(at, 1, r.pick(LINE_POOL)); break;
            case 3: if (out[at] != null) out[at] = `${out[at]} ${r.pick(['x', 'y', '1'])}`; break;
            default: if (out[at] != null) out[at] = out[at].replace(/\s+/g, r.pick(['', ' ', '  ', '\t'])); break;
        }
    }
    return out;
}

/** Join lines, with or without a final line break. */
export function joinLines(r, lines) {
    const text = lines.join('\n');
    return lines.length && r() < 0.5 ? `${text}\n` : text;
}

export function randomPair(r) {
    const a = randomLines(r);
    const b = r() < 0.7 ? mutateLines(r, a) : randomLines(r);
    return [joinLines(r, a), joinLines(r, b)];
}

const fail = (msg, ctx) => {
    throw new Error(`${msg}\n  a=${JSON.stringify(ctx.a)}\n  b=${JSON.stringify(ctx.b)}\n  chunks=${JSON.stringify(ctx.chunks)}`);
};

const isLineStart = (text, pos) => pos === 0 || text[pos - 1] === '\n';

/** The lines a chunk side covers (empty side → []). */
export function sideLines(text, from, to) {
    if (to <= from) return [];
    return text.slice(from, Math.max(from, Math.min(text.length, to) - (to <= text.length ? 1 : 0))).split('\n');
}

/**
 * Structural checks on a chunk list for texts a / b.
 * `opts.ignoreWhitespace` relaxes "the two sides differ" to keys.
 */
export function checkChunks(a, b, chunks, { ignoreWhitespace = false, anchored = false } = {}) {
    const ctx = { a, b, chunks };
    let prevA = 0;
    let prevB = 0;
    for (let k = 0; k < chunks.length; k++) {
        const c = chunks[k];
        for (const [from, to, text, side] of [[c.fromA, c.toA, a, 'A'], [c.fromB, c.toB, b, 'B']]) {
            if (!(from >= 0 && from <= text.length)) fail(`chunk ${k}: from${side} out of range`, ctx);
            if (!(to >= from && to <= text.length + 1)) fail(`chunk ${k}: to${side} out of range`, ctx);
            if (!isLineStart(text, from)) fail(`chunk ${k}: from${side} not at a line start`, ctx);
            if (to > from && to <= text.length && text[to - 1] !== '\n') fail(`chunk ${k}: to${side} not after a line break`, ctx);
        }
        if (c.fromA === c.toA && c.fromB === c.toB) fail(`chunk ${k}: empty on both sides`, ctx);
        // The text between chunks is identical, character for character.
        if (a.slice(prevA, c.fromA) !== b.slice(prevB, c.fromB)) fail(`before chunk ${k}: unchanged text differs`, ctx);
        if (c.fromA < prevA || c.fromB < prevB) fail(`chunk ${k}: overlaps the previous one`, ctx);
        // Two chunks never touch: an unchanged line separates them.
        if (k && a.slice(prevA, c.fromA) === '') fail(`chunk ${k}: no unchanged line before it`, ctx);

        const la = sideLines(a, c.fromA, c.toA);
        const lb = sideLines(b, c.fromB, c.toB);
        const kind = c.kind;
        if (!['left', 'right', 'both', 'ws'].includes(kind)) fail(`chunk ${k}: unknown kind ${kind}`, ctx);
        if (!la.length && kind !== 'right') fail(`chunk ${k}: no lines on A but kind ${kind}`, ctx);
        if (!lb.length && kind !== 'left') fail(`chunk ${k}: no lines on B but kind ${kind}`, ctx);
        if (kind === 'ws') {
            if (!ignoreWhitespace) fail(`chunk ${k}: whitespace-only chunk while whitespace counts`, ctx);
            if (la.length !== lb.length || la.some((l, i) => whitespaceKey(l) !== whitespaceKey(lb[i]))) {
                fail(`chunk ${k}: 'ws' chunk with a real difference`, ctx);
            }
        } else if (anchored) {
            // A sync point may line up lines the user chose to see apart, so
            // a chunk can hold the same text on both sides, just shifted.
        } else if (ignoreWhitespace) {
            const ka = la.map(whitespaceKey).join('\n');
            const kb = lb.map(whitespaceKey).join('\n');
            if (ka === kb && la.length === lb.length && (c.toA <= a.length) === (c.toB <= b.length)) {
                fail(`chunk ${k}: shown as a change but equal ignoring whitespace`, ctx);
            }
        } else if (a.slice(c.fromA, c.toA) === b.slice(c.fromB, c.toB)) {
            fail(`chunk ${k}: both sides identical`, ctx);
        }

        // Pairs: increasing on both sides, inside the chunk.
        let pi = -1;
        let pj = -1;
        for (const [i, j] of c.pairs) {
            if (!(i > pi && j > pj && i < la.length && j < lb.length)) fail(`chunk ${k}: bad pair [${i},${j}]`, ctx);
            pi = i;
            pj = j;
        }
        checkWords(a, b, c, la, lb, ignoreWhitespace, ctx, k);

        prevA = Math.min(a.length, c.toA);
        prevB = Math.min(b.length, c.toB);
        if (c.toA > a.length) prevA = a.length;
        if (c.toB > b.length) prevB = b.length;
    }
    if (a.slice(prevA) !== b.slice(prevB)) fail('after the last chunk: unchanged text differs', ctx);
}

/** Word changes: sorted, each inside one paired line, and they rebuild B's line from A's. */
function checkWords(a, b, c, la, lb, ignoreWhitespace, ctx, k) {
    const lineOffsets = (lines) => {
        const offs = [];
        let pos = 0;
        for (const l of lines) { offs.push(pos); pos += l.length + 1; }
        return offs;
    };
    const offA = lineOffsets(la);
    const offB = lineOffsets(lb);
    let last = null;
    const byPair = new Map(c.pairs.map(([i, j]) => [i, { j, changes: [] }]));
    for (const ch of c.changes) {
        if (ch.fromA > ch.toA || ch.fromB > ch.toB) fail(`chunk ${k}: inverted word change`, ctx);
        if (last && (ch.fromA < last.toA || ch.fromB < last.toB)) fail(`chunk ${k}: word changes out of order`, ctx);
        last = ch;
        const i = offA.findLastIndex((o) => o <= ch.fromA);
        const p = byPair.get(i);
        if (!p) fail(`chunk ${k}: word change outside a paired line`, ctx);
        const j = p.j;
        if (ch.toA > offA[i] + la[i].length || ch.fromB < offB[j] || ch.toB > offB[j] + lb[j].length) {
            fail(`chunk ${k}: word change crosses its line`, ctx);
        }
        p.changes.push({ fromA: ch.fromA - offA[i], toA: ch.toA - offA[i], fromB: ch.fromB - offB[j], toB: ch.toB - offB[j] });
    }
    for (const [i, { j, changes }] of byPair) {
        // Replace each changed range of A's line with B's text for it.
        let out = '';
        let pos = 0;
        for (const ch of changes) {
            out += la[i].slice(pos, ch.fromA) + lb[j].slice(ch.fromB, ch.toB);
            pos = ch.toA;
        }
        out += la[i].slice(pos);
        const ok = ignoreWhitespace ? whitespaceKey(out) === whitespaceKey(lb[j]) : out === lb[j];
        if (!ok) fail(`chunk ${k}: word changes do not rebuild line ${j} (${JSON.stringify(out)} vs ${JSON.stringify(lb[j])})`, ctx);
    }
}

/** Apply edits given in the coordinates of `text`, all at once. */
export function applyEdits(text, edits) {
    const sorted = edits.slice().sort((x, y) => x.from - y.from);
    let out = '';
    let pos = 0;
    for (const e of sorted) {
        if (e.from < pos) throw new Error('overlapping edits');
        out += text.slice(pos, e.from) + e.insert;
        pos = e.to;
    }
    return out + text.slice(pos);
}

/** Copy every chunk toward one side, as "Copy all" does. */
export function copyAll(a, b, chunks, toward) {
    return toward === 'right'
        ? applyEdits(b, chunks.map((c) => blockCopyEdit(a, b, c.fromA, c.toA, c.fromB, c.toB)))
        : applyEdits(a, chunks.map((c) => blockCopyEdit(b, a, c.fromB, c.toB, c.fromA, c.toA)));
}
