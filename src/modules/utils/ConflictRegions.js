/**
 * ConflictRegions.js — a conflicted file as data, for the three-way merge view.
 *
 * The merge itself is git's: `git merge-file --diff3` (see git_conflict_versions
 * in git.rs) writes the result with every conflict between markers. Reading
 * that output rather than running a diff3 of our own means the parts that
 * merged cleanly are exactly what git merged — renames, merge drivers and its
 * conflict shrinking included.
 *
 * Everything here is plain text in, plain data out. Line numbers are 0-based
 * indices into `text.split('\n')`, which is how CodeMirror counts lines too
 * (a text ending in a line break has an empty last line).
 */
import { computeDiff } from './LineDiff.js';

export const MARKER_SIZE = 32;

/**
 * Split git's merge output into stretches that merged and conflicts.
 *
 *   { kind: 'same', text }
 *   { kind: 'conflict', ours, base, theirs }
 *
 * Every text keeps its lines' breaks, so joining the stretches back with a
 * side's text in each conflict gives that side's whole file. A marker that is
 * never closed is left as text: nothing is thrown away.
 */
export function parseMerged(text, markerSize = MARKER_SIZE) {
    const marker = (ch) => new RegExp(`^\\${ch}{${markerSize}}(?: .*)?\\n?$`);
    const OPEN = marker('<');
    const BASE = marker('|');
    const SEP = new RegExp(`^={${markerSize}}\\n?$`);
    const CLOSE = marker('>');

    const lines = String(text).match(/[^\n]*\n|[^\n]+$/g) || [];
    const regions = [];
    let same = '';
    let i = 0;
    while (i < lines.length) {
        if (!OPEN.test(lines[i])) {
            same += lines[i++];
            continue;
        }
        // ours [ ||| base ] === theirs >>>
        const parts = { ours: '', base: '', theirs: '' };
        let part = 'ours';
        let j = i + 1;
        let closed = false;
        for (; j < lines.length; j++) {
            const line = lines[j];
            if (part === 'ours' && BASE.test(line)) { part = 'base'; continue; }
            if (part !== 'theirs' && SEP.test(line)) { part = 'theirs'; continue; }
            if (part === 'theirs' && CLOSE.test(line)) { closed = true; break; }
            parts[part] += line;
        }
        if (!closed || part !== 'theirs') {
            same += lines[i++];
            continue;
        }
        if (same) regions.push({ kind: 'same', text: same });
        same = '';
        regions.push({ kind: 'conflict', ...parts });
        i = j + 1;
    }
    if (same) regions.push({ kind: 'same', text: same });
    return regions;
}

/** Number of lines in `text`, counted as CodeMirror does. */
export function lineCount(text) {
    let n = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
}

/**
 * Join the stretches into one text, taking `pick(conflict, index)` for each
 * conflict. Returns the text and where each conflict landed in it, as
 * character offsets [from, to) covering whole lines.
 */
export function assemble(regions, pick) {
    let text = '';
    const ranges = [];
    let k = 0;
    for (const r of regions) {
        if (r.kind === 'same') {
            text += r.text;
            continue;
        }
        const body = pick(r, k++);
        ranges.push({ from: text.length, to: text.length + body.length });
        text += body;
    }
    return { text, ranges };
}

/** Two texts one after the other, each on lines of its own. */
function joinBlocks(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a.endsWith('\n') ? a + b : `${a}\n${b}`;
}

/**
 * The text a conflict takes when resolved one way:
 * 'ours' | 'theirs' | 'base' | 'ours-theirs' | 'theirs-ours'.
 */
export function resolutionText(conflict, choice) {
    switch (choice) {
        case 'ours': return conflict.ours;
        case 'theirs': return conflict.theirs;
        case 'base': return conflict.base;
        case 'ours-theirs': return joinBlocks(conflict.ours, conflict.theirs);
        case 'theirs-ours': return joinBlocks(conflict.theirs, conflict.ours);
        default: throw new Error(`unknown resolution: ${choice}`);
    }
}

/** Line index of character offset `pos` (one past the end counts as the line after the last). */
function lineIndexAt(starts, pos) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
}

