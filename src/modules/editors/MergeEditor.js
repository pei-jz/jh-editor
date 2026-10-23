/**
 * MergeEditor.js — a side-by-side comparison where either side can be edited.
 *
 * This replaces DiffEditor, whose model was "original on the left, modified on
 * the right, Accept / Reject per block, then Apply & Save". That had three
 * problems the model itself caused:
 *
 *  - Nothing on screen said which side could be written or where Apply went.
 *    Git and agent diffs showed the same buttons and Apply simply closed them.
 *  - Decisions lived in the rendered hunks, so toggling the view, the
 *    whitespace option or the tab reset every block to Accept — while the
 *    source tab had already been handed the rejected text.
 *  - Only one direction existed. Two files could not be merged toward the left.
 *
 * Here each pane is a CodeMirror editor over its side's own text
 * (utils/MergeSides.js). A side is either writable — typed into directly, or
 * given a block with ← / → — or read-only, and the header says which. Nothing
 * reaches disk until the tab is saved, which writes each edited side to its own
 * target. Because the texts live on the tab's file object, redrawing loses
 * nothing: the diff is recomputed from what the panes hold.
 *
 * The change being worked on is outlined on both sides, and its ← / → controls
 * sit on a band as tall as the change, so the buttons read as belonging to it.
 *
 * The differences themselves come from utils/LineDiff.js, not from the
 * package: lines first, then words. Each change says whether it exists on the
 * left only, the right only, or on both (a conflict), and is coloured that way.
 * A conflict also offers to keep both versions, in either order, for editing.
 * Lines paired inside a change are lined up with padding, and sync points let
 * the user say which two lines belong together when the match goes wrong.
 */
import { EditorState, Compartment, StateEffect, StateField, Transaction, RangeSet } from '@codemirror/state';
import {
    EditorView, Decoration, WidgetType, GutterMarker, gutterLineClass, keymap, lineNumbers,
    highlightSpecialChars, drawSelection, highlightActiveLine, highlightWhitespace,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import {
    MergeView, unifiedMergeView, getChunks, getOriginalDoc, Change, Chunk,
} from '@codemirror/merge';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { pageMotionKeymap } from '../utils/CMPageMotion.js';
import { t } from '../utils/I18n.js';
import { languageExtensionFor, syntaxExtensionForTheme } from '../views/CodeMirrorView.js';
import {
    canCopyToward, mergeDirty, sideDirty, blockCopyEdit, blockCombineEdit,
} from '../utils/MergeSides.js';
import { computeDiff } from '../utils/LineDiff.js';

// Long unchanged stretches fold away, keeping a few lines of context.
const COLLAPSE = { margin: 3, minSize: 8 };

// Past this many characters on both sides together the package's own diff
// takes over: ours recomputes the whole comparison on every edit.
const OWN_DIFF_LIMIT = 4 * 1024 * 1024;

/*
 * The merge view gets its chunks from Chunk.build / updateA / updateB, and
 * offers no hook to supply them: `diffConfig.override` only replaces the
 * character diff, which the package then regroups into lines itself, and
 * the incremental update hands it slices of the documents. So the three are
 * wrapped, once, to defer to a config that carries its own `buildChunks` —
 * any other config (another merge view in the app) is passed straight through.
 */
const ownChunks = (conf) => !!conf && typeof conf.buildChunks === 'function';
const baseBuild = Chunk.build;
const baseUpdateA = Chunk.updateA;
const baseUpdateB = Chunk.updateB;
if (!Chunk.build.jhWrapped) {
    Chunk.build = function build(a, b, conf) {
        return ownChunks(conf) ? conf.buildChunks(a, b, null) : baseBuild.call(this, a, b, conf);
    };
    Chunk.build.jhWrapped = true;
    Chunk.updateA = function updateA(chunks, a, b, changes, conf) {
        return ownChunks(conf) ? conf.buildChunks(a, b, { side: 'a', changes })
            : baseUpdateA.call(this, chunks, a, b, changes, conf);
    };
    Chunk.updateB = function updateB(chunks, a, b, changes, conf) {
        return ownChunks(conf) ? conf.buildChunks(a, b, { side: 'b', changes })
            : baseUpdateB.call(this, chunks, a, b, changes, conf);
    };
}

/** A LineDiff result as the package's Chunk, keeping what only we know. */
function toChunk(c) {
    const chunk = new Chunk(c.changes.map((x) => new Change(x.fromA, x.toA, x.fromB, x.toB)),
        c.fromA, c.toA, c.fromB, c.toB);
    chunk.kind = c.kind;
    chunk.pairs = c.pairs;
    chunk.runs = c.runs;
    return chunk;
}

/** 'left' | 'right' | 'both' | 'ws' for any chunk, ours or the package's. */
export function chunkKind(chunk) {
    if (chunk.kind) return chunk.kind;
    if (chunk.fromA === chunk.toA) return 'right';
    if (chunk.fromB === chunk.toB) return 'left';
    return 'both';
}

/** A chunk that is a change to show: not whitespace only (see LineDiff). */
const isShown = (chunk) => chunkKind(chunk) !== 'ws';

/**
 * The line facing line `line` (1-based) of side `side` ('a' | 'b'), given
 * the chunks between documents `docA` / `docB` (CodeMirror Text).
 *
 * Returns `{ a, b, chunk }`: both line numbers (null on the side that has no
 * such line — it was added or removed) and the index of the chunk the line is
 * in, or -1 for an unchanged line. Outside chunks the sides are identical, so
 * an unchanged line's partner is found by counting.
 */
export function lineCounterpart(chunks, docA, docB, side, line) {
    const isA = side === 'a';
    let shift = 0;          // lines on the other side minus lines on this one, so far
    for (let k = 0; k < chunks.length; k++) {
        const ch = chunks[k];
        const [ownDoc, otherDoc] = isA ? [docA, docB] : [docB, docA];
        const [from, to, oFrom, oTo] = isA
            ? [ch.fromA, ch.toA, ch.fromB, ch.toB]
            : [ch.fromB, ch.toB, ch.fromA, ch.toA];
        const start = ownDoc.lineAt(Math.min(from, ownDoc.length)).number;
        const count = linesIn(ownDoc, from, to);
        const oStart = otherDoc.lineAt(Math.min(oFrom, otherDoc.length)).number;
        const oCount = linesIn(otherDoc, oFrom, oTo);
        if (line < start) break;
        if (line < start + count) {
            const rel = line - start;
            let other = null;
            if (ch.pairs) {
                const pair = ch.pairs.find((p) => (isA ? p[0] : p[1]) === rel);
                if (pair) other = oStart + (isA ? pair[1] : pair[0]);
            } else if (rel < oCount) {
                // The package's own chunks (very large files) pair by position.
                other = oStart + rel;
            }
            return isA ? { a: line, b: other, chunk: k } : { a: other, b: line, chunk: k };
        }
        shift += oCount - count;
    }
    const other = line + shift;
    const otherDoc = isA ? docB : docA;
    const valid = other >= 1 && other <= otherDoc.lines ? other : null;
    return isA ? { a: line, b: valid, chunk: -1 } : { a: valid, b: line, chunk: -1 };
}

// Selections the comparison makes itself, so they do not count as the user
// moving away from the word being looked at.
const OWN_SELECTION = 'select.merge';

const readFlag = (key) => {
    try { return localStorage.getItem(key) === 'true'; } catch (_) { return false; }
};
const writeFlag = (key, on) => {
    try { localStorage.setItem(key, on ? 'true' : 'false'); } catch (_) { /* private mode */ }
};

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/**
 * The number of the last line a chunk side `from`..`to` covers (non-empty).
 * `to` one past the document end means the block runs through the last line —
 * which, when the text ends with a line break, is the empty line after it:
 * `to - 1` would stop one line short.
 */
function lastLineOf(doc, from, to) {
    if (to > doc.length) return doc.lines;
    return doc.lineAt(Math.max(from, to - 1)).number;
}

/** Lines a chunk covers in `doc` (0 when it is an empty range on that side). */
function linesIn(doc, from, to) {
    if (to <= from) return 0;
    return lastLineOf(doc, from, to) - doc.lineAt(Math.min(from, doc.length)).number + 1;
}

/**
 * What a key press does in the comparison, or null for "not ours".
 *
 *   Alt+↑ / Alt+↓            previous / next change
 *   Alt+← / Alt+→            previous / next change inside a line (word level)
 *   Alt+Shift+← / Alt+Shift+→ copy the current change to that side
 *   Alt+M                    how to merge the current change (keep both, …)
 *   Alt+S                    sync point: the cursor lines on both sides belong together
 *   Alt+D                    line details: the cursor line and its counterpart, wrapped
 *   Alt+I / Alt+W            ignore / show whitespace
 *   Ctrl+↑ / Ctrl+↓          previous / next file (Git comparisons only)
 */
export function mergeKeyAction(e, { hasFileNav = false } = {}) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        if (!hasFileNav) return null;
        return e.key === 'ArrowDown' ? 'next-file' : 'prev-file';
    }
    if (!e.altKey || mod) return null;
    if (e.shiftKey) {
        if (e.key === 'ArrowLeft') return 'copy-left';
        if (e.key === 'ArrowRight') return 'copy-right';
        return null;
    }
    switch (e.key) {
        case 'ArrowUp': return 'prev-change';
        case 'ArrowDown': return 'next-change';
        case 'ArrowLeft': return 'prev-inline';
        case 'ArrowRight': return 'next-inline';
        case 'i': case 'I': return 'ignore-whitespace';
        case 'w': case 'W': return 'show-whitespace';
        case 'd': case 'D': return 'toggle-details';
        case 'm': case 'M': return 'merge-menu';
        case 's': case 'S': return 'sync-point';
        default: return null;
    }
}

// ── Kinds, padding inside a change, sync points ─────────────────────────────

/**
 * Blank space standing in for lines the other side has, so the lines paired
 * inside a change sit side by side (WinMerge's ghost lines). The package only
 * aligns the two sides between changes; inside one, everything below an
 * inserted line was a line out.
 */
class PadWidget extends WidgetType {
    constructor(lines) {
        super();
        this.lines = lines;
    }

    eq(other) { return other.lines === this.lines; }

