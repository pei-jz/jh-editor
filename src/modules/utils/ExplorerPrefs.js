/**
 * ExplorerPrefs.js — how the file explorer opens folders, and what it lists.
 *
 * Files the editor opens itself always open on a single click. Folders, and
 * files handed to another application:
 *
 * 'double' (the default): a single click only selects the row; it opens on
 * double-click or Enter. Selecting a folder to copy, rename or delete it used
 * to toggle it as well, and doing the same to a PDF must not start a viewer.
 *
 * 'single': a single click opens it, the old behaviour for folders.
 *
 * The stored key keeps its original name so a choice made in 0.4.4, when the
 * setting covered files too, carries over.
 */
const KEY = 'settings_explorerOpenOn';

// Whether files the editor has no view for are listed (utils/ExternalFiles.js).
// One setting for all workspaces, like the one above: it says how this person
// likes the tree, not anything about a project.
export const SHOW_EXTERNAL_KEY = 'settings_explorerShowExternal';

export function explorerShowsExternal() {
    try {
        return localStorage.getItem(SHOW_EXTERNAL_KEY) === '1';
    } catch (_) {
        return false;
    }
}

export function setExplorerShowsExternal(show) {
    try {
        localStorage.setItem(SHOW_EXTERNAL_KEY, show ? '1' : '0');
    } catch (_) { /* ignore */ }
}

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
