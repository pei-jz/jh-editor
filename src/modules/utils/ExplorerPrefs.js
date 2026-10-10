/**
 * ExplorerPrefs.js — how the file explorer opens things.
 *
 * 'double' (the default): a single click only selects; double-click, Enter or
 * → opens a file, and a folder opens and closes on double-click, Enter, → / ←
 * or its chevron. Selecting a file to copy, rename or delete it used to open it
 * as well, because a single click did both.
 *
 * 'single': the old behaviour, for anyone who browses by clicking through
 * files one after another.
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
