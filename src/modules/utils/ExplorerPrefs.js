/**
 * ExplorerPrefs.js — how the file explorer opens folders.
 *
 * Files always open on a single click. Folders:
 *
 * 'double' (the default): a single click only selects the folder; it opens
 * and closes on double-click, Enter, → / ← or its chevron. Selecting a folder
 * to copy, rename or delete it used to toggle it as well.
 *
 * 'single': a single click opens and closes it, the old behaviour.
 *
 * The stored key keeps its original name so a choice made in 0.4.4, when the
 * setting covered files too, carries over.
 */
const KEY = 'settings_explorerOpenOn';

export function explorerOpensOn() {
    try {
        return localStorage.getItem(KEY) === 'single' ? 'single' : 'double';
    } catch (_) {
        return 'double';
    }
}

export function setExplorerOpensOn(mode) {
    try {
        localStorage.setItem(KEY, mode === 'single' ? 'single' : 'double');
    } catch (_) { /* ignore */ }
}
