import { describe, it, expect, beforeEach } from 'vitest';
import { State } from '../src/modules/core/Store.js';
import {
    activePane, normalizePane, paneFiles, paneActiveIndex, setPaneActiveIndex,
    otherPane, findOpenFile, activeFile, activeIndexAfterRemoval, reorderInPlace,
    handleStillInUse, mergeRightIntoLeft,
} from '../src/modules/core/Panes.js';

const mk = (path, over = {}) => ({ path, name: path.split('/').pop(), content: '', isDirty: false, ...over });

const reset = () => {
    State.openFiles = [];
    State.rightOpenFiles = [];
    State.activeTabIndex = -1;
    State.rightActiveTabIndex = -1;
    State.splitMode = false;
    State.activePane = 'left';
};

describe('Panes — the split-only invariant', () => {
    beforeEach(reset);

    it('reports the left pane when nothing is split', () => {
        expect(activePane()).toBe('left');
    });

    // This is the bug that made the editor look frozen: after a split was torn
    // down, activePane stayed 'right' and every open addressed an empty list.
    it('ignores a stale activePane once the split is gone', () => {
        State.activePane = 'right';
        State.splitMode = false;
        expect(activePane()).toBe('left');
        expect(normalizePane('right')).toBe('left');
        expect(paneFiles(activePane())).toBe(State.openFiles);
    });

    it('honours the right pane while split', () => {
        State.splitMode = 'horizontal';
        State.activePane = 'right';
        expect(activePane()).toBe('right');
        expect(normalizePane('right')).toBe('right');
    });

    it('normalizes an explicit left request regardless of focus', () => {
        State.splitMode = 'horizontal';
        State.activePane = 'right';
        expect(normalizePane('left')).toBe('left');
    });

    it('falls back to the active pane for an unknown argument', () => {
        State.splitMode = 'horizontal';
        State.activePane = 'right';
        expect(normalizePane(undefined)).toBe('right');
        expect(normalizePane(null)).toBe('right');
        expect(normalizePane('middle')).toBe('right');
    });

    it('maps panes to their own tab list and index', () => {
        State.openFiles = [mk('/a')];
        State.rightOpenFiles = [mk('/b'), mk('/c')];
        State.activeTabIndex = 0;
        State.rightActiveTabIndex = 1;

        expect(paneFiles('left')).toBe(State.openFiles);
        expect(paneFiles('right')).toBe(State.rightOpenFiles);
        expect(paneActiveIndex('left')).toBe(0);
        expect(paneActiveIndex('right')).toBe(1);

        setPaneActiveIndex('right', 0);
        expect(State.rightActiveTabIndex).toBe(0);
        setPaneActiveIndex('left', -1);
        expect(State.activeTabIndex).toBe(-1);
    });

    it('flips panes', () => {
        expect(otherPane('left')).toBe('right');
        expect(otherPane('right')).toBe('left');
    });
});

describe('Panes — locating an open file', () => {
    beforeEach(reset);

    it('finds a file in the left pane', () => {
        State.openFiles = [mk('/ws/a.md'), mk('/ws/b.md')];
        expect(findOpenFile('/ws/b.md')).toMatchObject({ pane: 'left', index: 1 });
    });

    it('finds a file that only exists in the right pane', () => {
        State.openFiles = [mk('/ws/a.md')];
        State.rightOpenFiles = [mk('/ws/z.md')];
        expect(findOpenFile('/ws/z.md')).toMatchObject({ pane: 'right', index: 0 });
    });

    it('prefers the left pane when both hold the same file', () => {
        State.openFiles = [mk('/ws/a.md')];
        State.rightOpenFiles = [mk('/ws/a.md')];
        expect(findOpenFile('/ws/a.md').pane).toBe('left');
    });

    it('matches regardless of path separator style', () => {
        State.openFiles = [mk('C:\\ws\\a.md')];
        expect(findOpenFile('C:/ws/a.md')).toMatchObject({ pane: 'left', index: 0 });
    });

    it('returns null for an unopened path, and tolerates pathless tabs', () => {
        State.openFiles = [{ name: 'Untitled' }, mk('/ws/a.md')];
        expect(findOpenFile('/ws/missing.md')).toBeNull();
    });
});

describe('Panes — the active buffer', () => {
    beforeEach(reset);

    it('is null when nothing is open', () => {
        expect(activeFile()).toBeNull();
    });

    // Saving used to read the left pane unconditionally, which wrote the wrong
    // buffer to disk whenever the right pane had focus.
    it('follows focus into the right pane', () => {
        State.openFiles = [mk('/ws/left.md')];
        State.activeTabIndex = 0;
        State.rightOpenFiles = [mk('/ws/right.md')];
        State.rightActiveTabIndex = 0;
        State.splitMode = 'horizontal';
        State.activePane = 'right';

        expect(activeFile().path).toBe('/ws/right.md');
    });

    it('returns the left buffer once the split is closed', () => {
        State.openFiles = [mk('/ws/left.md')];
        State.activeTabIndex = 0;
        State.activePane = 'right';   // stale
        State.splitMode = false;
        expect(activeFile().path).toBe('/ws/left.md');
    });
});

