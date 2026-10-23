/**
 * WorkspaceTheme.js — a theme per workspace, on top of the global one.
 *
 * With two or three windows open on different projects, they all looked the
 * same and the only way to tell them apart was to read the title bar. A
 * workspace can now carry its own theme; one without keeps following the
 * global setting, so nothing changes for anyone who never sets it.
 *
 * Stored in localStorage, which every window shares: set it in one window and
 * the next window that opens that workspace picks it up.
 */
import { DEFAULT_THEME, isKnownTheme } from './Themes.js';

const MAP_KEY = 'workspaceThemes';

/** The key a workspace is stored under: separators and case do not make two workspaces. */
export function workspaceKey(dir) {
    return String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function readMap() {
    try {
        const raw = localStorage.getItem(MAP_KEY);
        const map = raw ? JSON.parse(raw) : {};
        return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch (_) {
        return {};
    }
}

function writeMap(map) {
    try {
        localStorage.setItem(MAP_KEY, JSON.stringify(map));
    } catch (_) { /* private mode: the choice lasts this session only */ }
}

/** The theme set in Settings for every window. */
export function globalTheme() {
    try {
        return localStorage.getItem('theme') || DEFAULT_THEME;
    } catch (_) {
        return DEFAULT_THEME;
    }
}

export function setGlobalTheme(theme) {
    try {
        localStorage.setItem('theme', theme);
    } catch (_) { /* ignore */ }
}

/** The theme `dir` has of its own, or null when it follows the global one. */
export function workspaceTheme(dir) {
    if (!dir) return null;
    const theme = readMap()[workspaceKey(dir)];
    // A theme that has since been removed falls back to the global one rather
    // than to no theme at all.
    return typeof theme === 'string' && isKnownTheme(theme) ? theme : null;
}

/** Give `dir` its own theme; null (or '') makes it follow the global one again. */
export function setWorkspaceTheme(dir, theme) {
    if (!dir) return;
    const map = readMap();
    const key = workspaceKey(dir);
    if (theme) map[key] = theme;
    else delete map[key];
    writeMap(map);
}

/** What a window on `dir` shows: the workspace's own theme, else the global one. */
export function effectiveTheme(dir) {
    return workspaceTheme(dir) || globalTheme();
}

// The theme actually on screen. Readers (the terminal's palette, for one) ask
// this rather than localStorage, which holds only the global setting.
let applied = null;

export function noteAppliedTheme(theme) {
    applied = theme;
}

export function appliedTheme() {
    return applied || globalTheme();
}
