import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
    cursorPageUp, cursorPageDown, selectPageDown,
} from '../src/modules/utils/CMPageMotion.js';

/* Page Up / Page Down put the caret on a line a screenful away — which is, by
   definition, a line the editor has not laid out. Nothing about that is
   measurable in jsdom, and nothing about it needs to be: what goes wrong is
   arithmetic. @codemirror/view's own estimate multiplies the caret's x offset
   by the character width instead of dividing by it, which walks the caret
   rightwards one page at a time until it sticks to the end of every line.

   So the geometry is supplied rather than measured. These numbers describe a
   monospace editor with ten lines visible; a command that reads them correctly
   reads a real editor correctly, and the multiply shows up as a caret dozens of
   columns from where it started. */

const LH = 20;    // line height
const CW = 8;     // character width
const PAD = 6;    // .cm-line's left padding — part of x, and not text
const LEFT = 100; // where the content box starts on screen; not zero on purpose
const VIEW_H = 200;

/**
 * A stand-in view over `doc`. `rendered` decides whether posAtCoords() can
 * answer — false is the case the commands exist for.
 */
function viewOver(doc, { head, anchor = head, rendered = false } = {}) {
    const state = EditorState.create({ doc, selection: { anchor, head } });
    const lineAt = (pos) => state.doc.lineAt(pos);
    const block = (line) => ({
        from: line.from, to: line.to, length: line.length,
        top: (line.number - 1) * LH, bottom: line.number * LH, height: LH,
    });
    const coords = (pos) => {
        const line = lineAt(pos);
        const x = LEFT + PAD + (pos - line.from) * CW;
        return { left: x, right: x, top: (line.number - 1) * LH, bottom: line.number * LH };
    };
    const dispatched = [];
    return {
        state,
        dispatch: (tr) => dispatched.push(tr),
        get selection() { return dispatched.length ? dispatched.at(-1).selection : null; },
        get handled() { return dispatched.length > 0; },

        defaultLineHeight: LH,
        defaultCharacterWidth: CW,
        lineWrapping: false,
        contentHeight: state.doc.lines * LH,
        documentTop: 0,
        viewport: rendered ? { from: 0, to: state.doc.length } : { from: 0, to: 0 },
        contentDOM: {
            clientWidth: 800,
            getBoundingClientRect: () => ({ left: LEFT, right: LEFT + 800, top: 0, bottom: VIEW_H }),
        },
        scrollDOM: {
            clientHeight: VIEW_H,
            scrollHeight: state.doc.lines * LH,
            getBoundingClientRect: () => ({ top: 0, bottom: VIEW_H }),
        },
        dom: { ownerDocument: { defaultView: { innerHeight: VIEW_H } } },

        coordsAtPos: (pos) => coords(pos),
        lineBlockAt: (pos) => block(lineAt(pos)),
        lineBlockAtHeight: (y) => {
            const n = Math.min(state.doc.lines, Math.max(1, Math.floor(y / LH) + 1));
            return block(state.doc.line(n));
        },
        posAtCoords: ({ x, y }) => {
            if (!rendered) return null;
            const n = Math.min(state.doc.lines, Math.max(1, Math.floor(y / LH) + 1));
            const line = state.doc.line(n);
            const col = Math.max(0, Math.round((x - LEFT - PAD) / CW));
            return line.from + Math.min(line.length, col);
        },
    };
}

/** Where the caret ended up, as a 1-based line and a character column. */
const caretOf = (view) => {
    const head = view.selection.main ? view.selection.main.head : view.selection.head;
    const line = view.state.doc.lineAt(head);
    return { line: line.number, col: head - line.from, lineLength: line.length };
};

const longDoc = (count, len = 60) =>
    Array.from({ length: count }, (_, i) => `L${String(i + 1).padStart(4, '0')} ${'x'.repeat(len)}`).join('\n');

