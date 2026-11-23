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

/**
 * The comparable form of a path.
 *
 * Windows paths are compared WITHOUT case, because Windows does not have it:
 * `c:/dir/fs.rs` and `C:/dir/fs.rs` are one file, and something that treats
 * them as two opens a second tab for a file already on screen — two tabs over
 * one document, with separate undo histories, where saving the stale one
 * silently reverts the other.
 *
 * That is not hypothetical. A language server answers Go to Definition with a
 * URI of its own making, and its idea of the drive letter's case need not match
 * the one the tab was opened under. F12 on a symbol defined in the file you
 * were already reading opened a duplicate of it.
 *
 * POSIX paths keep their case, because there `a.rs` and `A.rs` really are two
 * files. A leading drive letter is what tells the two apart.
 */
function comparablePath(path) {
    const p = String(path || '').replace(/\\/g, '/');
    return /^[a-zA-Z]:(?=\/|$)/.test(p) ? p.toLowerCase() : p;
}

/** Locate an already-open file by normalized path, across both panes. */
export function findOpenFile(normalizedPath) {
    const wanted = comparablePath(normalizedPath);
    for (const pane of [LEFT, RIGHT]) {
        const files = paneFiles(pane);
        const index = files.findIndex(
            f => f && f.path && comparablePath(f.path) === wanted
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
export function handleStillInUse(key, id) {
    if (id == null) return false;
    // No `exclude` any more. It excluded by object identity, which stopped
    // meaning "my own tab" once a split started SHARING the buffer object: the
    // other pane's entry is the same object, so it was excluded too and the
    // backend handle was freed underneath a pane still showing the file.
    //
    // The caller removes its tab first, so these lists are simply the truth
    // about who still holds the handle.
    return [...State.openFiles, ...State.rightOpenFiles]
        .some(f => f && f[key] === id);
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

/**
 * When each tab was last on screen, for the Ctrl+T list.
 *
 * A WeakMap, not a field on the file object: the session saver serializes
 * those objects, and a closed tab must not be kept alive by this bookkeeping.
 * A counter rather than Date.now(), so two switches in the same millisecond
 * still sort in the order they happened.
 */
const lastShown = new WeakMap();
let shownSeq = 0;

export function markShown(file) {
    if (file && typeof file === 'object') lastShown.set(file, ++shownSeq);
}

/**
 * Every open tab in both panes, most recently shown first.
 *
 * Tabs never shown this run (restored from the session and not yet visited)
 * keep their strip order behind the visited ones. A buffer a split shows in
 * both panes is listed once, under the pane that is active if it is there.
 */
export function tabsByRecentUse() {
    const entries = openTabEntries(activePane()).map((e, order) => ({ ...e, order }));
    entries.sort((a, b) =>
        (lastShown.get(b.file) || 0) - (lastShown.get(a.file) || 0) || a.order - b.order);
    return entries.map(({ file, pane, index }) => ({ file, pane, index }));
}

/**
 * Every open tab as { file, pane, index }, in strip order, `firstPane`'s tabs
 * first. A buffer a split shows in both panes is listed once, under the pane
 * that comes first. A stale right pane is ignored once the split is gone.
 */
export function openTabEntries(firstPane = LEFT) {
    const panes = State.splitMode ? [firstPane, otherPane(firstPane)] : [LEFT];
    const seen = new Set();
    const entries = [];
    for (const pane of panes) {
        paneFiles(pane).forEach((file, index) => {
            if (!file || seen.has(file)) return;
            seen.add(file);
            entries.push({ file, pane, index });
        });
    }
    return entries;
}

/**
 * Split a pane's tabs into the ones that stay and the ones `shouldClose`
 * picks, and say which tab is active afterwards.
 *
 * The active tab stays active if it survives. Otherwise the nearest survivor
 * to its left takes over (the same direction a single close moves in), then
 * the first one; -1 when nothing is left.
 */
export function planTabRemoval(files, activeIndex, shouldClose) {
    const kept = [];
    const removed = [];
    let nextActive = -1;
    let leftOfActive = -1;
    files.forEach((file, i) => {
        if (shouldClose(file, i)) {
            removed.push(file);
            return;
        }
        if (i === activeIndex) nextActive = kept.length;
        if (i < activeIndex) leftOfActive = kept.length;
        kept.push(file);
    });
    if (nextActive < 0) nextActive = leftOfActive >= 0 ? leftOfActive : (kept.length ? 0 : -1);
    return { kept, removed, activeIndex: nextActive };
}

// --- Pinned tabs --------------------------------------------------------------
//
// A pinned tab (file.pinned) sits at the front of its pane and stays there:
// the pinned tabs of a pane are always its first ones, in an unbroken run.
// Everything below keeps that true, so the tab strip, the bulk closes and the
// session can each read "the first pinnedCount() tabs" and nothing else.
// New tabs are appended, which never breaks it.

/** How many tabs at the front of `files` are pinned. */
export function pinnedCount(files) {
    let n = 0;
    while (n < files.length && files[n] && files[n].pinned) n++;
    return n;
}

/** Put the pinned tabs first, each group keeping its order. */
export function partitionPinned(files) {
    const pinned = files.filter((f) => f && f.pinned);
    const rest = files.filter((f) => !(f && f.pinned));
    files.splice(0, files.length, ...pinned, ...rest);
    return files;
}

/**
 * Bound a drop position (an insertion index, as reorderInPlace takes) so a
 * tab lands in its own group: a pinned one among the pinned, any other after
 * them. Dragging a tab across the boundary used to be the only way to break
 * the run.
 */
export function clampDropIndex(files, fromIndex, toIndex) {
    const file = files[fromIndex];
    const pc = pinnedCount(files);
    if (file && file.pinned) return Math.max(0, Math.min(toIndex, pc));
    return Math.max(pc, Math.min(toIndex, files.length));
}

/**
 * Where `file`, coming from another pane, goes in `files`: `destIndex` (null
 * for the end of its group) bounded to the file's group.
 */
export function insertIndexFor(files, file, destIndex) {
    const pc = pinnedCount(files);
    if (file && file.pinned) return destIndex == null ? pc : Math.max(0, Math.min(destIndex, pc));
    return destIndex == null ? files.length : Math.max(pc, Math.min(destIndex, files.length));
}

/**
 * Pin or unpin the tab at `index`. It moves to the boundary: a newly pinned
 * tab becomes the last pinned one, an unpinned tab the first of the rest, so
 * neither jumps further than it has to. Returns its new index.
 */
export function setPinnedInPlace(files, index, pinned) {
    const file = files[index];
    if (!file) return -1;
    if (!!file.pinned === !!pinned) return index;
    files.splice(index, 1);
    if (pinned) file.pinned = true;
    else delete file.pinned;
    const at = pinnedCount(files);
    files.splice(at, 0, file);
    return at;
}
