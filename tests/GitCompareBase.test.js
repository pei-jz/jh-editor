import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));

import { resolveCompareBase } from '../src/modules/ui/GitPanel.js';

// Comparing `origin/master` with the older tag `v0.01` reported "0 files / No
// differences" even though ten files differ. The three-dot form asks "what is
// on v0.01 that origin/master never had" — and since the tag is an ancestor of
// the branch, the honest answer is nothing. Correct git, useless answer.

const MERGE_BASE = '7f41daeb0c9a1b1c3539e786645918742a9abcef';
const HEAD_COMMIT = '02916dbe7ed3d770de19eb755cc55491d449368b';

describe('resolveCompareBase', () => {
    it('starts from the merge base when the two refs really diverged', () => {
        const r = resolveCompareBase({
            base: 'v0.01', head: 'origin/master', useMergeBase: true,
            mergeBase: MERGE_BASE, headCommit: HEAD_COMMIT,
        });
        expect(r.fromRev).toBe(MERGE_BASE);
        expect(r.fromLabel).toBe('v0.01 (merge-base)');
        expect(r.note).toBe('');
    });

    // The reported bug.
    it('falls back to the direct diff when the compare ref is an ancestor', () => {
        const r = resolveCompareBase({
            base: 'origin/master', head: 'v0.01', useMergeBase: true,
            // merge-base(origin/master, v0.01) IS v0.01.
            mergeBase: MERGE_BASE, headCommit: MERGE_BASE,
        });
        expect(r.fromRev).toBe('origin/master');
        expect(r.fromLabel).toBe('origin/master');
        expect(r.note).toContain('already part of');
    });

    it('falls back when the histories are unrelated', () => {
        const r = resolveCompareBase({
            base: 'main', head: 'orphan', useMergeBase: true,
            mergeBase: '', headCommit: HEAD_COMMIT,
        });
        expect(r.fromRev).toBe('main');
        expect(r.note).toContain('No common ancestor');
    });

    it('uses the ref as-is when the checkbox is off', () => {
        const r = resolveCompareBase({
            base: 'main', head: 'dev', useMergeBase: false,
            mergeBase: MERGE_BASE, headCommit: HEAD_COMMIT,
        });
        expect(r).toEqual({ fromRev: 'main', fromLabel: 'main', note: '' });
    });

    // '' is the working tree, which has no commit to find an ancestor of.
    it('uses the ref as-is when comparing against the working tree', () => {
        const r = resolveCompareBase({
            base: 'main', head: '', useMergeBase: true,
            mergeBase: MERGE_BASE, headCommit: '',
        });
        expect(r).toEqual({ fromRev: 'main', fromLabel: 'main', note: '' });
    });

    // Whatever it decides, the left side must be a revision git can resolve —
    // never an empty string, which git_diff_files would read as "working tree".
    it('always yields a usable left-hand revision', () => {
        for (const useMergeBase of [true, false]) {
            for (const [mergeBase, headCommit] of
                [['', ''], [MERGE_BASE, MERGE_BASE], [MERGE_BASE, HEAD_COMMIT]]) {
                const r = resolveCompareBase({
                    base: 'main', head: 'dev', useMergeBase, mergeBase, headCommit,
                });
                expect(r.fromRev).toBeTruthy();
            }
        }
    });
});