    /**
     * One empty line per missing line, rather than a computed height: a
     * height taken from the theme's variable or from a measurement made
     * before the styles applied was a fraction of a pixel off per line, and
     * that added up down a long change. An empty line is exactly as tall as a
     * real one.
     */
    toDOM() {
        const pad = document.createElement('div');
        pad.className = 'cm-merge-pad';
        pad.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < this.lines; i++) {
            const line = document.createElement('div');
            line.className = 'cm-merge-pad-line';
            line.textContent = '​';
            pad.appendChild(line);
        }
        return pad;
    }

    get estimatedHeight() { return this.lines * 22; }

    ignoreEvent() { return false; }
}

/**
 * Nothing at all, at the start of every changed line. It works around a
 * CodeMirror redraw bug: the package wraps a whole change in one <ins> / <del>
 * mark, and when a line decoration changes on a line in the middle of such a
 * mark — the cursor's line, a sync point, the current change — the line was
 * redrawn with no attributes at all. The cursor line inside a change lost its
 * colour, and the word highlights looked like they had gone. A widget there
 * makes the redraw start the line properly.
 */
class LineAnchorWidget extends WidgetType {
    eq() { return true; }

    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-merge-line-anchor';
        return span;
    }

    ignoreEvent() { return false; }
}

const lineAnchor = Decoration.widget({ widget: new LineAnchorWidget(), side: -1 });

const kindLine = {
    left: Decoration.line({ class: 'cm-merge-kind-left' }),
    right: Decoration.line({ class: 'cm-merge-kind-right' }),
    both: Decoration.line({ class: 'cm-merge-kind-both' }),
    ws: Decoration.line({ class: 'cm-merge-kind-ws' }),
};

// The package marks a whitespace-only chunk's gutter like any change; this
// class lets the theme take that back.
const wsGutter = new class extends GutterMarker {
    constructor() {
        super();
        this.elementClass = 'cm-merge-ws-gutter';
    }
}();

/**
 * For one side: the redraw anchors on every changed line and, side by side
 * (`split`), the kind classes and the padding inside changes.
 */
function layoutDecorations(state, split) {
    const found = getChunks(state);
    if (!found || !found.chunks || !found.side) return { deco: Decoration.none, gutter: RangeSet.empty };
    const isA = found.side === 'a';
    const { doc } = state;
    const ranges = [];
    const quiet = [];
    for (const ch of found.chunks) {
        const from = isA ? ch.fromA : ch.fromB;
        const to = isA ? ch.toA : ch.toB;
        if (to <= from) continue;
        const first = doc.lineAt(Math.min(from, doc.length)).number;
        const last = lastLineOf(doc, from, to);
        const deco = kindLine[chunkKind(ch)];
        for (let n = first; n <= last; n++) {
            const start = doc.line(n).from;
            ranges.push(lineAnchor.range(start));
            if (split) ranges.push(deco.range(start));
            if (split && chunkKind(ch) === 'ws') quiet.push(wsGutter.range(start));
        }
        if (!split) continue;

        // Walk the pairs; whichever side is behind gets padding before the pair.
        let padA = 0;
        let padB = 0;
        for (const [i, j] of ch.pairs || []) {
            const atA = i + padA;
            const atB = j + padB;
            if (atA === atB) continue;
            const lines = Math.abs(atA - atB);
            const behindA = atA < atB;
            if (behindA) padA += lines; else padB += lines;
            if (behindA !== isA) continue;
            const n = first + (isA ? i : j);
            if (n > doc.lines) continue;
            ranges.push(Decoration.widget({ widget: new PadWidget(lines), block: true, side: -1 })
                .range(doc.line(n).from));
        }
    }
    return { deco: Decoration.set(ranges, true), gutter: RangeSet.of(quiet) };
}

const layoutFieldFor = (split) => StateField.define({
    create: (state) => layoutDecorations(state, split),
    update(value, tr) {
        const before = getChunks(tr.startState);
        const after = getChunks(tr.state);
        if ((before && before.chunks) !== (after && after.chunks)) return layoutDecorations(tr.state, split);
        return { deco: value.deco.map(tr.changes), gutter: value.gutter.map(tr.changes) };
    },
    provide: (field) => [
        EditorView.decorations.from(field, (value) => value.deco),
        gutterLineClass.from(field, (value) => value.gutter),
    ],
});
const layoutField = layoutFieldFor(true);
const unifiedLayoutField = layoutFieldFor(false);

const setSyncLines = StateEffect.define();
const syncLine = Decoration.line({ class: 'cm-merge-sync' });
const syncGutter = new class extends GutterMarker {
    constructor() {
        super();
        this.elementClass = 'cm-merge-sync-gutter';
    }
}();

/**
 * The sync points on one side: a dashed rule over each line, and its line
 * number marked — the rule alone vanished under the current change's frame.
 */
const syncField = StateField.define({
    create: () => ({ deco: Decoration.none, gutter: RangeSet.empty }),
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setSyncLines)) {
                const { doc } = tr.state;
                const lines = [...new Set(effect.value.map((pos) => doc.lineAt(Math.min(pos, doc.length)).from))]
                    .sort((x, y) => x - y);
                return {
                    deco: Decoration.set(lines.map((pos) => syncLine.range(pos))),
                    gutter: RangeSet.of(lines.map((pos) => syncGutter.range(pos))),
                };
            }
        }
        return { deco: value.deco.map(tr.changes), gutter: value.gutter.map(tr.changes) };
    },
    provide: (field) => [
        EditorView.decorations.from(field, (value) => value.deco),
        gutterLineClass.from(field, (value) => value.gutter),
    ],
});

// ── The outline around the current change ────────────────────────────────────

const setFocus = StateEffect.define();

/**
 * A mark on the word-level change being looked at and, in the unified view
 * only, line decorations framing the change. The side-by-side view draws its
 * frame as an overlay instead (MergeEditor._layoutFocusFrames): a side where
 * the change has no lines holds only the package's spacer, which a line
 * decoration cannot reach, so that side showed nothing but a rule on top.
 */
function focusDecorations(state, focus) {
    if (!focus) return Decoration.none;
    const { doc } = state;
    const ranges = [];
    if (focus.lines && focus.to > focus.from) {
        const first = doc.lineAt(Math.min(focus.from, doc.length)).number;
        const last = lastLineOf(doc, focus.from, focus.to);
        for (let n = first; n <= last; n++) {
            let cls = 'cm-merge-focus';
            if (n === first) cls += ' cm-merge-focus-top';
            if (n === last) cls += ' cm-merge-focus-bottom';
            ranges.push(Decoration.line({ class: cls }).range(doc.line(n).from));
        }
    } else if (focus.lines) {
        const pos = Math.min(focus.from, doc.length);
        const line = doc.lineAt(pos);
        const after = pos >= doc.length && line.from < pos;
        ranges.push(Decoration.line({ class: after ? 'cm-merge-focus-gap-after' : 'cm-merge-focus-gap-before' })
            .range(line.from));
    }
    const inlineFrom = Math.min(focus.inlineFrom ?? 0, doc.length);
    const inlineTo = Math.min(focus.inlineTo ?? 0, doc.length);
    // Across lines (a whole inserted block) the frame already says it; a mark
    // there would box every line separately.
    if (inlineTo > inlineFrom && doc.lineAt(inlineFrom).number === doc.lineAt(inlineTo).number) {
        ranges.push(Decoration.mark({ class: 'cm-merge-inline-focus' }).range(inlineFrom, inlineTo));
    }
    return Decoration.set(ranges, true);
}

const focusField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setFocus)) return focusDecorations(tr.state, effect.value);
        }
        return deco.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
});

const FOCUS = 'var(--primary-color, #3794ff)';

const mergeTheme = EditorView.theme({
    '&': {
        color: 'var(--text-color)',
        backgroundColor: 'transparent',
        fontSize: 'var(--editor-font-size, 11.5pt)',
        fontFamily: "var(--editor-font-family, Consolas, 'Courier New', monospace)",
        lineHeight: 'var(--editor-line-height-px, 22px)',
    },
    '.cm-content': { caretColor: 'var(--text-color)' },
    '.cm-line': { paddingLeft: '4px' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text-color)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'var(--cm-selection-bg, rgba(51, 144, 250, 0.18))',
    },
    '.cm-activeLine': { backgroundColor: 'var(--cm-active-line-bg, rgba(127, 127, 127, 0.09))' },
    '.cm-gutters': {
        backgroundColor: 'var(--bg-color)',
        color: 'var(--text-secondary)',
        border: 'none',
    },
    // Removed on the left, added on the right — the unified view, and any
    // change that carries no kind. The `.cm-editor .cm-line` steps outrank the
    // package's `&dark` rules, which otherwise won in a dark theme and drew a
    // word change as a 2px rule under the line instead of a background.
    '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': {
        backgroundColor: 'rgba(248, 81, 73, 0.14)',
    },
    '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
        backgroundColor: 'rgba(46, 160, 67, 0.14)',
    },
    '&.cm-merge-a.cm-editor .cm-line .cm-changedText, &.cm-editor .cm-deletedChunk .cm-deletedText': {
        background: 'rgba(248, 81, 73, 0.4)',
        borderRadius: '2px',
    },
    '&.cm-merge-b.cm-editor .cm-line .cm-changedText': {
        background: 'rgba(46, 160, 67, 0.4)',
        borderRadius: '2px',
    },
    '&.cm-merge-a .cm-changedLineGutter': { background: '#f85149' },
    '&.cm-merge-b .cm-changedLineGutter': { background: '#3fb950' },
    // Side by side, by kind: only on the left, only on the right, or on both
    // (a conflict — neither side's version wins without a decision).
    '& .cm-line.cm-changedLine.cm-merge-kind-left': { backgroundColor: 'rgba(248, 81, 73, 0.15)' },
    '& .cm-line.cm-changedLine.cm-merge-kind-right': { backgroundColor: 'rgba(46, 160, 67, 0.15)' },
    '& .cm-line.cm-changedLine.cm-merge-kind-both': { backgroundColor: 'rgba(210, 153, 34, 0.16)' },
    '&.cm-editor .cm-line.cm-merge-kind-both .cm-changedText': {
        background: 'rgba(210, 153, 34, 0.5)',
        borderRadius: '2px',
    },
    // Whitespace-only chunks (whitespace ignored) look unchanged.
    '& .cm-line.cm-changedLine.cm-merge-kind-ws': { backgroundColor: 'transparent' },
    '&.cm-editor .cm-gutterElement.cm-changedLineGutter.cm-merge-ws-gutter': { background: 'transparent' },
    '.cm-merge-pad, .cm-mergeSpacer': {
        backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 5px, rgba(127, 127, 127, 0.13) 5px 6px)',
    },
    // A sync point: a dashed rule over the line, on both sides.
    '.cm-line.cm-merge-sync': {
        backgroundImage: 'linear-gradient(to right, #a371f7 60%, transparent 60%)',
        backgroundSize: '8px 2px',
        backgroundRepeat: 'repeat-x',
        backgroundPosition: 'left top',
    },
    '.cm-gutterElement.cm-merge-sync-gutter': {
        backgroundColor: 'rgba(163, 113, 247, 0.35)',
        color: 'var(--text-color)',
        fontWeight: '700',
    },
    '.cm-collapsedLines': {
        color: 'var(--text-secondary)',
        background: 'var(--bg-color-secondary)',
    },
    // Inset shadows rather than borders: a border would push the text over.
    '.cm-merge-focus': {
        boxShadow: `inset 2px 0 0 ${FOCUS}, inset -2px 0 0 ${FOCUS}`,
    },
    '.cm-merge-focus.cm-merge-focus-top': {
        boxShadow: `inset 2px 0 0 ${FOCUS}, inset -2px 0 0 ${FOCUS}, inset 0 2px 0 ${FOCUS}`,
        borderTopLeftRadius: '6px',
        borderTopRightRadius: '6px',
    },
    '.cm-merge-focus.cm-merge-focus-bottom': {
        boxShadow: `inset 2px 0 0 ${FOCUS}, inset -2px 0 0 ${FOCUS}, inset 0 -2px 0 ${FOCUS}`,
        borderBottomLeftRadius: '6px',
        borderBottomRightRadius: '6px',
    },
    '.cm-merge-focus.cm-merge-focus-top.cm-merge-focus-bottom': {
        boxShadow: `inset 0 0 0 2px ${FOCUS}`,
        borderRadius: '6px',
    },
    '.cm-merge-focus-gap-before': { boxShadow: `inset 0 2px 0 ${FOCUS}` },
    '.cm-merge-focus-gap-after': { boxShadow: `inset 0 -2px 0 ${FOCUS}` },
    // Drawn inside the word, not around it: an outline outside overlapped the
    // neighbouring highlights and, on a one-line change, the line below.
    '.cm-merge-inline-focus': {
        boxShadow: `inset 0 0 0 2px ${FOCUS}`,
        borderRadius: '2px',
    },
});