describe('Panes — index after a tab is removed', () => {
    it('keeps the active index when a later tab closes', () => {
        expect(activeIndexAfterRemoval(2, 1, 2)).toBe(1);
    });

    it('shifts the active index down when an earlier tab closes', () => {
        expect(activeIndexAfterRemoval(0, 2, 2)).toBe(1);
    });

    it('steps back one when the active tab itself closes', () => {
        expect(activeIndexAfterRemoval(2, 2, 2)).toBe(1);
    });

    it('stays at 0 when the first (active) tab closes', () => {
        expect(activeIndexAfterRemoval(0, 0, 1)).toBe(0);
    });

    it('reports -1 once the pane is empty', () => {
        expect(activeIndexAfterRemoval(0, 0, 0)).toBe(-1);
    });
});

describe('Panes — reordering', () => {
    it('moves a tab to the right', () => {
        expect(reorderInPlace(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a']);
    });

    it('moves a tab to the left', () => {
        expect(reorderInPlace(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    });

    it('moves a tab into the middle', () => {
        expect(reorderInPlace(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    });

    // Dropping a tab on either of its own edges must not renumber anything.
    it('treats a drop next to itself as a no-op', () => {
        expect(reorderInPlace(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
        expect(reorderInPlace(['a', 'b', 'c'], 1, 2)).toEqual(['a', 'b', 'c']);
    });

    it('clamps an out-of-range drop position', () => {
        expect(reorderInPlace(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
        expect(reorderInPlace(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
    });

    it('ignores an out-of-range source', () => {
        expect(reorderInPlace(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
        expect(reorderInPlace([], 0, 0)).toEqual([]);
    });
});

describe('Panes — shared backend handles', () => {
    beforeEach(reset);

    it('sees no user for an absent handle', () => {
        expect(handleStillInUse('largeId', null, null)).toBe(false);
        expect(handleStillInUse('largeId', undefined, null)).toBe(false);
    });

    // Splitting clones the file object, so the same mmap id lives in both panes.
    // Closing one tab must not free the handle the other is still reading from.
    it('detects a clone in the other pane holding the same id', () => {
        const left = mk('/ws/huge.log', { largeId: 7 });
        const right = { ...left };
        State.openFiles = [left];
        State.rightOpenFiles = [right];
        expect(handleStillInUse('largeId', 7, right)).toBe(true);
    });

    it('reports free once the last holder is the one being closed', () => {
        const only = mk('/ws/huge.log', { largeId: 7 });
        State.openFiles = [only];
        expect(handleStillInUse('largeId', 7, only)).toBe(false);
    });

    it('distinguishes handle kinds', () => {
        const a = mk('/ws/a', { editId: 3 });
        const b = mk('/ws/b', { largeId: 3 });
        State.openFiles = [a, b];
        expect(handleStillInUse('editId', 3, a)).toBe(false);
        expect(handleStillInUse('largeId', 3, a)).toBe(true);
    });
});

describe('Panes — collapsing a split', () => {
    beforeEach(reset);

    it('carries over tabs the left pane does not have', () => {
        const left = [mk('/ws/a.md')];
        const right = [mk('/ws/b.md')];
        mergeRightIntoLeft(left, right);
        expect(left.map(f => f.path)).toEqual(['/ws/a.md', '/ws/b.md']);
    });

    // A split seeds itself by cloning the active tab; merging blindly would
    // leave the very same file open twice.
    it('does not duplicate a file already open on the left', () => {
        const original = mk('/ws/a.md');
        const left = [original];
        mergeRightIntoLeft(left, [{ ...original }]);
        expect(left).toHaveLength(1);
    });

    it('rescues unsaved text from a clone it drops', () => {
        const original = mk('/ws/a.md', { content: 'disk' });
        const left = [original];
        mergeRightIntoLeft(left, [{ ...original, content: 'edited', isDirty: true }]);
        expect(left).toHaveLength(1);
        expect(original.content).toBe('edited');
        expect(original.isDirty).toBe(true);
    });

    it('never overwrites unsaved text on the left with a clone', () => {
        const original = mk('/ws/a.md', { content: 'left edits', isDirty: true });
        const left = [original];
        mergeRightIntoLeft(left, [{ ...original, content: 'right edits', isDirty: true }]);
        expect(original.content).toBe('left edits');
    });

    it('keeps untitled buffers, which have no path to compare', () => {
        const left = [{ name: 'Untitled', content: 'x' }];
        mergeRightIntoLeft(left, [{ name: 'Untitled', content: 'y' }]);
        expect(left).toHaveLength(2);
    });

    it('skips the identical object appearing in both lists', () => {
        const shared = { name: 'Untitled' };
        const left = [shared];
        mergeRightIntoLeft(left, [shared]);
        expect(left).toHaveLength(1);
    });

    it('tolerates holes and an empty right pane', () => {
        const left = [mk('/ws/a.md')];
        mergeRightIntoLeft(left, [null, undefined]);
        mergeRightIntoLeft(left, []);
        expect(left).toHaveLength(1);
    });
});
