/**
 * WorkspaceTheme.js — which theme a window shows: the family, the mode, and a
 * family per workspace on top of the global one.
 *
 * With two or three windows open on different projects, they all looked the
 * same and the only way to tell them apart was to read the title bar. A
 * workspace can now carry its own theme; one without keeps following the
 * global setting, so nothing changes for anyone who never sets it.
 *
 * A workspace picks a FAMILY only. Light or dark is one decision for every
 * window — otherwise, with the mode following the OS, some windows would turn
 * dark at sunset and others would not.
 *
 * Stored in localStorage, which every window shares: set it in one window and
 * the next window that opens that workspace picks it up.
 *
 *   theme               the global theme id, as before. Its family is the
 *                       global family, and while the mode is fixed its half
 *                       (light or dark) is the mode.
 *   themeFollowSystem   'true' when the mode follows the OS. Missing on an
 *                       install from before the mode existed; see followSystem.
 *   workspaceThemes     { workspaceKey: familyId }. Older entries hold a theme
 *                       id, which is read as that theme's family.
 */
import { DEFAULT_THEME, themeById, familyOf, variantOf } from './Themes.js';

const MAP_KEY = 'workspaceThemes';
const FOLLOW_KEY = 'themeFollowSystem';

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

function read(key) {
    try {
        return localStorage.getItem(key);
    } catch (_) {
        return null;
    }
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
    // Settle the mode before the first theme is written: followSystem reads
    // "no theme saved yet" as a new install, and that stops being true here.
    if (read(FOLLOW_KEY) === null) {
        try { localStorage.setItem(FOLLOW_KEY, String(followSystem())); } catch (_) { /* ignore */ }
    }
    try {
        localStorage.setItem('theme', theme);
    } catch (_) { /* ignore */ }
}

/** The family set in Settings for every window. */
export function globalFamily() {
    return themeById(globalTheme()).family;
}

/** Switch the global family, keeping whichever half is showing. */
export function setGlobalFamily(family) {
    setGlobalTheme(variantOf(family, themeById(globalTheme()).dark));
}

/**
 * Does the mode follow the OS? A new install does — index.html makes the same
 * call before any module loads, so the two must agree. An install that
 * already had a theme saved keeps the one it chose.
 */
export function followSystem() {
    const v = read(FOLLOW_KEY);
    if (v !== null) return v === 'true';
    return read('theme') === null;
}

/** 'light' | 'dark' | 'system' */
export function themeMode() {
    if (followSystem()) return 'system';
    return themeById(globalTheme()).dark ? 'dark' : 'light';
}

export function setThemeMode(mode) {
    try {
        localStorage.setItem(FOLLOW_KEY, String(mode === 'system'));
    } catch (_) { /* ignore */ }
    if (mode === 'light' || mode === 'dark') {
        setGlobalTheme(variantOf(globalFamily(), mode === 'dark'));
    }
}

/** Is the OS in dark mode? Light where the webview cannot say. */
export function systemPrefersDark() {
    try {
        return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    } catch (_) {
        return false;
    }
}

/** The family `dir` has of its own, or null when it follows the global one. */
export function workspaceTheme(dir) {
    if (!dir) return null;
    // A theme that has since been removed falls back to the global one rather
    // than to no theme at all.
    return familyOf(readMap()[workspaceKey(dir)]);
}

/** Give `dir` its own family; null (or '') makes it follow the global one again. */
export function setWorkspaceTheme(dir, family) {
    if (!dir) return;
    const map = readMap();
    const key = workspaceKey(dir);
    if (family) map[key] = family;
    else delete map[key];
    writeMap(map);
}

/** The theme id a window on `dir` shows. */
export function effectiveTheme(dir) {
    const family = workspaceTheme(dir) || globalFamily();
    const dark = followSystem() ? systemPrefersDark() : themeById(globalTheme()).dark;
    return variantOf(family, dark);
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