export class MergeEditor {
    /**
     * @param {HTMLElement} container
     * @param {object} file     the tab; `file.merge` holds { title, path, nav, left, right }
     * @param {object} options
     *   onDirtyChange()   the tab's unsaved state flipped (redraw the tab strip)
     *   onSave()          save the tab (Ctrl+S goes the same way)
     *   extraActions      [{ label, title, onClick }] extra toolbar buttons
     */
    constructor(container, file, options = {}) {
        this.container = container;
        this.file = file;
        this.merge = file.merge;
        this.options = options;

        this.ignoreWhitespace = readFlag('diff_ignoreWhitespace');
        this.showWhitespace = readFlag('diff_showWhitespace');
        this.showDetails = readFlag('diff_showDetails');
        this._appliedDetailsKey = '';
        this.viewMode = 'split';
        this.mergeView = null;
        this.unifiedView = null;
        this._lastFocused = null;
        this._refreshTimer = null;
        this._layoutFrame = null;
        this._inline = null;        // the word-level change last navigated to
        this._hoverChunk = null;    // chunk whose copy band the pointer is over
        this._focusIndex = -1;      // chunk currently outlined
        this._appliedFocusKey = '';
        this._appliedSyncKey = '';
        this._menu = null;          // the open "how to merge" menu
        this._rediffing = false;    // a recompute in progress, not an edit
        // Sync points as line-start positions { a, b }, kept on the tab like
        // the texts so a redraw keeps them.
        if (!Array.isArray(this.merge.anchors)) this.merge.anchors = [];

        this.syntaxCompartment = new Compartment();
        this.whitespaceCompartment = new Compartment();

        this._onThemeChanged = () => {
            this._forEachEditor((ed) => ed.dispatch({
                effects: this.syntaxCompartment.reconfigure(syntaxExtensionForTheme()),
            }));
        };
        window.addEventListener('themeChanged', this._onThemeChanged);

        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener('keydown', this._onKeyDown, true);

        this._build();
    }

    // ── Layout ───────────────────────────────────────────────────────────────

    _build() {
        const c = this.container;
        c.innerHTML = '';
        c.classList.add('merge-editor');
        // The editor area pads its content for documents; a comparison is a
        // tool surface and uses the whole pane, like the editor tab does.
        c.style.padding = '0';
        c.style.overflow = 'hidden';
        c.style.display = 'flex';
        c.style.flexDirection = 'column';
        c.appendChild(this._buildToolbar());

        this.headersEl = el('div', 'merge-headers');
        c.appendChild(this.headersEl);

        this.bodyEl = el('div', 'merge-body');
        this.minimapEl = el('div', 'diff-minimap');
        this.minimapEl.title = t('Distribution of changes (click to jump)');
        this.minimapViewportEl = el('div', 'diff-minimap-viewport');
        this.minimapEl.appendChild(this.minimapViewportEl);
        this.minimapEl.addEventListener('click', (e) => this._onMinimapClick(e));
        this.bodyEl.appendChild(this.minimapEl);
        c.appendChild(this.bodyEl);

        // One horizontal scrollbar for both panes, always in view. Each pane
        // scrolls sideways on its own, and the package lets its panes grow to
        // their full height, so their own bars sat under the LAST line of the
        // file — out of sight until scrolled to the end.
        this.hscrollEl = el('div', 'merge-hscroll');
        this.hscrollInner = el('div', 'merge-hscroll-inner');
        this.hscrollEl.appendChild(this.hscrollInner);
        this.hscrollEl.hidden = true;
        this.hscrollEl.addEventListener('scroll', () => this._onHScroll(this.hscrollEl));
        c.appendChild(this.hscrollEl);

        // The cursor line and the line it faces, one above the other and
        // wrapped: a long line compared whole, without scrolling sideways.
        this.detailsEl = el('div', 'merge-details');
        this.detailsEl.hidden = !this.showDetails;
        c.appendChild(this.detailsEl);
        this._hLeft = 0;

        this._mountEditors();
    }

