import { describe, it, expect } from 'vitest';
import {
    makeSide, sideDirty, mergeDirty, canCopyToward, blockCopyEdit, applyBlockCopy,
    whitespaceInsensitiveChanges,
} from '../src/modules/utils/MergeSides.js';

describe('MergeSides: sides', () => {
    it('a side with nowhere to write is read-only, whatever it asks for', () => {
        expect(makeSide({ text: 'x', writable: true }).writable).toBe(false);
        expect(makeSide({ text: 'x', writable: true, target: { kind: 'custom', save() {} } }).writable).toBe(true);
        expect(makeSide({ text: 'x', writable: true, live: true }).writable).toBe(true);
    });

    it('holds LF, so a CRLF copy can come back to clean', () => {
        const side = makeSide({ text: 'a\r\nb\r\n', writable: true, target: { kind: 'custom', save() {} } });
        expect(side.text).toBe('a\nb\n');
        side.text = 'a\nb\n';
        expect(sideDirty(side)).toBe(false);
    });

    it('is dirty while its text differs from what was saved, and not after putting it back', () => {
        const side = makeSide({ text: 'one', writable: true, target: { kind: 'custom', save() {} } });
        side.text = 'two';
        expect(sideDirty(side)).toBe(true);
        side.text = 'one';
        expect(sideDirty(side)).toBe(false);
    });

    it('never calls a read-only or live side dirty', () => {
        const ro = makeSide({ text: 'a' });
        ro.text = 'b';
        const live = makeSide({ text: 'a', writable: true, live: true });
        live.text = 'b';
        expect(sideDirty(ro)).toBe(false);
        expect(sideDirty(live)).toBe(false);
        expect(mergeDirty({ left: ro, right: live })).toBe(false);
    });

    it('allows copying only toward a writable side', () => {
        const merge = {
            left: makeSide({ text: 'a' }),
            right: makeSide({ text: 'b', writable: true, target: { kind: 'custom', save() {} } }),
        };
        expect(canCopyToward(merge, 'right')).toBe(true);
        expect(canCopyToward(merge, 'left')).toBe(false);
    });
});

describe('MergeSides: copying a block', () => {
    // Chunk ranges exactly as @codemirror/merge reports them for these texts.
    const a = 'one\ntwo\nthree\n';
    const b = 'one\nTWO\nthree\nfour\n';

    it('replaces a changed line', () => {
        expect(applyBlockCopy(b, a, 4, 8, 4, 8)).toBe('one\nTWO\nthree\n');
        expect(applyBlockCopy(a, b, 4, 8, 4, 8)).toBe('one\ntwo\nthree\nfour\n');
    });

    it('inserts a line the other side does not have', () => {
        expect(applyBlockCopy(b, a, 14, 19, 14, 14)).toBe('one\ntwo\nthree\nfour\n');
    });

    it('removes a line by copying the empty side over it', () => {
        expect(applyBlockCopy(a, b, 14, 14, 14, 19)).toBe('one\nTWO\nthree\n');
    });

    it('at the end of a file without a final newline, keeps the line count right', () => {
        // a ends "b", b ends "B": the block reaches past both ends.
        const edit = blockCopyEdit('x\nB', 'x\nb', 2, 4, 2, 4);
        expect(edit).toEqual({ from: 2, to: 3, insert: 'B' });
    });
});

describe('MergeSides: ignoring whitespace', () => {
    it('reports no change when lines differ only in whitespace', () => {
        expect(whitespaceInsensitiveChanges('a\n  b\t\nc', 'a\nb\n c')).toEqual([]);
    });

    it('still reports a real change, as whole-line character ranges', () => {
        expect(whitespaceInsensitiveChanges('a\nb\nc', 'a\nB\nc'))
            .toEqual([{ fromA: 2, toA: 4, fromB: 2, toB: 4 }]);
    });

    it('takes the line break before a change at the very end', () => {
        const a = 'x\n  keep\ny';
        const b = 'x\nkeep\nY';
        const [c] = whitespaceInsensitiveChanges(a, b);
        expect(a.slice(c.fromA, c.toA)).toBe('\ny');
        expect(b.slice(c.fromB, c.toB)).toBe('\nY');
    });

    it('handles lines added on one side only', () => {
        const [c] = whitespaceInsensitiveChanges('a\nc', 'a\nb\nc');
        expect(c).toEqual({ fromA: 2, toA: 2, fromB: 2, toB: 4 });
    });
});
