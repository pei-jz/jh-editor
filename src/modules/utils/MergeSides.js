/**
 * MergeSides.js — the two sides of a comparison tab, as plain data.
 *
 * A comparison used to have one direction baked in: the left pane was
 * "original", the right pane "modified", and Accept / Reject decided per block
 * which of the two ended up in a merged result that was written somewhere the
 * screen never named. Nothing said which side could be written, and a view
 * redraw threw every decision away.
 *
 * Here each side says what it is:
 *
 *   label     what the pane header shows
 *   text      what the pane holds now (edits land here immediately)
 *   savedText what the side's target holds, as far as this tab knows
 *   writable  whether edits and copies INTO this side are allowed
 *   target    where saving writes it (resolved by Editor.js)
 *   live      scratch text with no target: every edit is kept at once, so it
 *             is never "unsaved"
 *
 * The text lives on the tab's file object, not in the view, so switching tabs
 * or redrawing the view loses nothing and a background tab can still be saved.
 */
import * as Diff from 'diff';

/** Build a side. A side with nowhere to write cannot be writable. */
export function makeSide({ label = '', text = '', writable = false, target = null, live = false, onLive = null } = {}) {
    // The panes hold LF, as every editor buffer does. A CRLF copy would never
    // match the pane's text again, so the side could never be clean.
    const value = String(text ?? '').replace(/\r\n?/g, '\n');
    return {
        label: String(label),
        text: value,
        savedText: value,
        writable: !!writable && (!!target || !!live),
        target,
        live: !!live,
        onLive,
    };
}

/** The side holds edits that have not been written to its target. */
export function sideDirty(side) {
    return !!side && side.writable && !side.live && side.text !== side.savedText;
}

/** Either side holds unsaved edits. */
export function mergeDirty(merge) {
    return !!merge && (sideDirty(merge.left) || sideDirty(merge.right));
}

/** Copying a change toward `toward` ('left' | 'right') is allowed. */
export function canCopyToward(merge, toward) {
    const side = merge && (toward === 'left' ? merge.left : merge.right);
    return !!(side && side.writable);
}

/**
 * The edit that copies one changed block from `src` into `dest`.
 *
 * Block ranges follow @codemirror/merge chunks: each side's range runs from the
 * start of its first changed line to one past the end of its last, so `to` may
 * sit one beyond the document end. The block's own trailing line break is not
 * copied; one is added back unless the destination block reaches the end of
 * its document — which keeps the line count right on both kinds of edge.
 *
 * Returns `{ from, to, insert }` in `dest` coordinates.
 */
export function blockCopyEdit(src, dest, srcFrom, srcTo, destFrom, destTo) {
    let insert = src.slice(srcFrom, Math.max(srcFrom, srcTo - 1));
    if (srcFrom !== srcTo && destTo <= dest.length) insert += '\n';
    return { from: destFrom, to: Math.min(dest.length, destTo), insert };
}

/** Apply `blockCopyEdit` to a string. */
export function applyBlockCopy(src, dest, srcFrom, srcTo, destFrom, destTo) {
    const edit = blockCopyEdit(src, dest, srcFrom, srcTo, destFrom, destTo);
    return dest.slice(0, edit.from) + edit.insert + dest.slice(edit.to);
}

/** Comparison key for a line when whitespace is ignored. */
export function whitespaceKey(line) {
    return String(line).replace(/\s+/g, ' ').trim();
}

function lineStarts(lines) {
    const starts = new Array(lines.length);
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
        starts[i] = pos;
        pos += lines[i].length + 1;
    }
    return starts;
}

/**
 * A line diff that treats lines differing only in whitespace as equal, as
 * character ranges `{ fromA, toA, fromB, toB }` — the shape @codemirror/merge's
 * `diffConfig.override` returns.
 *
 * Whole lines, each range from the start of its first line to the start of the
 * line after its last. A block that runs to the end of both documents also
 * takes the line break before it, since the last line has none of its own.
 */
export function whitespaceInsensitiveChanges(a, b) {
    const linesA = a.split('\n');
    const linesB = b.split('\n');
    const parts = Diff.diffArrays(linesA, linesB, {
        comparator: (x, y) => whitespaceKey(x) === whitespaceKey(y),
    });

    const blocks = [];
    let i = 0;
    let j = 0;
    let open = null;
    for (const part of parts) {
        const n = part.count ?? part.value.length;
        if (part.added || part.removed) {
            if (!open) open = { fromA: i, toA: i, fromB: j, toB: j };
            if (part.added) { j += n; open.toB = j; } else { i += n; open.toA = i; }
        } else {
            if (open) { blocks.push(open); open = null; }
            i += n;
            j += n;
        }
    }
    if (open) blocks.push(open);

    const startsA = lineStarts(linesA);
    const startsB = lineStarts(linesB);
    const at = (starts, text, lineIndex) => (lineIndex < starts.length ? starts[lineIndex] : text.length);

    return blocks.map((blk) => {
        let fromA = at(startsA, a, blk.fromA);
        let fromB = at(startsB, b, blk.fromB);
        const toA = at(startsA, a, blk.toA);
        const toB = at(startsB, b, blk.toB);
        const atEnd = blk.toA === linesA.length && blk.toB === linesB.length;
        if (atEnd && blk.fromA > 0 && blk.fromB > 0) {
            fromA -= 1;
            fromB -= 1;
        }
        return { fromA, toA, fromB, toB };
    });
}