    _button(text, title, onClick, className = 'diff-btn') {
        const b = el('button', className, text);
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    _buildToolbar() {
        const bar = el('div', 'diff-toolbar');

        const title = el('div', 'diff-toolbar-title');
        title.appendChild(el('strong', null, this.merge.title || ''));
        bar.appendChild(title);

        const actions = el('div', 'diff-toolbar-actions');

        // A comparison that is one file of several (Git) can step to the
        // others; the keys were the only way, and nothing said they existed.
        const fileNav = this.merge.nav;
        if (fileNav) {
            const files = el('div', 'diff-nav diff-file-nav');
            const prev = this._button('⇡', t('Previous file (Ctrl+Up)'), () => fileNav.onPrevFile());
            const next = this._button('⇣', t('Next file (Ctrl+Down)'), () => fileNav.onNextFile());
            files.appendChild(prev);
            if (Number.isInteger(fileNav.count) && fileNav.count > 0 && fileNav.index >= 0) {
                files.appendChild(el('span', 'diff-nav-label', t('File {i} / {n}', { i: fileNav.index + 1, n: fileNav.count })));
                prev.disabled = fileNav.index === 0;
                next.disabled = fileNav.index >= fileNav.count - 1;
            }
            files.appendChild(next);
            actions.appendChild(files);
        }

        this.summaryEl = el('div', 'diff-summary');
        actions.appendChild(this.summaryEl);

        const nav = el('div', 'diff-nav');
        nav.appendChild(this._button('↑', t('Previous change (Alt+Up)'), () => this.navigate(-1)));
        this.navLabel = el('span', 'diff-nav-label');
        nav.appendChild(this.navLabel);
        nav.appendChild(this._button('↓', t('Next change (Alt+Down)'), () => this.navigate(1)));
        actions.appendChild(nav);

        const inlineNav = el('div', 'diff-nav');
        inlineNav.appendChild(this._button('‹', t('Previous inline change (Alt+Left)'), () => this.navigateInline(-1)));
        this.inlineLabel = el('span', 'diff-nav-label');
        inlineNav.appendChild(this.inlineLabel);
        inlineNav.appendChild(this._button('›', t('Next inline change (Alt+Right)'), () => this.navigateInline(1)));
        actions.appendChild(inlineNav);

        // Bulk copies, only toward a side that can take them.
        this.copyAllLeftBtn = this._button(`⇐ ${t('Copy all')}`, t('Copy all changes to the left'),
            () => this.copyAll('left'));
        this.copyAllRightBtn = this._button(`${t('Copy all')} ⇒`, t('Copy all changes to the right'),
            () => this.copyAll('right'));
        actions.appendChild(this.copyAllLeftBtn);
        actions.appendChild(this.copyAllRightBtn);

        // When the match goes wrong: say which two lines belong together.
        const sync = el('div', 'diff-nav');
        this.syncBtn = this._button(t('Sync lines'),
            t('Line up the cursor lines of both sides — put the cursor on a line on each side first (Alt+S)'),
            () => this.toggleSyncPoint(), 'diff-btn diff-sync-btn');
        this.syncBtn.appendChild(el('span', 'diff-btn-key', 'Alt+S'));
        sync.appendChild(this.syncBtn);
        this.clearSyncBtn = this._button('', t('Remove every sync point'), () => this.clearSyncPoints(),
            'diff-btn diff-sync-clear');
        sync.appendChild(this.clearSyncBtn);
        actions.appendChild(sync);

        for (const extra of this.options.extraActions || []) {
            actions.appendChild(this._button(extra.label, extra.title || '', extra.onClick));
        }

        this.ignoreWsBtn = this._button(t('Ignore whitespace'),
            t('Ignore whitespace differences (indentation, trailing spaces, run length) — Alt+I'),
            () => this.toggleIgnoreWhitespace(), 'diff-btn diff-ws-btn');
        this.ignoreWsBtn.appendChild(el('span', 'diff-btn-key', 'Alt+I'));
        this.ignoreWsBtn.classList.toggle('active', this.ignoreWhitespace);
        actions.appendChild(this.ignoreWsBtn);

        this.showWsBtn = this._button(t('Show whitespace'),
            t('Show whitespace characters (spaces / tabs) — Alt+W'),
            () => this.toggleShowWhitespace(), 'diff-btn diff-ws-view-btn');
        this.showWsBtn.appendChild(el('span', 'diff-btn-key', 'Alt+W'));
        this.showWsBtn.classList.toggle('active', this.showWhitespace);
        actions.appendChild(this.showWsBtn);

        this.detailsBtn = this._button(t('Line details'),
            t('Show the cursor line and its counterpart one above the other, wrapped — for long lines (Alt+D)'),
            () => this.toggleDetails(), 'diff-btn diff-details-btn');
        this.detailsBtn.appendChild(el('span', 'diff-btn-key', 'Alt+D'));
        this.detailsBtn.classList.toggle('active', this.showDetails);
        actions.appendChild(this.detailsBtn);

        this.viewToggleBtn = this._button('', '', () => this.toggleViewMode());
        actions.appendChild(this.viewToggleBtn);

        // A tab with nothing it could ever write has no Save button at all.
        const saveable = ['left', 'right'].some((k) => this.merge[k].writable && !this.merge[k].live);
        if (saveable) {
            this.saveBtn = this._button(t('Save'), 'Ctrl+S', () => this._save(), 'diff-primary-btn');
            actions.appendChild(this.saveBtn);
        }

        bar.appendChild(actions);
        return bar;
    }

    _renderHeaders() {
        const h = this.headersEl;
        h.innerHTML = '';
        const header = (key) => {
            const side = this.merge[key];
            const box = el('div', `merge-header merge-header-${key}`);
            const label = el('span', 'merge-header-label', side.label);
            label.title = side.label;
            box.appendChild(label);
            box.appendChild(el('span', `merge-badge ${side.writable ? 'is-writable' : 'is-readonly'}`,
                side.writable ? t('Editable') : t('Read-only')));
            if (sideDirty(side)) box.appendChild(el('span', 'merge-badge is-unsaved', t('Unsaved')));
            return box;
        };

        if (this.viewMode === 'unified') {
            const box = el('div', 'merge-header');
            box.appendChild(el('span', 'merge-header-label',
                `${this.merge.left.label}  →  ${this.merge.right.label}`));
            box.appendChild(el('span', 'merge-note',
                t('Unified view is read-only. Switch to side-by-side view to edit.')));
            h.appendChild(box);
            return;
        }
        h.appendChild(header('left'));
        if (this._hasCopyControls()) h.appendChild(el('div', 'merge-header-gap'));
        h.appendChild(header('right'));
    }

    _hasCopyControls() {
        return canCopyToward(this.merge, 'left') || canCopyToward(this.merge, 'right');
    }

    // ── Editors ──────────────────────────────────────────────────────────────

    _commonExtensions(writable) {
        const lang = languageExtensionFor(this.merge.path);
        return [
            lineNumbers(),
            highlightSpecialChars(),
            drawSelection(),
            highlightActiveLine(),
            history(),
            // pageMotionKeymap first: it replaces defaultKeymap's PageUp / PageDown,
            // which put the caret in the wrong column on an unrendered line.
            keymap.of([...pageMotionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
            lang || [],
            this.syntaxCompartment.of(syntaxExtensionForTheme()),
            this.whitespaceCompartment.of(this.showWhitespace ? highlightWhitespace() : []),
            EditorState.readOnly.of(!writable),
            focusField,
            mergeTheme,
        ];
    }

    /** React to an editor update: edits, cursor moves, layout changes. */
    _onEditorUpdate(u, key) {
        if (u.focusChanged && u.view.hasFocus) this._lastFocused = u.view;
        if (u.selectionSet && !u.transactions.some((tr) => tr.isUserEvent(OWN_SELECTION))) {
            // The user moved on; the word-level highlight follows the cursor now.
            this._inline = null;
        }
        if (u.docChanged && key) this._sideChanged(key, u.state.doc.toString());
        else if (u.selectionSet || u.docChanged) this._queueRefresh();
        if (u.geometryChanged || u.viewportChanged) this._scheduleControlLayout();
    }

    _sideExtensions(key) {
        const side = this.merge[key];
        return [
            ...this._commonExtensions(side.writable),
            layoutField,
            syncField,
            EditorView.updateListener.of((u) => this._onEditorUpdate(u, key)),
        ];
    }

    _diffConfig() {
        const size = this.merge.left.text.length + this.merge.right.text.length;
        if (size > OWN_DIFF_LIMIT) return { scanLimit: 500, timeout: 2000 };
        return { buildChunks: (a, b, edit) => this._buildChunks(a, b, edit) };
    }

    /**
     * Every chunk, from scratch, for documents `a` and `b` (Text). `edit` is
     * the change that produced them, on side 'a' or 'b', which the sync points
     * follow — each stays on the start of its line.
     */
    _buildChunks(a, b, edit) {
        const anchors = this.merge.anchors;
        if (edit && anchors.length && !this._rediffing) {
            const doc = edit.side === 'a' ? a : b;
            for (const p of anchors) {
                const pos = edit.changes.mapPos(p[edit.side], -1);
                p[edit.side] = doc.lineAt(Math.min(pos, doc.length)).from;
            }
        }
        const lines = anchors.map((p) => [
            a.lineAt(Math.min(p.a, a.length)).number - 1,
            b.lineAt(Math.min(p.b, b.length)).number - 1,
        ]);
        const chunks = computeDiff(a.toString(), b.toString(), { ignoreWhitespace: this.ignoreWhitespace, anchors: lines })
            .map(toChunk);
        // Only the side-by-side view lines up two panes and needs the
        // whitespace-only chunks; the unified view would show them as changes.
        return this.viewMode === 'unified' ? chunks.filter(isShown) : chunks;
    }

    _mergeConfig() {
        const controls = this._hasCopyControls();
        return {
            orientation: 'a-b',
            highlightChanges: true,
            gutter: true,
            collapseUnchanged: COLLAPSE,
            diffConfig: this._diffConfig(),
            // The package only knows one direction per view. It is asked for its
            // gap column; the buttons inside are ours (see _onControlsMouseDown).
            revertControls: controls ? 'b-to-a' : undefined,
            renderRevertControl: controls ? () => this._renderCopyControl() : undefined,
        };
    }

    /**
     * One band's controls. The package renders them before saying which chunk
     * they belong to, so the kind-specific parts (titles, the merge button)
     * are filled in by _layoutCopyControls.
     */
    _renderCopyControl() {
        const box = el('div', 'merge-copy-control');
        if (canCopyToward(this.merge, 'left')) {
            const b = el('button', 'merge-copy-btn', '←');
            b.dataset.toward = 'left';
            b.title = t('Copy this change to the left (Alt+Shift+Left)');
            box.appendChild(b);
        }
        // A conflict has more answers than either arrow: keep both, in order.
        const pick = el('button', 'merge-pick-btn', '⋯');
        pick.title = t('Choose how to merge this conflict (Alt+M)');
        pick.hidden = true;
        box.appendChild(pick);
        if (canCopyToward(this.merge, 'right')) {
            const b = el('button', 'merge-copy-btn', '→');
            b.dataset.toward = 'right';
            b.title = t('Copy this change to the right (Alt+Shift+Right)');
            box.appendChild(b);
        }
        return box;
    }

    /** What an arrow does to a change of this kind, in words. */
    _copyTitle(kind, toward) {
        if (toward === 'left') {
            if (kind === 'left') return t('Remove these lines from the left (Alt+Shift+Left)');
            if (kind === 'right') return t('Add these lines to the left (Alt+Shift+Left)');
            return t('Replace the left with the right version (Alt+Shift+Left)');
        }
        if (kind === 'left') return t('Add these lines to the right (Alt+Shift+Right)');
        if (kind === 'right') return t('Remove these lines from the right (Alt+Shift+Right)');
        return t('Replace the right with the left version (Alt+Shift+Right)');
    }

    _mountEditors() {
        const scrollTop = this.file._mergeScrollTop || 0;
        this._destroyEditors();
        // New panes start at the left edge; the shared bar follows them.
        this._hLeft = 0;
        this.hscrollEl.hidden = true;
        this.container.classList.toggle('merge-no-controls',
            this.viewMode === 'unified' || !this._hasCopyControls());

        if (this.viewMode === 'unified') {
            const host = el('div', 'merge-unified');
            this.bodyEl.insertBefore(host, this.minimapEl);
            this.unifiedView = new EditorView({
                parent: host,
                state: EditorState.create({
                    doc: this.merge.right.text,
                    extensions: [
                        ...this._commonExtensions(false),
                        EditorView.editorAttributes.of({ class: 'cm-merge-b' }),
                        unifiedMergeView({
                            original: this.merge.left.text,
                            mergeControls: false,
                            highlightChanges: true,
                            gutter: true,
                            collapseUnchanged: COLLAPSE,
                            diffConfig: this._diffConfig(),
                        }),
                        unifiedLayoutField,
                        EditorView.updateListener.of((u) => this._onEditorUpdate(u, null)),
                    ],
                }),
            });
            this.unifiedView.scrollDOM.addEventListener('scroll', () => this._updateMinimapViewport());
        } else {
            this.mergeView = new MergeView({
                a: { doc: this.merge.left.text, extensions: this._sideExtensions('left') },
                b: { doc: this.merge.right.text, extensions: this._sideExtensions('right') },
                parent: this.bodyEl,
                ...this._mergeConfig(),
            });
            const dom = this.mergeView.dom;
            this._onControlsMouseDown = (e) => {
                const btn = e.target && e.target.closest
                    ? e.target.closest('.merge-copy-btn, .merge-pick-btn') : null;
                if (!btn) return;
                // Ahead of the package's own handler, which would always revert
                // in its single configured direction.
                e.preventDefault();
                e.stopPropagation();
                const box = btn.closest('.merge-copy-control');
                const index = Number(box && box.dataset.chunk);
                if (btn.classList.contains('merge-pick-btn')) this.openMergeMenu(index, btn);
                else this.copyChunk(index, btn.dataset.toward);
            };
            this._onControlsOver = (e) => {
                const box = e.target && e.target.closest ? e.target.closest('.merge-copy-control') : null;
                this._setHoverChunk(box ? Number(box.dataset.chunk) : null);
            };
            this._onControlsLeave = () => this._setHoverChunk(null);
            dom.addEventListener('mousedown', this._onControlsMouseDown, true);
            dom.addEventListener('mouseover', this._onControlsOver);
            dom.addEventListener('mouseleave', this._onControlsLeave);
            dom.addEventListener('scroll', () => this._updateMinimapViewport());
            // Sideways, the two panes move together (as in WinMerge), whether
            // by the bar, Shift+wheel, a trackpad or the cursor moving.
            for (const view of [this.mergeView.a, this.mergeView.b]) {
                view.scrollDOM.addEventListener('scroll', () => this._onHScroll(view.scrollDOM));
            }
            if (typeof ResizeObserver === 'function') {
                this._resizeObserver = new ResizeObserver(() => this._scheduleControlLayout());
                this._resizeObserver.observe(dom);
            }

            // The outline round the current change, one per side, drawn over
            // the scrolled content so it moves with it.
            this._focusFrames = ['left', 'right'].map((key) => {
                const frame = el('div', `merge-focus-frame merge-focus-frame-${key}`);
                frame.hidden = true;
                dom.appendChild(frame);
                return frame;
            });

            // The package redraws its controls as chunks change or scroll into
            // view; each redraw needs our band sizing again.
            const column = dom.querySelector('.cm-merge-revert');
            if (column && typeof MutationObserver === 'function') {
                this._controlsObserver = new MutationObserver(() => this._scheduleControlLayout());
                this._controlsObserver.observe(column, { childList: true });
            }
        }

        this.viewToggleBtn.textContent = this.viewMode === 'unified' ? t('Side-by-side view') : t('Unified view');
        const split = this.viewMode === 'split';
        this.copyAllLeftBtn.hidden = !split || !canCopyToward(this.merge, 'left');
        this.copyAllRightBtn.hidden = !split || !canCopyToward(this.merge, 'right');
        // Two cursors are needed to say which lines belong together.
        this.syncBtn.disabled = !split;

        this._appliedFocusKey = '';
        this._appliedSyncKey = '';
        this._renderHeaders();
        this._refresh();
        if (scrollTop) {
            setTimeout(() => {
                const s = this._scroller();
                if (s) s.scrollTop = scrollTop;
            }, 0);
        }
    }

    _destroyEditors() {
        this.closeMergeMenu();
        const s = this._scroller();
        if (s) this.file._mergeScrollTop = s.scrollTop;
        if (this._controlsObserver) {
            this._controlsObserver.disconnect();
            this._controlsObserver = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this.mergeView) {
            const dom = this.mergeView.dom;
            dom.removeEventListener('mousedown', this._onControlsMouseDown, true);
            dom.removeEventListener('mouseover', this._onControlsOver);
            dom.removeEventListener('mouseleave', this._onControlsLeave);
            this.mergeView.destroy();
            dom.remove();
            this.mergeView = null;
        }
        if (this.unifiedView) {
            const host = this.unifiedView.dom.parentNode;
            this.unifiedView.destroy();
            if (host) host.remove();
            this.unifiedView = null;
        }
        this._lastFocused = null;
        this._inline = null;
        this._hoverChunk = null;
        this._focusFrames = null;
    }

    _forEachEditor(fn) {
        if (this.mergeView) { fn(this.mergeView.a); fn(this.mergeView.b); }
        if (this.unifiedView) fn(this.unifiedView);
    }

    _scroller() {
        if (this.mergeView) return this.mergeView.dom;
        if (this.unifiedView) return this.unifiedView.scrollDOM;
        return null;
    }

    _sideChanged(key, text) {
        const side = this.merge[key];
        side.text = text;
        if (side.live && typeof side.onLive === 'function') side.onLive(text);
        const dirty = mergeDirty(this.merge);
        if (this.file.isDirty !== dirty) {
            this.file.isDirty = dirty;
            if (typeof this.options.onDirtyChange === 'function') this.options.onDirtyChange();
        }
        this._queueRefresh();
    }

    // ── State shown in the chrome ────────────────────────────────────────────

    _queueRefresh() {
        if (this._refreshTimer) return;
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            this._refresh();
        }, 0);
    }

    /** Redraw everything derived from the texts (also called after a save). */
    refreshState() {
        this._refresh();
    }

    _chunks() {
        if (this.mergeView) return this.mergeView.chunks;
        if (this.unifiedView) {
            const found = getChunks(this.unifiedView.state);
            return found ? found.chunks : [];
        }
        return [];
    }

    _docs() {
        if (this.mergeView) return { a: this.mergeView.a.state.doc, b: this.mergeView.b.state.doc };
        if (this.unifiedView) return { a: getOriginalDoc(this.unifiedView.state), b: this.unifiedView.state.doc };
        return null;
    }

    _refresh() {
        const all = this._chunks();
        // Whitespace-only chunks exist for the alignment, not as changes.
        const chunks = all.filter(isShown);
        const docs = this._docs();

        this.summaryEl.textContent = '';
        if (!chunks.length) {
            this.summaryEl.appendChild(el('span', 'diff-sum-none', t('No differences')));
            this.summaryEl.title = '';
        } else if (docs) {
            let left = 0;
            let right = 0;
            const kinds = { left: 0, right: 0, both: 0 };
            for (const ch of chunks) {
                left += linesIn(docs.a, ch.fromA, ch.toA);
                right += linesIn(docs.b, ch.fromB, ch.toB);
                kinds[chunkKind(ch)]++;
            }
            // Doubles as the legend for the three colours.
            const chip = (kind, label, tip) => {
                if (!kinds[kind]) return;
                const c = el('span', `diff-sum-kind is-${kind}`, `${label} ${kinds[kind]}`);
                c.title = tip;
                this.summaryEl.appendChild(c);
            };
            chip('left', t('Left only'), t('Changes whose lines exist on the left only'));
            chip('right', t('Right only'), t('Changes whose lines exist on the right only'));
            chip('both', t('Conflict'), t('Changes where both sides have their own lines — choose which to keep'));
            this.summaryEl.appendChild(el('span', 'diff-sum-blocks', t('{n} changes', { n: chunks.length })));
            this.summaryEl.title = t('{left} changed lines on the left, {right} on the right', { left, right });
        }

        const at = this._chunkAtCursor();
        const rank = at.inside >= 0 ? chunks.indexOf(all[at.inside]) : -1;
        this.navLabel.textContent = chunks.length
            ? t('Change {n} of {total}', { n: rank >= 0 ? rank + 1 : '–', total: chunks.length })
            : '';

        const inChunk = at.inside >= 0 ? this._inlineTargets().filter((tg) => tg.chunk === at.inside) : [];
        const inlinePos = this._inline && inChunk.findIndex((tg) => this._sameTarget(tg, this._inline));
        this.inlineLabel.textContent = inChunk.length
            ? t('Inline {n} of {total}', { n: inlinePos >= 0 ? inlinePos + 1 : '–', total: inChunk.length })
            : '';

        const dirty = mergeDirty(this.merge);
        if (this.saveBtn) this.saveBtn.disabled = !dirty;
        if (this.copyAllLeftBtn) this.copyAllLeftBtn.disabled = !chunks.length;
        if (this.copyAllRightBtn) this.copyAllRightBtn.disabled = !chunks.length;
        const syncs = this.merge.anchors.length;
        this.clearSyncBtn.hidden = !syncs;
        this.clearSyncBtn.textContent = t('Clear sync points ({n})', { n: syncs });
        this._renderHeaders();
        this._applySyncLines();
        this._applyFocus();
        this._buildMinimap();
        this._renderDetails();
        this._scheduleControlLayout();
    }

    // ── Current change: outline and copy band ────────────────────────────────

    _setHoverChunk(index) {
        const next = Number.isInteger(index) && index >= 0 ? index : null;
        if (next === this._hoverChunk) return;
        this._hoverChunk = next;
        this._applyFocus();
        this._layoutCopyControls();
    }

    /** Outline the change being worked on (hovered band first, else the cursor's). */
    _applyFocus() {
        const chunks = this._chunks();
        let index = -1;
        if (this._hoverChunk != null && chunks[this._hoverChunk]) index = this._hoverChunk;
        else index = this._chunkAtCursor().inside;
        const chunk = index >= 0 ? chunks[index] : null;
        const inline = chunk && this._inline && this._inline.chunk === index ? this._inline : null;

        const key = chunk
            ? [index, chunk.fromA, chunk.toA, chunk.fromB, chunk.toB,
                inline ? `${inline.fromA}:${inline.toA}:${inline.fromB}:${inline.toB}` : ''].join('|')
            : '';
        this._focusIndex = index;
        if (key === this._appliedFocusKey) return;
        this._appliedFocusKey = key;

        const lines = !this.mergeView;
        const sideFocus = (from, to, inlineFrom, inlineTo) => (chunk ? { from, to, inlineFrom, inlineTo, lines } : null);
        if (this.mergeView) {
            this.mergeView.a.dispatch({ effects: setFocus.of(sideFocus(
                chunk && chunk.fromA, chunk && chunk.toA, inline && inline.fromA, inline && inline.toA)) });
            this.mergeView.b.dispatch({ effects: setFocus.of(sideFocus(
                chunk && chunk.fromB, chunk && chunk.toB, inline && inline.fromB, inline && inline.toB)) });
        } else if (this.unifiedView) {
            this.unifiedView.dispatch({ effects: setFocus.of(sideFocus(
                chunk && chunk.fromB, chunk && chunk.toB, inline && inline.fromB, inline && inline.toB)) });
        }
        this._layoutFocusFrames();
    }

    _scheduleControlLayout() {
        if (this._layoutFrame || !this.mergeView) return;
        const run = () => {
            this._layoutFrame = null;
            this._layoutCopyControls();
            this._layoutHScroll();
        };
        this._layoutFrame = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(run)
            : setTimeout(run, 16);
    }

    // ── Sideways scrolling ───────────────────────────────────────────────────

    _hScrollers() {
        const mv = this.mergeView;
        return mv ? [mv.a.scrollDOM, mv.b.scrollDOM] : [];
    }

    /** Show the shared bar when either pane is wider than it is, sized to the wider one. */
    _layoutHScroll() {
        const bar = this.hscrollEl;
        if (!bar) return;
        const scrollers = this._hScrollers();
        const overflow = scrollers.length
            ? Math.max(...scrollers.map((s) => s.scrollWidth - s.clientWidth))
            : 0;
        bar.hidden = !(overflow > 1);
        if (bar.hidden) return;
        this.hscrollInner.style.width = `${bar.clientWidth + overflow}px`;
        if (Math.abs(bar.scrollLeft - this._hLeft) > 1) bar.scrollLeft = this._hLeft;
    }

    /**
     * One of the bar or the panes scrolled sideways: bring the others along.
     * Setting scrollLeft fires their scroll events later; a pane that is
     * narrower stops short of the position asked, so an event that only
     * reports that is an echo, not the user, and is not passed on.
     */
    _onHScroll(source) {
        const max = (el) => Math.max(0, el.scrollWidth - el.clientWidth);
        const expected = Math.min(this._hLeft, max(source));
        if (Math.abs(source.scrollLeft - expected) <= 1) return;
        this._hLeft = source.scrollLeft;
        for (const el of [...this._hScrollers(), this.hscrollEl]) {
            if (el === source || !el || el.hidden) continue;
            const want = Math.min(this._hLeft, max(el));
            if (Math.abs(el.scrollLeft - want) > 1) el.scrollLeft = want;
        }
    }

    /** Vertical extent of a chunk, in the aligned coordinates both editors share. */
    _chunkSpan(chunk) {
        const mv = this.mergeView;
        const side = (ed, from, to) => {
            const { doc } = ed.state;
            const at = Math.min(from, doc.length);
            const block = ed.lineBlockAt(at);
            if (to <= from) {
                // Lines added after a last line with no line break: the gap
                // is under that line, not over it.
                const below = at === doc.length && doc.lineAt(at).from < at;
                const y = below ? block.bottom : block.top;
                return { top: y, bottom: y, raw: block.top };
            }
            return { top: block.top, bottom: ed.lineBlockAt(doc.line(lastLineOf(doc, from, to)).from).bottom, raw: block.top };
        };
        const a = side(mv.a, chunk.fromA, chunk.toA);
        const b = side(mv.b, chunk.fromB, chunk.toB);
        // `anchor` is where the package put the band: the chunk's first line on the left.
        return { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), anchor: a.raw };
    }

