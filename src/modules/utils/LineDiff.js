/**
 * LineDiff.js — the comparison's own diff: whole lines first, then the words
 * inside the lines that face each other.
 *
 * @codemirror/merge diffs characters and works out lines afterwards. That reads
 * well for a handful of edits, but it is what made long comparisons fall apart:
 *
 *  - its scan limit gives up on a large difference and falls back to a crude
 *    diff, which is how a whole file could turn into one change;
 *  - matching characters rather than lines lets a block line up on letters that
 *    unrelated lines happen to share, so the two sides drift apart.
 *
 * This works the way WinMerge and Eclipse do:
 *
 *  1. Lines are matched: lines that occur once on each side anchor the match
 *     (patience), Myers fills in between them, and a block that could sit in
 *     several places is slid so that it ends on a blank line.
 *  2. Inside each changed block the most similar lines are paired, so a block
 *     with an inserted line in the middle still shows its edited lines side by
 *     side instead of one line out.
 *  3. Only paired lines are diffed word by word.
 *
 * The result follows @codemirror/merge's chunk conventions (see its Chunk), so
 * MergeEditor can hand it to the merge view as it is, plus what the view cannot
 * work out for itself: which lines of a block face each other (`pairs`), the
 * runs of lines that have no partner (`runs`), and whether the block exists on
 * one side only (`kind`).
 *
 * Sync points (`anchors`) are line pairs the user has said belong together.
 * Each one cuts the comparison in two, and its lines face each other even when
 * they differ.
 */
import * as Diff from 'diff';
import { whitespaceKey } from './MergeSides.js';

// Paired lines need at least this much in common (Dice over their tokens).
const PAIR_THRESHOLD = 0.4;
// Above this many line combinations a block is paired by position instead.
const PAIR_CELLS = 40000;
// Longest token sequence worth a word diff; longer lines change as a whole.
const WORD_TOKENS = 4000;

/**
 * Tokens for the word diff and for similarity: runs of Latin / Greek / Cyrillic
 * letters, digits and underscores; runs of whitespace; and any other single
 * character — so a Japanese sentence compares character by character instead
 * of as one giant "word".
 */
const TOKEN = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}_]+|\s+|[\s\S]/gu;

export function tokenize(line) {
    return String(line).match(TOKEN) || [];
}

const isSpace = (s) => /^\s+$/.test(s);

function lineStarts(lines) {
    const starts = new Array(lines.length);
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
        starts[i] = pos;
        pos += lines[i].length + 1;
    }
    return starts;
}

// ── 1. Matching lines ───────────────────────────────────────────────────────

/** Pairs [i, j] of lines unique to both ranges, longest increasing run of them. */
function uniqueCommon(ka, kb, a0, a1, b0, b1) {
    const seen = new Map();
    for (let i = a0; i < a1; i++) {
        let e = seen.get(ka[i]);
        if (!e) seen.set(ka[i], (e = { a: 0, b: 0, ia: i, ib: -1 }));
        e.a++;
    }
    for (let j = b0; j < b1; j++) {
        const e = seen.get(kb[j]);
        if (e) { e.b++; e.ib = j; }
    }
    const candidates = [];
    for (let i = a0; i < a1; i++) {
        const e = seen.get(ka[i]);
        if (e.a === 1 && e.b === 1) candidates.push([i, e.ib]);
    }
    if (!candidates.length) return candidates;

    // Patience sorting: the longest run whose B indices also increase.
    const tails = [];
    const prev = new Array(candidates.length);
    for (let k = 0; k < candidates.length; k++) {
        const j = candidates[k][1];
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (candidates[tails[mid]][1] < j) lo = mid + 1; else hi = mid;
        }
        prev[k] = lo ? tails[lo - 1] : -1;
        tails[lo] = k;
    }
    const out = [];
    for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) out.push(candidates[k]);
    return out.reverse();
}

function myers(ka, kb, a0, a1, b0, b1, out) {
    const size = (a1 - a0) + (b1 - b0);
    // O(size × edits): keep the worst case to a few million steps. Past it the
    // range stays one block, which is what it effectively is anyway.
    const maxEditLength = Math.max(64, Math.min(4000, Math.floor(4e6 / Math.max(1, size))));
    const parts = Diff.diffArrays(ka.slice(a0, a1), kb.slice(b0, b1), { maxEditLength });
    if (!parts) return;
    let i = a0;
    let j = b0;
    for (const part of parts) {
        const n = part.count ?? part.value.length;
        if (part.added) j += n;
        else if (part.removed) i += n;
        else {
            for (let k = 0; k < n; k++) out.push([i + k, j + k]);
            i += n;
            j += n;
        }
    }
}

