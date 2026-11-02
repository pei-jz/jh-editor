/**
 * FolderJump.js — what the folder search knows: the registered folders, the
 * folders jumped to lately, and how a query ranks them.
 *
 * A registered ("pinned") folder does two jobs at once: it sits at the top of
 * the list before anything is typed, and the folders below it are searched.
 * Two separate lists for those would be one more thing to set up.
 *
 * Jumps have their own history rather than joining the recent workspaces.
 * Showing a folder in Explorer is not opening a project, and it would push the
 * real projects out of the workspace menu.
 *
 * Stored in localStorage, which every window shares, the jump window included.
 *
 * No DOM and no Tauri, so the ordering is tested directly
 * (tests/FolderJump.test.js).
 */
import { RecentFiles, sameWorkspace } from './RecentFiles.js';
import { pathKey, prepareEntries, rankFiles } from './FileSearchRank.js';

const PINNED_KEY = 'jheditor_folder_jump_pinned';
const RECENT_KEY = 'jheditor_folder_jump_recent';
const MAX_RECENT = 30;

function readList(key) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
    } catch (_) { return []; }
}

function writeList(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (_) { /* ignore */ }
}

export function getPinned() {
    return readList(PINNED_KEY);
}

export function isPinned(path) {
    return getPinned().some((p) => sameWorkspace(p, path));
}

/** Pinned order is the order they were added: a list you arranged stays put. */
export function pin(path) {
    if (!path || isPinned(path)) return;
    writeList(PINNED_KEY, [...getPinned(), path]);
}

export function unpin(path) {
    writeList(PINNED_KEY, getPinned().filter((p) => !sameWorkspace(p, path)));
}

export function getRecentJumps() {
    return readList(RECENT_KEY);
}

/** Most recent first, one entry per folder however its slashes were written. */
export function recordJump(path) {
    if (!path) return;
    writeList(RECENT_KEY, [path, ...getRecentJumps().filter((p) => !sameWorkspace(p, path))].slice(0, MAX_RECENT));
}

/** Drop a folder from every history it is in. Pinning is a separate decision. */
export function forgetFolder(path) {
    writeList(RECENT_KEY, getRecentJumps().filter((p) => !sameWorkspace(p, path)));
    RecentFiles.forgetWorkspace(path);
}

/** The last path segment; a drive root has none, so it keeps its whole name. */
export function folderName(path) {
    const trimmed = String(path).replace(/[\\/]+$/, '');
    const name = trimmed.split(/[\\/]/).pop();
    return name && !/^[a-zA-Z]:$/.test(name) ? name : String(path);
}

/** Written as a full path, so it can be tried as-is: `C:\x`, `\\server\share`, `%TEMP%\x`. */
export function looksLikePath(query) {
    return /^([a-zA-Z]:[\\/]|\\\\|%[^%]+%)/.test(String(query || '').trim());
}

/**
 * Everything known without touching the disk, best first: pinned, then the
 * folders jumped to, then the recent workspaces.
 *
 * @returns {Array<{path: string, name: string, source: 'pinned'|'recent'}>}
 */
export function knownFolders() {
    const seen = new Set();
    const out = [];
    const add = (path, source) => {
        const key = pathKey(path);
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({ path, name: folderName(path), source });
    };
    getPinned().forEach((p) => add(p, 'pinned'));
    getRecentJumps().forEach((p) => add(p, 'recent'));
    RecentFiles.getWorkspaces().forEach((p) => add(p, 'recent'));
    return out;
}

/** Index entries for the walked folders. Expensive per keystroke, so built once. */
export function prepareFolderIndex(paths) {
    return prepareEntries(paths.map((path) => ({ path, name: folderName(path), source: 'index' })), '');
}

/**
 * Rank the known folders and the index for a query. With no query, the known
 * folders as they stand. A folder in both counts as known, so it keeps its pin.
 *
 * @returns {Array<{item: {path: string, name: string, source: string},
 *          name: string, rel: string, nameRanges: number[][], relRanges: number[][]}>}
 */
export function searchFolders(query, known, index = [], limit = 60) {
    if (!String(query || '').trim()) {
        return known.slice(0, limit).map((item) => ({
            item, name: item.name, rel: String(item.path).replace(/\\/g, '/'),
            nameRanges: [], relRanges: [],
        }));
    }
    const knownEntries = prepareEntries(known, '');
    const knownKeys = new Set(knownEntries.map((e) => e.key));
    const entries = [...knownEntries, ...index.filter((e) => !knownKeys.has(e.key))];
    return rankFiles(query, entries, { limit, recent: known.map((k) => k.path) });
}

/**
 * The key combination a keydown describes, in the form the backend registers
 * (`Ctrl+Shift+KeyE`). Null until it is a usable one: a lone modifier is someone
 * still pressing, and a bare letter would stop that letter being typable anywhere.
 */
export function hotkeyFromEvent(e) {
    if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code || '')) return null;
    if (!e.code || e.code === 'Unidentified') return null;
    const parts = [];
    if (e.metaKey) parts.push('Super');
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (!parts.length && !/^F\d+$/.test(e.code)) return null;
    return [...parts, e.code].join('+');
}

/** `Super+Shift+KeyE` as it is written on the keyboard: `Win+Shift+E`. */
export function formatHotkey(hotkey) {
    return String(hotkey || '').split('+').map((part) => {
        if (part === 'Super') return 'Win';
        return part.replace(/^Key([A-Z])$/, '$1').replace(/^Digit(\d)$/, '$1');
    }).join('+');
}