    /**
     * Stretch each copy control into a band as tall as its change. The package
     * positions the control at the chunk's first line on the left and resets
     * `top` whenever it re-measures, so the band is offset with a margin
     * instead of moving `top` itself.
     */
    _layoutCopyControls() {
        const mv = this.mergeView;
        if (!mv) return;
        const chunks = mv.chunks;
        for (const box of mv.dom.querySelectorAll('.merge-copy-control')) {
            const index = Number(box.dataset.chunk);
            const chunk = chunks[index];
            if (!chunk) continue;
            const span = this._chunkSpan(chunk);
            box.style.marginTop = `${span.top - span.anchor}px`;
            box.style.height = `${Math.max(28, span.bottom - span.top)}px`;
            box.classList.toggle('is-current', index === this._focusIndex);
            const kind = chunkKind(chunk);
            if (box.dataset.kind !== kind) {
                box.dataset.kind = kind;
                for (const b of box.querySelectorAll('.merge-copy-btn')) b.title = this._copyTitle(kind, b.dataset.toward);
                const pick = box.querySelector('.merge-pick-btn');
                if (pick) pick.hidden = kind !== 'both';
            }
        }
        this._layoutFocusFrames();
    }

    /**
     * Frame the current change on both sides. Both frames span the change's
     * full aligned height, so the side without lines is framed round its
     * spacer, the same size as the other side and the copy band between them.
     */
    _layoutFocusFrames() {
        const mv = this.mergeView;
        const frames = this._focusFrames;
        if (!mv || !frames) return;
        const chunk = this._focusIndex >= 0 ? mv.chunks[this._focusIndex] : null;
        if (!chunk) {
            frames.forEach((frame) => { frame.hidden = true; });
            return;
        }
        const span = this._chunkSpan(chunk);
        const host = mv.dom.getBoundingClientRect();
        // Both editors start at the same height inside the scrolled content.
        const docTop = mv.a.documentTop - host.top + mv.dom.scrollTop;
        const height = Math.max(8, span.bottom - span.top);
        [mv.a, mv.b].forEach((ed, i) => {
            const frame = frames[i];
            const pane = (ed.dom.parentNode || ed.dom).getBoundingClientRect();
            const gutters = ed.dom.querySelector('.cm-gutters');
            const gutterWidth = gutters ? gutters.getBoundingClientRect().width : 0;
            frame.hidden = false;
            frame.style.top = `${docTop + span.top}px`;
            frame.style.height = `${height}px`;
            frame.style.left = `${pane.left - host.left + mv.dom.scrollLeft + gutterWidth}px`;
            frame.style.width = `${Math.max(0, pane.width - gutterWidth - 4)}px`;
        });
    }

