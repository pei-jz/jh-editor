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
 * Two more edges come from a file whose last line has no line break: lines
 * added after it need a break in front of them, and lines removed from the end
 * take the break before them along.
 *
 * Returns `{ from, to, insert }` in `dest` coordinates.
 */
export function blockCopyEdit(src, dest, srcFrom, srcTo, destFrom, destTo) {
    let insert = src.slice(srcFrom, Math.max(srcFrom, srcTo - 1));
    let from = destFrom;
    const to = Math.min(dest.length, destTo);
    if (srcFrom !== srcTo) {
        if (destFrom === destTo && destFrom === dest.length && dest.length && !dest.endsWith('\n')) insert = `\n${insert}`;
        else if (destTo <= dest.length) insert += '\n';
    } else if (destTo > dest.length && from > 0 && dest[from - 1] === '\n') {
        from -= 1;
    }
    return { from, to, insert };
}

/** Apply `blockCopyEdit` to a string. */
export function applyBlockCopy(src, dest, srcFrom, srcTo, destFrom, destTo) {
    const edit = blockCopyEdit(src, dest, srcFrom, srcTo, destFrom, destTo);
    return dest.slice(0, edit.from) + edit.insert + dest.slice(edit.to);
}

/**
 * The edit that keeps BOTH versions of a block in `dest`: the destination's
 * own lines and the source's, one after the other (`srcFirst` puts the source's
 * first). Ranges as for `blockCopyEdit`.
 *
 * Returns `{ from, to, insert, select }`, where `select` is the combined block
 * in the document after the edit — what the user goes on to edit by hand.
 */
export function blockCombineEdit(src, dest, srcFrom, srcTo, destFrom, destTo, srcFirst = false) {
    if (srcFrom === srcTo) {
        // Nothing to add: the destination's lines already are "both".
        const end = Math.max(destFrom, Math.min(dest.length, destTo) - (destTo <= dest.length ? 1 : 0));
        return { from: destFrom, to: destFrom, insert: '', select: { from: destFrom, to: end } };
    }
    if (destFrom === destTo) {
        const edit = blockCopyEdit(src, dest, srcFrom, srcTo, destFrom, destTo);
        const lead = edit.insert.startsWith('\n') ? 1 : 0;
        const tail = !lead && edit.insert.endsWith('\n') ? 1 : 0;
        return { ...edit, select: { from: edit.from + lead, to: edit.from + edit.insert.length - tail } };
    }
    const srcText = src.slice(srcFrom, Math.max(srcFrom, srcTo - 1));
    const destText = dest.slice(destFrom, Math.max(destFrom, destTo - 1));
    const body = srcFirst ? `${srcText}\n${destText}` : `${destText}\n${srcText}`;
    return {
        from: destFrom,
        to: Math.min(dest.length, destTo),
        insert: destTo <= dest.length ? `${body}\n` : body,
        select: { from: destFrom, to: destFrom + body.length },
    };
}

/** Comparison key for a line when whitespace is ignored. */
export function whitespaceKey(line) {
    return String(line).replace(/\s+/g, ' ').trim();
}