// Patience recursion deeper than this falls back to Myers for the rest; a
// crafted input could otherwise nest one level per line and overflow the stack.
const MAX_DEPTH = 64;

function matchRange(ka, kb, a0, a1, b0, b1, out, depth = 0) {
    while (a0 < a1 && b0 < b1 && ka[a0] === kb[b0]) {
        out.push([a0, b0]);
        a0++;
        b0++;
    }
    const tail = [];
    while (a1 > a0 && b1 > b0 && ka[a1 - 1] === kb[b1 - 1]) {
        a1--;
        b1--;
        tail.push([a1, b1]);
    }
    if (a0 < a1 && b0 < b1) {
        const common = depth < MAX_DEPTH ? uniqueCommon(ka, kb, a0, a1, b0, b1) : [];
        if (common.length) {
            let pa = a0;
            let pb = b0;
            for (const [i, j] of common) {
                matchRange(ka, kb, pa, i, pb, j, out, depth + 1);
                out.push([i, j]);
                pa = i + 1;
                pb = j + 1;
            }
            matchRange(ka, kb, pa, a1, pb, b1, out, depth + 1);
        } else {
            myers(ka, kb, a0, a1, b0, b1, out);
        }
    }
    for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]);
}

/** The changed blocks between matched lines, as line ranges. */
function blocksBetween(matches, nA, nB) {
    const blocks = [];
    let pa = 0;
    let pb = 0;
    for (const [i, j] of matches) {
        if (i > pa || j > pb) blocks.push({ a0: pa, a1: i, b0: pb, b1: j });
        pa = i + 1;
        pb = j + 1;
    }
    if (pa < nA || pb < nB) blocks.push({ a0: pa, a1: nA, b0: pb, b1: nB });
    return blocks;
}

/**
 * Slide blocks that exist on one side only to their most readable place.
 *
 * Inserting a function after another one can be read as "insert `}` … `{`"
 * one line too early; every such position is equally short. Of all the places
 * a block can slide to, prefer the lowest that ends on a blank line, else the
 * lowest. A matched sync point is never slid over.
 */
function slideBlocks(blocks, ka, kb, fixedA) {
    for (let k = 0; k < blocks.length; k++) {
        const blk = blocks[k];
        const onA = blk.b0 === blk.b1;
        if (!onA && blk.a0 !== blk.a1) continue;
        const keys = onA ? ka : kb;
        const n = keys.length;
        const prevBlk = blocks[k - 1];
        const nextBlk = blocks[k + 1];
        const s0 = onA ? 'a0' : 'b0';
        const s1 = onA ? 'a1' : 'b1';

        // Room above: the line before must equal the block's last line.
        let up = 0;
        while (true) {
            const from = blk[s0] - up;
            const to = blk[s1] - up;
            const otherFrom = (onA ? blk.b0 : blk.a0) - up;
            if (from <= 0 || otherFrom <= 0) break;
            if (fixedA.has(blk.a0 - up - 1)) break;
            if (prevBlk && prevBlk.a1 === blk.a0 - up - 1 && prevBlk.b1 === blk.b0 - up - 1) break;
            if (keys[from - 1] !== keys[to - 1]) break;
            up++;
        }
        let down = 0;
        while (true) {
            const from = blk[s0] + down;
            const to = blk[s1] + down;
            const otherTo = (onA ? blk.b1 : blk.a1) + down;
            if (to >= n || otherTo >= (onA ? kb.length : ka.length)) break;
            if (fixedA.has(blk.a1 + down)) break;
            if (nextBlk && nextBlk.a0 === blk.a1 + down + 1 && nextBlk.b0 === blk.b1 + down + 1) break;
            if (keys[from] !== keys[to]) break;
            down++;
        }
        if (!up && !down) continue;

        let shift = down;
        for (let s = down; s >= -up; s--) {
            if (keys[blk[s1] + s - 1].trim() === '') { shift = s; break; }
        }
        blk.a0 += shift;
        blk.a1 += shift;
        blk.b0 += shift;
        blk.b1 += shift;
    }
    return blocks;
}

// ── 2. Pairing lines inside a block ─────────────────────────────────────────