    // ── Navigation and copying ───────────────────────────────────────────────

    _activeEditor() {
        if (this.unifiedView) return this.unifiedView;
        const mv = this.mergeView;
        if (!mv) return null;
        if (mv.a.hasFocus) return mv.a;
        if (mv.b.hasFocus) return mv.b;
        if (this._lastFocused === mv.a || this._lastFocused === mv.b) return this._lastFocused;
        if (this.merge.right.writable || !this.merge.left.writable) return mv.b;
        return mv.a;
    }

    /** The chunk under the cursor (`inside`), and the first one after it (`next`). */
    _chunkAtCursor() {
        const ed = this._activeEditor();
        const chunks = this._chunks();
        const result = { inside: -1, next: -1 };
        if (!ed || !chunks.length) return result;
        const isA = this.mergeView ? ed === this.mergeView.a : false;
        const pos = ed.state.selection.main.head;
        for (let i = 0; i < chunks.length; i++) {
            if (!isShown(chunks[i])) continue;
            const from = isA ? chunks[i].fromA : chunks[i].fromB;
            const to = isA ? chunks[i].toA : chunks[i].toB;
            if (pos >= from && pos <= Math.max(from, to - 1)) { result.inside = i; break; }
            if (pos < from) { result.next = i; break; }
        }
        return result;
    }

