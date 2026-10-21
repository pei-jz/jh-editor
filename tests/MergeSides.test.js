import { describe, it, expect } from 'vitest';
import {
    makeSide, sideDirty, mergeDirty, canCopyToward, blockCopyEdit, applyBlockCopy,
    blockCombineEdit,
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

describe('MergeSides: a file whose last line has no line break', () => {
    // Ranges as utils/LineDiff.js reports them: the side without lines sits
    // at the very end, after the last character.
    it('adds lines after that last line with a break in front of them', () => {
        expect(applyBlockCopy('x\ny', 'x', 2, 4, 1, 1)).toBe('x\ny');
    });

    it('removes lines at the end together with the break before them', () => {
        expect(applyBlockCopy('x', 'x\ny', 1, 1, 2, 4)).toBe('x');
    });
});

describe('MergeSides: keeping both versions', () => {
    const apply = (dest, e) => dest.slice(0, e.from) + e.insert + dest.slice(e.to);

    it('puts the destination first, or the source first', () => {
        const left = 'a\nL1\nL2\nz\n';
        const right = 'a\nR\nz\n';
        // Into the right: the source is the left block (2..8), the destination 2..4.
        expect(apply(right, blockCombineEdit(left, right, 2, 8, 2, 4, false))).toBe('a\nR\nL1\nL2\nz\n');
        const first = blockCombineEdit(left, right, 2, 8, 2, 4, true);
        const text = apply(right, first);
        expect(text).toBe('a\nL1\nL2\nR\nz\n');
        // What is selected afterwards is the combined block, for editing.
        expect(text.slice(first.select.from, first.select.to)).toBe('L1\nL2\nR');
    });

    it('keeps the line count right at the end of a file without a final break', () => {
        const e = blockCombineEdit('a\nL', 'a\nR', 2, 4, 2, 4, true);
        expect(apply('a\nR', e)).toBe('a\nL\nR');
    });
});