function bag(line) {
    const counts = new Map();
    let total = 0;
    for (const tok of tokenize(line)) {
        if (isSpace(tok)) continue;
        // Case says little about whether two lines are the same line edited.
        const key = tok.toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
        total++;
    }
    return { counts, total };
}

function similarity(x, y) {
    if (!x.total || !y.total) return x.total === y.total ? 1 : 0;
    const [small, large] = x.counts.size <= y.counts.size ? [x, y] : [y, x];
    let common = 0;
    for (const [tok, n] of small.counts) {
        const m = large.counts.get(tok);
        if (m) common += Math.min(n, m);
    }
    return (2 * common) / (x.total + y.total);
}

/**
 * Which lines of A and B face each other, as [i, j] index pairs in order:
 * the pairing with the most similarity in total, among lines similar enough.
 */
export function pairLines(linesA, linesB) {
    const n = linesA.length;
    const m = linesB.length;
    if (!n || !m) return [];
    // One line for one line is an edit of that line, however much changed.
    if (n === 1 && m === 1) return [[0, 0]];
    const bagsA = linesA.map(bag);
    const bagsB = linesB.map(bag);

    if (n * m > PAIR_CELLS) {
        const out = [];
        for (let k = 0; k < Math.min(n, m); k++) {
            if (similarity(bagsA[k], bagsB[k]) >= PAIR_THRESHOLD) out.push([k, k]);
        }
        return out;
    }

    const w = m + 1;
    const score = new Float64Array((n + 1) * w);
    const move = new Uint8Array((n + 1) * w);   // 1 skip A, 2 skip B, 3 pair
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            let best = score[(i - 1) * w + j];
            let how = 1;
            if (score[i * w + j - 1] > best) { best = score[i * w + j - 1]; how = 2; }
            const s = similarity(bagsA[i - 1], bagsB[j - 1]);
            if (s >= PAIR_THRESHOLD && score[(i - 1) * w + j - 1] + s > best) {
                best = score[(i - 1) * w + j - 1] + s;
                how = 3;
            }
            score[i * w + j] = best;
            move[i * w + j] = how;
        }
    }
    const out = [];
    for (let i = n, j = m; i > 0 && j > 0;) {
        const how = move[i * w + j];
        if (how === 3) { out.push([i - 1, j - 1]); i--; j--; } else if (how === 1) i--; else j--;
    }
    return out.reverse();
}

// ── 3. Words inside a paired line ───────────────────────────────────────────

/**
 * Character ranges that differ between two lines, word by word:
 * `[{ fromA, toA, fromB, toB }]`, offsets into each line.
 *
 * Changes separated only by whitespace or by a single character are joined,
 * so "foo bar" → "baz qux" is one change rather than two with a space between.
 * With `ignoreWhitespace`, changes that are whitespace on both sides go.
 */
export function wordChanges(x, y, { ignoreWhitespace = false } = {}) {
    if (x === y) return [];
    const ta = tokenize(x);
    const tb = tokenize(y);
    if (ta.length + tb.length > WORD_TOKENS) return [{ fromA: 0, toA: x.length, fromB: 0, toB: y.length }];
    const comparator = ignoreWhitespace
        ? (p, q) => p === q || (isSpace(p) && isSpace(q))
        : undefined;
    const parts = Diff.diffArrays(ta, tb, comparator ? { comparator } : {});

    const raw = [];
    let ia = 0;
    let ib = 0;
    let posA = 0;
    let posB = 0;
    let open = null;
    const advance = (side, n) => {
        let len = 0;
        if (side === 'a') { for (let k = 0; k < n; k++) len += ta[ia + k].length; ia += n; posA += len; } else { for (let k = 0; k < n; k++) len += tb[ib + k].length; ib += n; posB += len; }
    };
    for (const part of parts) {
        const n = part.count ?? part.value.length;
        if (part.added || part.removed) {
            if (!open) open = { fromA: posA, toA: posA, fromB: posB, toB: posB };
            if (part.added) { advance('b', n); open.toB = posB; } else { advance('a', n); open.toA = posA; }
        } else {
            if (open) { raw.push(open); open = null; }
            advance('a', n);
            advance('b', n);
        }
    }
    if (open) raw.push(open);

    // Ignoring whitespace means what whitespaceKey means: the AMOUNT of
    // whitespace and whitespace at either end of the line do not count, but
    // whitespace appearing or vanishing between two words does — otherwise a
    // line could be a change with nothing in it marked.
    const ignorable = (c) => {
        const sa = x.slice(c.fromA, c.toA);
        const sb = y.slice(c.fromB, c.toB);
        if ((sa && !isSpace(sa)) || (sb && !isSpace(sb))) return false;
        if (sa && sb) return true;
        const [line, from, to] = sa ? [x, c.fromA, c.toA] : [y, c.fromB, c.toB];
        return !line.slice(0, from).trim() || !line.slice(to).trim();
    };
    const kept = ignoreWhitespace ? raw.filter((c) => !ignorable(c)) : raw;
    const out = [];
    for (const c of kept) {
        const last = out[out.length - 1];
        if (last) {
            const gap = x.slice(last.toA, c.fromA);
            if (gap === y.slice(last.toB, c.fromB) && (isSpace(gap) || gap.length <= 1)) {
                last.toA = c.toA;
                last.toB = c.toB;
                continue;
            }
        }
        out.push({ ...c });
    }
    return out;
}