/**
 * Lines that are identical in `a` and `b` and matched to each other by the
 * line diff: [[lineA, lineB], …], in order on both sides.
 */
export function equalLinePairs(a, b) {
    const startsA = lineStarts(a);
    const startsB = lineStarts(b);
    const nA = startsA.length;
    const nB = startsB.length;
    // A chunk's `to` may be one past the text's end: the line after the last.
    const lineA = (pos) => (pos > a.length ? nA : lineIndexAt(startsA, pos));
    const lineB = (pos) => (pos > b.length ? nB : lineIndexAt(startsB, pos));

    const pairs = [];
    let la = 0;
    let lb = 0;
    const equalUpTo = (endA) => {
        for (; la < endA; la++, lb++) pairs.push([la, lb]);
    };
    for (const c of computeDiff(a, b)) {
        equalUpTo(lineA(c.fromA));
        la = lineA(c.toA);
        lb = lineB(c.toB);
        // A chunk ending at the very end leaves no equal tail.
        if (c.toA > a.length || c.toB > b.length) { la = nA; lb = nB; }
    }
    equalUpTo(Math.min(nA, la + (nB - lb)));
    return pairs;
}

/**
 * Line padding that lines the three panes up row by row.
 *
 * A row is fixed where a result line is matched to a line in BOTH sides; the
 * lines between two such rows are padded at the bottom to the tallest of the
 * three. `oursPairs` are [oursLine, resultLine] and `theirsPairs`
 * [theirsLine, resultLine], as equalLinePairs gives them.
 *
 * Returns, per pane, [{ line, count }]: `count` blank lines go before `line`
 * (`line` equal to the pane's line count means after its last line).
 */
export function alignThree(nOurs, nResult, nTheirs, oursPairs, theirsPairs) {
    const oursOf = new Map(oursPairs.map(([o, r]) => [r, o]));
    const theirsOf = new Map(theirsPairs.map(([t, r]) => [r, t]));
    const rows = [];
    let lastO = -1;
    let lastT = -1;
    for (let r = 0; r < nResult; r++) {
        const o = oursOf.get(r);
        const t = theirsOf.get(r);
        if (o === undefined || t === undefined || o <= lastO || t <= lastT) continue;
        rows.push([o, r, t]);
        lastO = o;
        lastT = t;
    }
    rows.push([nOurs, nResult, nTheirs]);

    const pads = { ours: [], result: [], theirs: [] };
    let prev = [-1, -1, -1];
    for (const row of rows) {
        const counts = row.map((v, i) => v - prev[i] - 1);
        const tallest = Math.max(...counts);
        ['ours', 'result', 'theirs'].forEach((pane, i) => {
            if (counts[i] < tallest) pads[pane].push({ line: row[i], count: tallest - counts[i] });
        });
        prev = row;
    }
    return pads;
}

/**
 * Where each conflict sits in one side's own file, as line ranges
 * { from, to } (to exclusive; from === to for a side that has no lines there).
 *
 * The side's file is not simply the merge output with that side's text in
 * every conflict — what merged cleanly from the OTHER side is in the output
 * but not in this file. So the two are matched line by line and each
 * conflict's lines carried across.
 */
export function sideConflictLines(sideText, regions, which) {
    const { text, ranges } = assemble(regions, (c) => c[which]);
    const starts = lineStarts(text);
    const toSide = new Map(equalLinePairs(sideText, text).map(([s, m]) => [m, s]));
    const nSide = lineCount(sideText);
    return ranges.map(({ from, to }) => {
        const first = lineIndexAt(starts, from);
        const end = from === to ? first : lineIndexAt(starts, to - 1) + 1;
        const mapped = [];
        for (let m = first; m < end; m++) if (toSide.has(m)) mapped.push(toSide.get(m));
        if (mapped.length) return { from: Math.min(...mapped), to: Math.max(...mapped) + 1 };
        // Nothing matched: place it after the nearest matched line above.
        let at = 0;
        for (let m = first - 1; m >= 0; m--) {
            if (toSide.has(m)) { at = toSide.get(m) + 1; break; }
        }
        return { from: Math.min(at, nSide), to: Math.min(at, nSide) };
    });
}