    /**
     * Move the cursor to the previous / next change, wrapping at either end.
     * Not the package's goToNextChunk: that would stop on whitespace-only
     * chunks, which are not changes.
     */
    navigate(direction) {
        const ed = this._activeEditor();
        if (!ed) return;
        const chunks = this._chunks();
        const isA = !!this.mergeView && ed === this.mergeView.a;
        const fromOf = (ch) => Math.min(isA ? ch.fromA : ch.fromB, ed.state.doc.length);
        const shown = chunks.filter(isShown);
        if (!shown.length) return;
        const head = ed.state.selection.main.head;
        const inside = this._chunkAtCursor().inside;
        let target;
        if (direction > 0) {
            target = shown.find((ch) => fromOf(ch) > head && ch !== chunks[inside]) || shown[0];
        } else {
            for (let k = shown.length - 1; k >= 0; k--) {
                if (fromOf(shown[k]) < head && shown[k] !== chunks[inside]) { target = shown[k]; break; }
            }
            if (!target) target = shown[shown.length - 1];
        }
        const pos = fromOf(target);
        ed.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: 'center' }),
            userEvent: 'select.byChunk',
        });
        this._inline = null;
        ed.focus();
        this._queueRefresh();
    }

    /**
     * Every word-level change, in document order, with positions on both
     * sides: the words changed inside paired lines, and each run of lines with
     * no partner as one step — never including the line break after it, which
     * put the cursor on the next line.
     */
    _inlineTargets() {
        const out = [];
        this._chunks().forEach((ch, i) => {
            if (!isShown(ch)) return;
            const parts = [...(ch.changes || []), ...(ch.runs || [])]
                .sort((x, y) => x.fromA - y.fromA || x.fromB - y.fromB);
            if (parts.length) {
                for (const c of parts) {
                    out.push({
                        chunk: i,
                        fromA: ch.fromA + c.fromA, toA: ch.fromA + c.toA,
                        fromB: ch.fromB + c.fromB, toB: ch.fromB + c.toB,
                    });
                }
            } else {
                out.push({ chunk: i, fromA: ch.fromA, toA: ch.endA, fromB: ch.fromB, toB: ch.endB });
            }
        });
        return out;
    }

    _sameTarget(x, y) {
        return !!x && !!y && x.fromA === y.fromA && x.toA === y.toA && x.fromB === y.fromB && x.toB === y.toB;
    }

    /**
     * Move to the previous / next word-level change (Alt+← / Alt+→), across
     * change boundaries and wrapping at either end. Selects it on both sides.
     */
    navigateInline(direction) {
        const targets = this._inlineTargets();
        const ed = this._activeEditor();
        if (!targets.length || !ed) return false;
        const isA = !!this.mergeView && ed === this.mergeView.a;
        const fromOf = (tg) => (isA ? tg.fromA : tg.fromB);
        const n = targets.length;

        let index = this._inline ? targets.findIndex((tg) => this._sameTarget(tg, this._inline)) : -1;
        if (index >= 0) {
            index = (((index + direction) % n) + n) % n;
        } else {
            const head = ed.state.selection.main.head;
            if (direction > 0) {
                index = targets.findIndex((tg) => fromOf(tg) >= head);
                if (index < 0) index = 0;
            } else {
                index = -1;
                for (let i = n - 1; i >= 0; i--) {
                    if (fromOf(targets[i]) < head) { index = i; break; }
                }
                if (index < 0) index = n - 1;
            }
        }

        const target = targets[index];
        this._inline = target;
        const pairs = this.mergeView
            ? [[this.mergeView.a, target.fromA, target.toA], [this.mergeView.b, target.fromB, target.toB]]
            : [[this.unifiedView, target.fromB, target.toB]];
        for (const [view, from, to] of pairs) {
            const len = view.state.doc.length;
            const anchor = Math.min(from, len);
            const head = Math.min(Math.max(from, to), len);
            view.dispatch({
                selection: { anchor, head },
                effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
                userEvent: OWN_SELECTION,
            });
        }
        ed.focus();
        this._queueRefresh();
        return true;
    }

    /**
     * Copy chunk `index` into the side `toward` points at. Refused when that
     * side is read-only. Returns whether anything was copied.
     */
    copyChunk(index, toward) {
        const mv = this.mergeView;
        const chunk = mv && mv.chunks[index];
        if (!chunk || !canCopyToward(this.merge, toward)) return false;
        const toLeft = toward === 'left';
        const src = toLeft ? mv.b : mv.a;
        const dest = toLeft ? mv.a : mv.b;
        const edit = toLeft
            ? blockCopyEdit(src.state.doc.toString(), dest.state.doc.toString(), chunk.fromB, chunk.toB, chunk.fromA, chunk.toA)
            : blockCopyEdit(src.state.doc.toString(), dest.state.doc.toString(), chunk.fromA, chunk.toA, chunk.fromB, chunk.toB);
        dest.dispatch({ changes: edit, userEvent: 'input.copy' });
        this._hoverChunk = null;
        return true;
    }

    /** Copy the change under (or just after) the cursor. */
    copyAtCursor(toward) {
        const index = this._currentChunkIndex();
        return index >= 0 ? this.copyChunk(index, toward) : false;
    }

    /** Copy every change toward one side, as a single undoable edit. */
    copyAll(toward) {
        const mv = this.mergeView;
        // Whitespace-only chunks stay as they are: whitespace is being ignored.
        const chunks = mv ? mv.chunks.filter(isShown) : [];
        if (!chunks.length || !canCopyToward(this.merge, toward)) return false;
        const toLeft = toward === 'left';
        const src = (toLeft ? mv.b : mv.a).state.doc.toString();
        const destView = toLeft ? mv.a : mv.b;
        const dest = destView.state.doc.toString();
        const changes = chunks.map((ch) => (toLeft
            ? blockCopyEdit(src, dest, ch.fromB, ch.toB, ch.fromA, ch.toA)
            : blockCopyEdit(src, dest, ch.fromA, ch.toA, ch.fromB, ch.toB)));
        destView.dispatch({ changes, userEvent: 'input.copy' });
        return true;
    }

    /**
     * Keep both versions of chunk `index` in the side `toward` points at, the
     * left side's lines first or the right side's (`order`: 'left-first' |
     * 'right-first'). The combined block is selected in that side, ready to be
     * edited into its final form.
     */
    combineChunk(index, toward, order = 'left-first') {
        const mv = this.mergeView;
        const chunk = mv && mv.chunks[index];
        if (!chunk || !canCopyToward(this.merge, toward)) return false;
        const toLeft = toward === 'left';
        const srcView = toLeft ? mv.b : mv.a;
        const dest = toLeft ? mv.a : mv.b;
        // The source is the right side when merging into the left.
        const srcFirst = toLeft ? order === 'right-first' : order === 'left-first';
        const src = srcView.state.doc.toString();
        const text = dest.state.doc.toString();
        const edit = toLeft
            ? blockCombineEdit(src, text, chunk.fromB, chunk.toB, chunk.fromA, chunk.toA, srcFirst)
            : blockCombineEdit(src, text, chunk.fromA, chunk.toA, chunk.fromB, chunk.toB, srcFirst);
        dest.dispatch({
            changes: { from: edit.from, to: edit.to, insert: edit.insert },
            selection: { anchor: edit.select.from, head: edit.select.to },
            effects: EditorView.scrollIntoView(edit.select.from, { y: 'center' }),
            userEvent: 'input.copy',
        });
        this._hoverChunk = null;
        dest.focus();
        return true;
    }

    // ── Choosing how to merge a conflict ─────────────────────────────────────

    /** The chunk the cursor is in, or the next one after it. */
    _currentChunkIndex() {
        const at = this._chunkAtCursor();
        return at.inside >= 0 ? at.inside : at.next;
    }

    /**
     * Offer every way to settle chunk `index`, for each side that can be
     * written: take the other side's version, or keep both in either order.
     */
    openMergeMenu(index, anchorEl = null) {
        const mv = this.mergeView;
        const chunk = mv && mv.chunks[index];
        this.closeMergeMenu();
        if (!chunk) return false;
        const kind = chunkKind(chunk);
        const menu = el('div', 'merge-menu');
        menu.setAttribute('role', 'menu');
        const items = [];
        const item = (label, run) => {
            const b = el('button', 'merge-menu-item', label);
            b.setAttribute('role', 'menuitem');
            b.addEventListener('click', () => {
                this.closeMergeMenu();
                run();
            });
            menu.appendChild(b);
            items.push(b);
        };
        for (const toward of ['left', 'right']) {
            if (!canCopyToward(this.merge, toward)) continue;
            menu.appendChild(el('div', 'merge-menu-heading',
                toward === 'left' ? t('Result on the left') : t('Result on the right')));
            item(toward === 'left' ? t('Use the right version') : t('Use the left version'),
                () => this.copyChunk(index, toward));
            if (kind === 'both') {
                item(t('Keep both: left, then right'), () => this.combineChunk(index, toward, 'left-first'));
                item(t('Keep both: right, then left'), () => this.combineChunk(index, toward, 'right-first'));
            }
        }
        if (!items.length) return false;
        menu.appendChild(el('div', 'merge-menu-note', t('Both sides stay editable: adjust the result by hand afterwards.')));

        menu.addEventListener('mousedown', (e) => e.stopPropagation());
        menu.addEventListener('keydown', (e) => {
            const at = items.indexOf(document.activeElement);
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeMergeMenu();
                this.focus();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                items[(at + step + items.length) % items.length].focus();
            }
            e.stopPropagation();
        });
        this.container.appendChild(menu);

        // Next to the band's button, or by the change when opened from the keys.
        const host = this.container.getBoundingClientRect();
        let x = host.left + host.width / 2;
        let y = host.top + 80;
        if (anchorEl) {
            const r = anchorEl.getBoundingClientRect();
            x = r.left;
            y = r.bottom + 4;
        } else {
            const span = this._chunkSpan(chunk);
            y = mv.a.documentTop + span.top;
        }
        const w = menu.offsetWidth || 240;
        const h = menu.offsetHeight || 200;
        menu.style.left = `${Math.max(host.left + 8, Math.min(x - w / 2, host.right - w - 8))}px`;
        menu.style.top = `${Math.max(host.top + 8, Math.min(y, host.bottom - h - 8))}px`;

        this._menu = menu;
        this._onMenuOutside = (e) => {
            if (this._menu && !this._menu.contains(e.target)) this.closeMergeMenu();
        };
        document.addEventListener('mousedown', this._onMenuOutside, true);
        items[0].focus();
        return true;
    }

    closeMergeMenu() {
        if (!this._menu) return;
        this._menu.remove();
        this._menu = null;
        document.removeEventListener('mousedown', this._onMenuOutside, true);
    }

    // ── Sync points ──────────────────────────────────────────────────────────

    /**
     * Say that the cursor lines on the two sides belong together; the
     * comparison is cut there and those lines face each other. On a line pair
     * that already is a sync point, removes it. A point that would cross
     * another one replaces it.
     */
    toggleSyncPoint() {
        const mv = this.mergeView;
        if (!mv) return false;
        const a = mv.a.state.doc.lineAt(mv.a.state.selection.main.head).from;
        const b = mv.b.state.doc.lineAt(mv.b.state.selection.main.head).from;
        const anchors = this.merge.anchors;
        const same = anchors.findIndex((p) => p.a === a && p.b === b);
        if (same >= 0) {
            anchors.splice(same, 1);
        } else {
            const keep = anchors.filter((p) => (p.a < a && p.b < b) || (p.a > a && p.b > b));
            keep.push({ a, b });
            keep.sort((x, y) => x.a - y.a);
            anchors.splice(0, anchors.length, ...keep);
        }
        this._rediff();
        return true;
    }

    clearSyncPoints() {
        if (!this.merge.anchors.length) return;
        this.merge.anchors.splice(0);
        this._rediff();
    }

    /**
     * Recompute the comparison with the texts as they are. The merge view only
     * rediffs on an edit, so it is given one that changes nothing — kept out of
     * the undo history — instead of being rebuilt, which would lose that history.
     */
    _rediff() {
        if (!this.mergeView) {
            this._mountEditors();
            return;
        }
        const view = [this.mergeView.a, this.mergeView.b].find((v) => v.state.doc.length);
        if (view) {
            this._rediffing = true;
            try {
                view.dispatch({
                    changes: { from: 0, to: 1, insert: view.state.sliceDoc(0, 1) },
                    annotations: Transaction.addToHistory.of(false),
                });
            } finally {
                this._rediffing = false;
            }
        }
        this._queueRefresh();
    }

    _applySyncLines() {
        const anchors = this.merge.anchors;
        const key = anchors.map((p) => `${p.a}:${p.b}`).join(',');
        if (key === this._appliedSyncKey) return;
        this._appliedSyncKey = key;
        if (!this.mergeView) return;
        this.mergeView.a.dispatch({ effects: setSyncLines.of(anchors.map((p) => p.a)) });
        this.mergeView.b.dispatch({ effects: setSyncLines.of(anchors.map((p) => p.b)) });
    }

    // ── Toolbar toggles ──────────────────────────────────────────────────────

    toggleIgnoreWhitespace() {
        this.ignoreWhitespace = !this.ignoreWhitespace;
        writeFlag('diff_ignoreWhitespace', this.ignoreWhitespace);
        this.ignoreWsBtn.classList.toggle('active', this.ignoreWhitespace);
        // MergeView.reconfigure only stores a new diffConfig for the NEXT edit;
        // the changes on screen are not recomputed. Rebuilding is what applies
        // it now — and loses nothing, since the texts live on the tab.
        this._mountEditors();
    }

    toggleDetails() {
        this.showDetails = !this.showDetails;
        writeFlag('diff_showDetails', this.showDetails);
        this.detailsBtn.classList.toggle('active', this.showDetails);
        this.detailsEl.hidden = !this.showDetails;
        this._appliedDetailsKey = '';
        this._renderDetails();
        // The panes got shorter or taller.
        this._scheduleControlLayout();
    }

    /**
     * Fill the line details: the cursor line of the active side and the line
     * it faces, each wrapped in full, with the words that differ marked —
     * and, where the other side has text this one lacks, a caret where it goes.
     */
    _renderDetails() {
        const pane = this.detailsEl;
        if (!pane || !this.showDetails) return;
        const docs = this._docs();
        const ed = this._activeEditor();
        if (!docs || !ed) { pane.textContent = ''; return; }
        const side = this.mergeView && ed === this.mergeView.a ? 'a' : 'b';
        const line = ed.state.doc.lineAt(ed.state.selection.main.head).number;
        const chunks = this._chunks();
        const at = lineCounterpart(chunks, docs.a, docs.b, side, line);
        const chunk = at.chunk >= 0 ? chunks[at.chunk] : null;
        const inline = this._inline;

        // Redrawn only when something it shows changed: a document (each edit
        // makes a new one), the lines, or the word being looked at.
        const key = [side, at.a, at.b, at.chunk,
            inline ? `${inline.fromA}:${inline.toA}:${inline.fromB}:${inline.toB}` : ''].join('|');
        if (key === this._appliedDetailsKey && docs.a === this._detailsDocA && docs.b === this._detailsDocB) return;
        this._appliedDetailsKey = key;
        this._detailsDocA = docs.a;
        this._detailsDocB = docs.b;

        const kind = chunk ? chunkKind(chunk) : null;
        pane.textContent = '';
        pane.dataset.kind = kind || 'same';
        if (!chunk) pane.appendChild(el('div', 'merge-details-note', t('This line is the same on both sides.')));
        else if (kind === 'ws') pane.appendChild(el('div', 'merge-details-note', t('Only whitespace differs here, and whitespace is being ignored.')));

        for (const s of ['a', 'b']) {
            const doc = docs[s];
            const n = at[s];
            const row = el('div', `merge-details-row is-${s === 'a' ? 'left' : 'right'}${s === side ? ' is-cursor' : ''}`);
            const label = s === 'a' ? t('Left') : t('Right');
            row.appendChild(el('span', 'merge-details-label', n ? `${label} ${n}` : label));
            const text = el('div', 'merge-details-text');
            if (!n) {
                text.classList.add('is-missing');
                text.textContent = s === 'a' ? t('No such line on the left: it exists on the right only.')
                    : t('No such line on the right: it exists on the left only.');
            } else {
                this._fillDetailsLine(text, doc.line(n), chunk, s === 'a', inline);
            }
            row.appendChild(text);
            pane.appendChild(row);
        }
    }

    /** One line's text, with its changed words and insertion points marked. */
    _fillDetailsLine(target, line, chunk, isA, inline) {
        const LIMIT = 20000;
        const marks = [];
        if (chunk && chunk.changes) {
            const base = isA ? chunk.fromA : chunk.fromB;
            for (const c of chunk.changes) {
                const from = base + (isA ? c.fromA : c.fromB);
                const to = base + (isA ? c.toA : c.toB);
                if (to < line.from || from > line.to) continue;
                // A change with nothing on this side, at this line: where the
                // other side's words go. (An empty range at the line's very end
                // belongs to it too.)
                if (from === to && (from < line.from || from > line.to)) continue;
                const current = !!inline && (isA ? inline.fromA === from && inline.toA === to : inline.fromB === from && inline.toB === to);
                marks.push({ from: Math.max(from, line.from) - line.from, to: Math.min(to, line.to) - line.from, current });
            }
        }
        const text = line.text;
        let pos = 0;
        const plain = (upto) => {
            if (upto > pos) target.appendChild(document.createTextNode(text.slice(pos, upto)));
            pos = Math.max(pos, upto);
        };
        for (const m of marks) {
            if (m.from >= LIMIT) break;
            plain(m.from);
            if (m.to > m.from) {
                const span = el('span', `merge-details-chg${m.current ? ' is-current' : ''}`, text.slice(m.from, m.to));
                target.appendChild(span);
                pos = m.to;
            } else {
                const caret = el('span', `merge-details-ins${m.current ? ' is-current' : ''}`);
                caret.title = t('Text the other side has goes here');
                target.appendChild(caret);
            }
        }
        if (text.length > LIMIT) {
            plain(LIMIT);
            target.appendChild(el('span', 'merge-details-more', t('… {n} more characters', { n: text.length - LIMIT })));
        } else {
            plain(text.length);
        }
        if (!text.length) target.appendChild(el('span', 'merge-details-empty', t('(empty line)')));
    }

    toggleShowWhitespace() {
        this.showWhitespace = !this.showWhitespace;
        writeFlag('diff_showWhitespace', this.showWhitespace);
        this.showWsBtn.classList.toggle('active', this.showWhitespace);
        this._forEachEditor((ed) => ed.dispatch({
            effects: this.whitespaceCompartment.reconfigure(this.showWhitespace ? highlightWhitespace() : []),
        }));
    }

    toggleViewMode() {
        this.viewMode = this.viewMode === 'split' ? 'unified' : 'split';
        this._mountEditors();
    }

    async _save() {
        if (typeof this.options.onSave !== 'function') return;
        await this.options.onSave();
        this._refresh();
    }

    // ── Keyboard, clipboard, history ─────────────────────────────────────────

    _onKeyDown(e) {
        if (!this.container || !this.container.isConnected || this.container.offsetParent === null) return;
        // Two comparisons can be on screen at once (split panes): only the one
        // holding focus, or any when nothing does, answers.
        const ae = document.activeElement;
        if (ae && ae !== document.body && !this.container.contains(ae)) return;

        const action = mergeKeyAction(e, { hasFileNav: !!this.merge.nav });
        if (!action) return;
        const handled = this.runKeyAction(action);
        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    /** Perform a `mergeKeyAction` result. Returns whether the key was used. */
    runKeyAction(action) {
        switch (action) {
            case 'next-file': this.merge.nav.onNextFile(); return true;
            case 'prev-file': this.merge.nav.onPrevFile(); return true;
            case 'prev-change': this.navigate(-1); return true;
            case 'next-change': this.navigate(1); return true;
            // Always swallowed: CodeMirror would otherwise jump by syntax unit.
            case 'prev-inline': this.navigateInline(-1); return true;
            case 'next-inline': this.navigateInline(1); return true;
            case 'copy-left': return this.copyAtCursor('left');
            case 'copy-right': return this.copyAtCursor('right');
            case 'merge-menu': return this.openMergeMenu(this._currentChunkIndex());
            case 'sync-point': return this.toggleSyncPoint();
            case 'ignore-whitespace': this.toggleIgnoreWhitespace(); return true;
            case 'show-whitespace': this.toggleShowWhitespace(); return true;
            case 'toggle-details': this.toggleDetails(); return true;
            default: return false;
        }
    }

    _sideOf(ed) {
        if (!this.mergeView) return null;
        if (ed === this.mergeView.a) return this.merge.left;
        if (ed === this.mergeView.b) return this.merge.right;
        return null;
    }

    _canEdit(ed) {
        const side = this._sideOf(ed);
        return !!(side && side.writable);
    }

    getSelectedText() {
        const ed = this._activeEditor();
        if (!ed) return '';
        const { state } = ed;
        return state.selection.ranges.filter((r) => !r.empty)
            .map((r) => state.sliceDoc(r.from, r.to)).join(state.lineBreak);
    }

    async copy() {
        const text = this.getSelectedText();
        if (text) await writeText(text);
    }

    async cut() {
        const ed = this._activeEditor();
        const text = this.getSelectedText();
        if (!ed || !text) return;
        await writeText(text);
        if (this._canEdit(ed)) ed.dispatch(ed.state.replaceSelection(''));
    }

    async paste() {
        const ed = this._activeEditor();
        if (!ed || !this._canEdit(ed)) return;
        let text = '';
        try { text = await readText(); } catch (_) { return; }
        if (text) ed.dispatch(ed.state.replaceSelection(text));
    }

    undo() {
        const ed = this._activeEditor();
        if (ed && this._canEdit(ed)) undo(ed);
    }

    redo() {
        const ed = this._activeEditor();
        if (ed && this._canEdit(ed)) redo(ed);
    }

    focus() {
        const ed = this._activeEditor();
        if (ed) ed.focus();
    }

    getDiagnostics() {
        return [];
    }

    // ── Minimap ──────────────────────────────────────────────────────────────

    _buildMinimap() {
        const map = this.minimapEl;
        if (!map) return;
        map.querySelectorAll('.diff-minimap-mark').forEach((n) => n.remove());
        const scroller = this._scroller();
        const chunks = this._chunks().filter(isShown);
        const total = scroller ? scroller.scrollHeight : 0;
        this._minimapTotal = total;
        if (!total || !chunks.length) {
            map.style.display = 'none';
            return;
        }
        map.style.display = '';

        const scrollTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
        const place = (ed, from, to) => {
            const top = ed.lineBlockAt(from).top + ed.documentTop - scrollTop;
            const end = ed.lineBlockAt(ed.state.doc.line(lastLineOf(ed.state.doc, from, Math.max(to, from + 1))).from).bottom
                + ed.documentTop - scrollTop;
            return { top, height: Math.max(2, end - top) };
        };

        const frag = document.createDocumentFragment();
        for (const ch of chunks) {
            const onLeft = ch.toA > ch.fromA;
            const onRight = ch.toB > ch.fromB;
            let box;
            if (this.mergeView) {
                box = onRight ? place(this.mergeView.b, ch.fromB, ch.toB) : place(this.mergeView.a, ch.fromA, ch.toA);
            } else {
                box = place(this.unifiedView, ch.fromB, Math.max(ch.toB, ch.fromB + 1));
            }
            const kind = chunkKind(ch);
            const mark = el('div', `diff-minimap-mark ${kind === 'both' ? 'is-mod' : kind === 'right' ? 'is-add' : 'is-del'}`);
            mark.style.top = `${(box.top / total) * 100}%`;
            mark.style.height = `${Math.max(0.4, (box.height / total) * 100)}%`;
            frag.appendChild(mark);
        }
        map.appendChild(frag);
        this._updateMinimapViewport();
    }

    _updateMinimapViewport() {
        const scroller = this._scroller();
        const total = this._minimapTotal;
        if (!scroller || !total || !this.minimapViewportEl) return;
        // Everything fits: a box covering the whole strip says nothing.
        this.minimapViewportEl.hidden = scroller.clientHeight >= total - 1;
        this.minimapViewportEl.style.top = `${(scroller.scrollTop / total) * 100}%`;
        this.minimapViewportEl.style.height = `${Math.min(100, (scroller.clientHeight / total) * 100)}%`;
    }

    _onMinimapClick(e) {
        const scroller = this._scroller();
        if (!scroller || !this._minimapTotal) return;
        const rect = this.minimapEl.getBoundingClientRect();
        const ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
        scroller.scrollTop = Math.max(0, ratio * this._minimapTotal - scroller.clientHeight / 2);
    }

    destroy() {
        window.removeEventListener('keydown', this._onKeyDown, true);
        window.removeEventListener('themeChanged', this._onThemeChanged);
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (this._layoutFrame) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._layoutFrame);
            clearTimeout(this._layoutFrame);
            this._layoutFrame = null;
        }
        this._destroyEditors();
        if (this.container) this.container.classList.remove('merge-editor', 'merge-no-controls');
    }
}