// ── Putting it together ─────────────────────────────────────────────────────

/**
 * Turn sync points into sorted, non-crossing line pairs inside both documents.
 * A point that crosses an earlier one is dropped.
 */
export function normalizeAnchors(anchors, nA, nB) {
    const sorted = (anchors || [])
        .filter((p) => Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[0] >= 0 && p[1] >= 0 && p[0] < nA && p[1] < nB)
        .slice()
        .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const out = [];
    for (const p of sorted) {
        const last = out[out.length - 1];
        if (!last || (p[0] > last[0] && p[1] > last[1])) out.push([p[0], p[1]]);
    }
    return out;
}

/**
 * Compare two texts.
 *
 * @param {string} a
 * @param {string} b
 * @param {object} [options]
 *   ignoreWhitespace  lines that differ only in whitespace are equal
 *   anchors           [[lineA, lineB]] sync points, 0-based line indices
 * @returns {Array<object>} chunks, in @codemirror/merge's conventions:
 *   fromA / toA   from the start of the block's first line to one past the end
 *                 of its last (so `to` may be `length + 1`); equal when the
 *                 block has no lines on that side
 *   fromB / toB   the same on B
 *   changes       word-level changes inside paired lines, relative to fromA / fromB
 *   runs          lines with no partner, as ranges relative to fromA / fromB
 *   pairs         [[i, j]] lines facing each other, relative line offsets
 *   kind          'left' (lines only on A), 'right' (only on B), 'both', or
 *                 'ws' — nothing but lines that differ in whitespace being
 *                 ignored, which is not a change to show
 *
 * Between two chunks the texts are identical, character for character.
 */
