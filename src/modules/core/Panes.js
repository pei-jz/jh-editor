import { State } from './Store.js';

/**
 * Panes — the split editor's tab bookkeeping.
 *
 * Kept out of Editor.js because it is pure state manipulation with no DOM or
 * Tauri involvement, which is also what makes it testable.
 *
 * The invariant that matters: **"right" only exists while State.splitMode is
 * on.** State.activePane is a plain string that outlives the split (closing the
 * last right-hand tab, closing all tabs, restoring a session), and every
 * operation that trusted it blindly would then address an empty tab list — the
 * tab was created, the render was skipped, and the editor looked frozen.
 */

export const LEFT = 'left';
export const RIGHT = 'right';

/** The pane that should receive new files and commands right now. */
export function activePane() {
    return State.splitMode && State.activePane === RIGHT ? RIGHT : LEFT;
}

/** Coerce an arbitrary pane argument to one that currently exists. */
export function normalizePane(pane) {
    if (pane === RIGHT) return State.splitMode ? RIGHT : LEFT;
    if (pane === LEFT) return LEFT;
    return activePane();
}

export function paneFiles(pane) {
    return pane === RIGHT ? State.rightOpenFiles : State.openFiles;
}

export function paneActiveIndex(pane) {
    return pane === RIGHT ? State.rightActiveTabIndex : State.activeTabIndex;
}

export function setPaneActiveIndex(pane, index) {
    if (pane === RIGHT) State.rightActiveTabIndex = index;
    else State.activeTabIndex = index;
}

export function otherPane(pane) {
    return pane === RIGHT ? LEFT : RIGHT;
}

/** Locate an already-open file by normalized path, across both panes. */
export function findOpenFile(normalizedPath) {
    for (const pane of [LEFT, RIGHT]) {
        const files = paneFiles(pane);
        const index = files.findIndex(
            f => f && f.path && f.path.replace(/\\/g, '/') === normalizedPath
        );
        if (index >= 0) return { pane, index, file: files[index] };
    }
    return null;
}

/** The buffer the user is looking at, or null. */
export function activeFile() {
    const pane = activePane();
    const idx = paneActiveIndex(pane);
    return idx >= 0 ? paneFiles(pane)[idx] || null : null;
}

/**
 * Where the active tab lands after the tab at `removedIndex` is taken out.
 * -1 when the pane is left empty.
 */
export function activeIndexAfterRemoval(removedIndex, activeIndex, remainingCount) {
    if (removedIndex === activeIndex) {
        return remainingCount > 0 ? Math.max(0, removedIndex - 1) : -1;
    }
    if (removedIndex < activeIndex) return activeIndex - 1;
    return activeIndex;
}

/**
 * Reorder within a list, given a drop position expressed as an insertion index
 * (i.e. "before the tab currently at `toIndex`"; `list.length` means append).
 * Returns the mutated list for convenience.
 */
export function reorderInPlace(list, fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= list.length) return list;
    const bounded = Math.max(0, Math.min(toIndex, list.length));
    // Dropping a tab immediately before or after itself is a no-op, not a move.
    if (fromIndex === bounded || fromIndex === bounded - 1) return list;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(fromIndex < bounded ? bounded - 1 : bounded, 0, moved);
    return list;
}

/**
 * True when a backend handle (mmap viewer / rope editor) is still referenced by
 * another open tab. Splitting clones the file object, so both panes can hold the
 * same id — freeing it on the first close would break the survivor.
 */
export function handleStillInUse(key, id, exclude) {
    if (id == null) return false;
    return [...State.openFiles, ...State.rightOpenFiles]
        .some(f => f && f !== exclude && f[key] === id);
}

/**
 * Merge the secondary pane's tabs into the primary one when a split collapses.
 * Buffers already open on the left are dropped rather than duplicated — a split
 * seeds itself by cloning the active tab, so a blind merge shows the same file
 * twice. Unsaved text from a dropped clone is carried over to the survivor.
 */
export function mergeRightIntoLeft(left, right) {
    for (const f of right) {
        if (!f) continue;
        const twin = f.path ? left.find(o => o && o.path === f.path) : null;
        if (twin || left.includes(f)) {
            if (twin && f.isDirty && !twin.isDirty) {
                twin.content = f.content;
                twin.isDirty = true;
            }
            continue;
        }
        left.push(f);
    }
    return left;
}
