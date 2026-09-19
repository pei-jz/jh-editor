import { EditorSelection, findColumn } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Page Up / Page Down that leave the caret in the column it started in.
 *
 * CodeMirror's own cursorPageUp / cursorPageDown ask posAtCoords() for the
 * position at the caret's x on a line a screenful away. That line has almost
 * never been rendered — paging is exactly the move that leaves the rendered
 * range — so posAtCoords() falls back to an estimate, and the estimate in
 * @codemirror/view multiplies the x offset by the character width where it has
 * to divide by it:
 *
 *     let into = Math.round((x - contentRect.left) * view.defaultCharacterWidth)
 *
 * At the left margin that turns 8px into column 62. The caret lands 62 columns
 * to the right of where it was — or, on any line shorter than that, at the
 * line's end, because that is as far as the column can go. Press again and the
 * next page starts from there, so holding PageDown walks the caret rightwards
 * until it is stuck against the end of every line it touches. (Still present in
 * 6.43.12, and in every 6.x back to at least 6.26.)
 *
 * So the move is done here. The distance still comes from the height map, which
 * is correct with line wrapping on and does not need the target rendered; the
 * column is resolved by CodeMirror when the target line IS rendered, and by the
 * corrected estimate when it is not. The goal is carried in the same units and
 * origin CodeMirror uses (pixels from the content's left edge), so Arrow
 * Up/Down pick the column back up where paging left it.
 */

/** How far one page travels, and the margins to keep clear. CM6's pageInfo(). */
function pageInfo(view) {
    const selfScroll = view.scrollDOM.clientHeight < view.scrollDOM.scrollHeight - 2;
    let marginTop = 0, marginBottom = 0, height;
    if (selfScroll) {
        for (const source of view.state.facet(EditorView.scrollMargins)) {
            const margins = source(view);
            if (margins && margins.top) marginTop = Math.max(marginTop, margins.top);
            if (margins && margins.bottom) marginBottom = Math.max(marginBottom, margins.bottom);
        }
        height = view.scrollDOM.clientHeight - marginTop - marginBottom;
    } else {
        height = (view.dom.ownerDocument.defaultView || window).innerHeight;
    }
    return { marginTop, marginBottom, selfScroll, height: Math.max(view.defaultLineHeight, height - 5) };
}

/**
 * Offset in `line` for a goal `x` (pixels from the content's left edge), for a
 * line the DOM has not laid out. `y` is document-relative, as `block.top` is,
 * and `originX` is where column 0 sits — the line's own left padding, which is
 * part of `x` and is not text.
 */
function estimatePos(view, block, line, x, y, originX, tabSize) {
    let cols = Math.max(0, Math.round((x - originX) / view.defaultCharacterWidth));
    // A wrapped line covers several rows; add the rows above the target one.
    // How many characters a row holds is the content width over the character
    // width — the row's capacity. Where the words actually break is not known
    // without laying the line out, so this can be a character or two off inside
    // a wrapped line. It does not compound: the goal is carried unchanged, so
    // the next page still aims at the column the caret started in.
    if (view.lineWrapping && block.height > view.defaultLineHeight * 1.5) {
        const rows = Math.max(1, Math.round(block.height / view.defaultLineHeight));
        const row = Math.max(0, Math.min(rows - 1,
            Math.floor((y - block.top) / view.defaultLineHeight)));
        cols += row * Math.max(1, Math.floor(view.contentDOM.clientWidth / view.defaultCharacterWidth));
    }
    return line.from + findColumn(line.text, cols, tabSize);
}

/** Move one cursor a page in `dir` (1 = down). Returns the new cursor range. */
function movePageRange(view, range, forward, dist) {
    const { state } = view;

    // Already against the edge it is paging towards. Return the caret exactly as
    // it is — goal and all — so the command can see that nothing moved and
    // report the key unhandled rather than dispatching a no-op.
    const edge = forward ? state.doc.length : 0;
    if (range.head === edge) return EditorSelection.cursor(edge, range.assoc, undefined, range.goalColumn);

    const contentRect = view.contentDOM.getBoundingClientRect();

    let goal = range.goalColumn;
    if (goal == null) {
        const coords = view.coordsAtPos(range.head, range.assoc || 1);
        goal = coords ? coords.left - contentRect.left : 0;
    }

    const from = view.lineBlockAt(range.head);
    // Where column 0 is. The goal is measured from the content box, but a line
    // starts a few pixels further in (.cm-line has a left padding), and
    // dividing that padding by the character width is what would otherwise put
    // the caret one column right of home on every page.
    const startCoords = view.coordsAtPos(from.from);
    const originX = startCoords ? startCoords.left - contentRect.left : 0;
    const rawY = (forward ? from.bottom : from.top) + (forward ? dist : -dist);
    const y = Math.max(0, Math.min(view.contentHeight - 1, rawY));
    const target = view.lineBlockAtHeight(y);

    // A page that cannot get past the line it started on has run out of
    // document. Finish the move at the end of it, the way every other editor
    // does, rather than leaving the caret where it was.
    if (target.from === from.from && target.to === from.to) {
        return EditorSelection.cursor(edge, undefined, undefined, goal);
    }

    let pos = null;
    // Rendered → let CodeMirror measure it; that path is exact.
    if (target.from >= view.viewport.from && target.to <= view.viewport.to) {
        pos = view.posAtCoords({ x: contentRect.left + goal, y: view.documentTop + y });
    }
    if (pos == null) {
        pos = estimatePos(view, target, state.doc.lineAt(target.from), goal, y, originX, state.tabSize);
    }
    return EditorSelection.cursor(pos, undefined, undefined, goal);
}

function pageCommand(forward, extend) {
    return (view) => {
        const { state } = view;
        const page = pageInfo(view);
        const startHead = state.selection.main.head;

        const selection = EditorSelection.create(
            state.selection.ranges.map((range) => {
                if (extend) {
                    const moved = movePageRange(view, range, forward, page.height);
                    return EditorSelection.range(range.anchor, moved.head, moved.goalColumn);
                }
                // An unshifted page from a selection collapses it first, so the
                // first press only drops the selection (CM6 does the same).
                if (!range.empty) return EditorSelection.cursor(forward ? range.to : range.from);
                return movePageRange(view, range, forward, page.height);
            }),
            state.selection.mainIndex,
        );
        if (selection.eq(state.selection)) return false;

        // Keep the caret at the same height on screen, so the text moves under
        // it rather than the caret jumping to an edge.
        let effect;
        if (page.selfScroll) {
            const startPos = view.coordsAtPos(startHead);
            const scrollRect = view.scrollDOM.getBoundingClientRect();
            const scrollTop = scrollRect.top + page.marginTop;
            const scrollBottom = scrollRect.bottom - page.marginBottom;
            if (startPos && startPos.top > scrollTop && startPos.bottom < scrollBottom) {
                effect = EditorView.scrollIntoView(selection.main.head, {
                    y: 'start',
                    yMargin: startPos.top - scrollTop,
                });
            }
        }
        view.dispatch({ selection, userEvent: 'select', scrollIntoView: true, effects: effect });
        return true;
    };
}

export const cursorPageUp = pageCommand(false, false);
export const cursorPageDown = pageCommand(true, false);
export const selectPageUp = pageCommand(false, true);
export const selectPageDown = pageCommand(true, true);

/**
 * Bind these BEFORE `defaultKeymap` in the same keymap array: the first binding
 * that handles the key wins, so these replace CodeMirror's PageUp / PageDown
 * without having to filter them out of defaultKeymap.
 */
export const pageMotionKeymap = [
    { key: 'PageUp', run: cursorPageUp, shift: selectPageUp },
    { key: 'PageDown', run: cursorPageDown, shift: selectPageDown },
];