export function computeDiff(a, b, { ignoreWhitespace = false, anchors = [] } = {}) {
    const linesA = String(a).split('\n');
    const linesB = String(b).split('\n');
    const keyOf = ignoreWhitespace ? whitespaceKey : (line) => line;
    const ka = linesA.map(keyOf);
    const kb = linesB.map(keyOf);

    const matches = [];
    const fixedA = new Set();
    const forced = [];
    let pa = 0;
    let pb = 0;
    for (const [la, lb] of normalizeAnchors(anchors, linesA.length, linesB.length)) {
        if (la < pa || lb < pb) continue;
        matchRange(ka, kb, pa, la, pb, lb, matches);
        if (ka[la] === kb[lb]) {
            matches.push([la, lb]);
            fixedA.add(la);
        } else {
            forced.push([la, lb]);
        }
        pa = la + 1;
        pb = lb + 1;
    }
    matchRange(ka, kb, pa, linesA.length, pb, linesB.length, matches);

    // A forced pair splits its block, so the block must not slide.
    const nLinesA = linesA.length;
    const nLinesB = linesB.length;
    const slid = slideBlocks(blocksBetween(matches, nLinesA, nLinesB), ka, kb,
        new Set([...fixedA, ...forced.map(([la]) => la)]));

    // The merge view assumes that the text between two chunks is the same,
    // character for character, on both sides: it maps positions across by
    // offset when it lines the panes up and when it unfolds a collapsed
    // stretch on both. Two kinds of matched line break that: lines that differ
    // only in whitespace (when it is ignored), and a last line that has no
    // line break on one side but is followed by more lines on the other. Both
    // go inside a chunk, as a pair that marks nothing — on its own, a chunk of
    // only such lines is of kind 'ws' and is not shown as a change.
    const identical = (i, j) => linesA[i] === linesB[j] && (i === nLinesA - 1) === (j === nLinesB - 1);
    const blocks = [];
    let cur = null;
    const extend = (a0, a1, b0, b1) => {
        if (!cur) cur = { a0, a1, b0, b1, quiet: [] };
        cur.a1 = a1;
        cur.b1 = b1;
    };
    {
        let i = 0;
        let j = 0;
        for (const blk of [...slid, null]) {
            const stopA = blk ? blk.a0 : nLinesA;
            for (; i < stopA; i++, j++) {
                if (identical(i, j)) {
                    if (cur) { blocks.push(cur); cur = null; }
                } else {
                    extend(i, i + 1, j, j + 1);
                    cur.quiet.push([i, j]);
                }
            }
            if (!blk) break;
            extend(blk.a0, blk.a1, blk.b0, blk.b1);
            i = blk.a1;
            j = blk.b1;
        }
        if (cur) blocks.push(cur);
    }

    const startsA = lineStarts(linesA);
    const startsB = lineStarts(linesB);
    const lenA = a.length;
    const lenB = b.length;
    const fromPos = (starts, len, line) => (line < starts.length ? starts[line] : len);
    const toPos = (starts, len, line0, line1) => {
        if (line1 === line0) return fromPos(starts, len, line0);
        return line1 < starts.length ? starts[line1] : len + 1;
    };
    const lineEnd = (starts, lines, line) => starts[line] + lines[line].length;

    return blocks.map((blk) => {
        const fromA = fromPos(startsA, lenA, blk.a0);
        const fromB = fromPos(startsB, lenB, blk.b0);
        const toA = toPos(startsA, lenA, blk.a0, blk.a1);
        const toB = toPos(startsB, lenB, blk.b0, blk.b1);

        // Pair the block, honouring sync points and quiet pairs inside it.
        const pairs = [];
        let ca = blk.a0;
        let cb = blk.b0;
        const inside = [
            ...forced.filter(([la, lb]) => la >= blk.a0 && la < blk.a1 && lb >= blk.b0 && lb < blk.b1),
            ...blk.quiet,
        ].sort((x, y) => x[0] - y[0]);
        for (const [la, lb] of [...inside, [blk.a1, blk.b1]]) {
            for (const [i, j] of pairLines(linesA.slice(ca, la), linesB.slice(cb, lb))) {
                pairs.push([ca + i - blk.a0, cb + j - blk.b0]);
            }
            if (la < blk.a1) pairs.push([la - blk.a0, lb - blk.b0]);
            ca = la + 1;
            cb = lb + 1;
        }

        const changes = [];
        const runs = [];
        let ra = 0;
        let rb = 0;
        const nA = blk.a1 - blk.a0;
        const nB = blk.b1 - blk.b0;
        const addRun = (endA, endB) => {
            if (endA === ra && endB === rb) return;
            const rFromA = (ra < endA ? startsA[blk.a0 + ra] : fromPos(startsA, lenA, blk.a0 + ra)) - fromA;
            const rToA = (ra < endA ? lineEnd(startsA, linesA, blk.a0 + endA - 1) : rFromA + fromA) - fromA;
            const rFromB = (rb < endB ? startsB[blk.b0 + rb] : fromPos(startsB, lenB, blk.b0 + rb)) - fromB;
            const rToB = (rb < endB ? lineEnd(startsB, linesB, blk.b0 + endB - 1) : rFromB + fromB) - fromB;
            runs.push({ fromA: rFromA, toA: Math.max(rFromA, rToA), fromB: rFromB, toB: Math.max(rFromB, rToB) });
        };
        for (const [i, j] of pairs) {
            addRun(i, j);
            const offA = startsA[blk.a0 + i] - fromA;
            const offB = startsB[blk.b0 + j] - fromB;
            for (const c of wordChanges(linesA[blk.a0 + i], linesB[blk.b0 + j], { ignoreWhitespace })) {
                changes.push({ fromA: offA + c.fromA, toA: offA + c.toA, fromB: offB + c.fromB, toB: offB + c.toB });
            }
            ra = i + 1;
            rb = j + 1;
        }
        addRun(nA, nB);

        // What the block holds besides its quiet pairs decides its kind.
        const realA = nA - blk.quiet.length;
        const realB = nB - blk.quiet.length;
        const kind = !realA && !realB ? 'ws' : !realA ? 'right' : !realB ? 'left' : 'both';
        return { fromA, toA, fromB, toB, changes, runs, pairs, kind };
    });
}