describe('Page Down / Page Up keep the column', () => {
    it('leaves a caret in column 0 in column 0', () => {
        const doc = longDoc(200);
        const view = viewOver(doc, { head: 0 });
        expect(cursorPageDown(view)).toBe(true);
        // The bug this replaces landed here on column 48 (6px of padding times
        // an 8px character width), and on the line's end for anything shorter.
        expect(caretOf(view).col).toBe(0);
    });

    it('holds one column over a whole run of pages', () => {
        const doc = longDoc(400);
        let view = viewOver(doc, { head: 0 });
        const seen = [];
        let head = 0;
        for (let i = 0; i < 8; i++) {
            view = viewOver(doc, { head });
            cursorPageDown(view);
            head = view.selection.main.head;
            seen.push(caretOf(view));
        }
        expect(seen.map((s) => s.col)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        // ...and it really did travel: eight pages of ten lines each.
        expect(seen.at(-1).line).toBeGreaterThan(70);
    });

    it('starts from the caret, not the left margin', () => {
        const doc = longDoc(200);
        const view = viewOver(doc, { head: 40 });   // column 40 of line 1
        cursorPageDown(view);
        expect(caretOf(view).col).toBe(40);
    });

    it('measures the target when the target has been rendered', () => {
        const doc = longDoc(200);
        const view = viewOver(doc, { head: 40, rendered: true });
        cursorPageDown(view);
        expect(caretOf(view).col).toBe(40);
    });

    it('clamps to a short line without losing the column it wanted', () => {
        // Line 11 is the one a page lands on, and it is too short to hold
        // column 40; line 21, the page after it, is not. The goal has to
        // survive the short line in between.
        const lines = Array.from({ length: 200 }, (_, i) =>
            i === 10 ? 'short' : `L${i + 1} ${'x'.repeat(60)}`);
        const doc = lines.join('\n');

        const first = viewOver(doc, { head: 40 });
        cursorPageDown(first);
        const atShort = caretOf(first);
        expect(atShort.line).toBe(11);
        expect(atShort.col).toBe(atShort.lineLength);   // as far right as it goes

        const second = viewOver(doc, { head: 40 });
        // Carry the goal the way a real dispatch would.
        second.state = second.state.update({ selection: first.selection }).state;
        cursorPageDown(second);
        expect(caretOf(second).col).toBe(40);
    });

    it('walks back up the same way it came down', () => {
        const doc = longDoc(300);
        const down = viewOver(doc, { head: 30 });
        cursorPageDown(down);
        const landed = caretOf(down);

        const up = viewOver(doc, { head: down.selection.main.head });
        cursorPageUp(up);
        expect(caretOf(up)).toEqual({ line: 1, col: 30, lineLength: 66 });
        expect(landed.line).toBe(11);
    });
});

describe('Page Down / Page Up at the edges of the document', () => {
    it('finishes at the document end once the last line is reached', () => {
        const doc = longDoc(5);
        const last = doc.length - 3;
        const view = viewOver(doc, { head: last });
        expect(cursorPageDown(view)).toBe(true);
        expect(view.selection.main.head).toBe(doc.length);
    });

    it('finishes at the document start once the first line is reached', () => {
        const doc = longDoc(5);
        const view = viewOver(doc, { head: 3 });
        expect(cursorPageUp(view)).toBe(true);
        expect(view.selection.main.head).toBe(0);
    });

    it('reports the key unhandled when there is nowhere to go', () => {
        const view = viewOver(longDoc(3), { head: 0 });
        expect(cursorPageUp(view)).toBe(false);
    });
});

describe('Shift+Page keeps its anchor', () => {
    it('extends the selection instead of moving the caret', () => {
        const doc = longDoc(200);
        const view = viewOver(doc, { head: 10 });
        selectPageDown(view);
        const range = view.selection.main;
        expect(range.anchor).toBe(10);
        expect(range.head).toBeGreaterThan(10);
        expect(caretOf(view).col).toBe(10);
    });
});
