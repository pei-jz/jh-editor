import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { sortSelectedLines, dedupeSelectedLines } from '../src/modules/views/CodeMirrorView.js';
import { Toast } from '../src/modules/ui/Toast.js';

// Alt+A / Alt+M operate on the selected lines. Both take a CodeMirror view, but
// only `state` and `dispatch` — so a plain EditorState plus a spy exercises the
// real commands without mounting an editor.

/** A stand-in view over `text` with every line selected. */
const viewOver = (text) => {
    const doc = text;
    const state = EditorState.create({ doc, selection: { anchor: 0, head: doc.length } });
    const dispatched = [];
    return {
        state,
        dispatch: (tr) => dispatched.push(tr),
        get result() {
            if (!dispatched.length) return null;
            const { from, to, insert } = dispatched[0].changes;
            return doc.slice(0, from) + insert + doc.slice(to);
        },
    };
};

const lastToast = () => Toast.show.mock.calls.at(-1)?.[0] ?? '';

describe('Alt+A — sort selected lines', () => {
    beforeEach(() => {
        vi.spyOn(Toast, 'show').mockImplementation(() => {});
        // The direction toggle is module state; normalise it by running one
        // throwaway sort so each test starts from a known parity.
        sortSelectedLines(viewOver('b\na'));
        Toast.show.mockClear();
    });

    it('alternates ascending then descending on repeated presses', () => {
        const first = viewOver('banana\napple\ncherry');
        sortSelectedLines(first);
        const second = viewOver('banana\napple\ncherry');
        sortSelectedLines(second);
        const third = viewOver('banana\napple\ncherry');
        sortSelectedLines(third);

        // Whichever parity the throwaway left, the three presses must alternate.
        expect(first.result).not.toBe(second.result);
        expect(third.result).toBe(first.result);
        expect([first.result, second.result].sort()).toEqual(
            ['apple\nbanana\ncherry', 'cherry\nbanana\napple'].sort()
        );
    });

    it('says which direction it sorted', () => {
        sortSelectedLines(viewOver('b\na'));
        const one = lastToast();
        sortSelectedLines(viewOver('b\na'));
        const two = lastToast();
        expect([one, two].sort()).toEqual(['Sorted ascending.', 'Sorted descending.'].sort());
    });

    it('sorts numerically, not lexically', () => {
        // Run twice if needed so we compare against the ascending pass.
        let v = viewOver('item10\nitem9\nitem1');
        sortSelectedLines(v);
        if (v.result !== 'item1\nitem9\nitem10') {
            v = viewOver('item10\nitem9\nitem1');
            sortSelectedLines(v);
        }
        expect(v.result).toBe('item1\nitem9\nitem10');
    });

    it('does nothing on a single line', () => {
        const v = viewOver('only');
        expect(sortSelectedLines(v)).toBe(false);
        expect(v.result).toBeNull();
    });
});

describe('Alt+M — remove duplicate lines', () => {
    beforeEach(() => {
        vi.spyOn(Toast, 'show').mockImplementation(() => {});
    });

    it('keeps the first occurrence of each line, in order', () => {
        const v = viewOver('b\na\nb\nc\na\nb');
        expect(dedupeSelectedLines(v)).toBe(true);
        expect(v.result).toBe('b\na\nc');
    });

    // How many VALUES were duplicated, and how many lines actually went away.
    // They are different numbers.
    it('reports the duplicated kinds and the removed line count', () => {
        // 'b' ×3 and 'a' ×2 → 2 kinds, 3 lines removed, 6 → 3.
        dedupeSelectedLines(viewOver('b\na\nb\nc\na\nb'));
        const msg = lastToast();
        expect(msg).toContain('across 2 values');
        expect(msg).toContain('Removed 3 duplicate lines');
        expect(msg).toContain('6 to 3 lines');
    });

    it('says so when there was nothing to remove, and changes nothing', () => {
        const v = viewOver('a\nb\nc');
        expect(dedupeSelectedLines(v)).toBe(false);
        expect(v.result).toBeNull();
        expect(lastToast()).toContain('No duplicate lines found.');
    });

    it('does nothing on a single line', () => {
        const v = viewOver('only');
        expect(dedupeSelectedLines(v)).toBe(false);
        expect(v.result).toBeNull();
    });
});
