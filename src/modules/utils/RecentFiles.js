/**
 * RecentFiles.js — recently opened files & workspaces (Phase 3).
 *
 * Files are recorded as they are opened (Editor.openFile calls recordFile).
 * Workspaces are already recorded by WelcomeScreen under `jheditor_recent_workspaces`;
 * this module reuses that key so the two surfaces never disagree. Both lists are
 * surfaced through the command palette for quick switching.
 */

const FILES_KEY = 'jheditor_recent_files';
const MAX_FILES = 15;

function readFiles() {
    try {
        const raw = localStorage.getItem(FILES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((p) => typeof p === 'string');
    } catch (_) { return []; }
}

function writeFiles(list) {
    try { localStorage.setItem(FILES_KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
}

const WORKSPACES_KEY = 'jheditor_recent_workspaces';
/** Enough to switch between the projects someone actually works in. It was 5,
 *  when the list only lived on the Welcome screen. */
const MAX_WORKSPACES = 10;

function readWorkspaces() {
    try {
        const raw = localStorage.getItem(WORKSPACES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
    } catch (_) { return []; }
}

function writeWorkspaces(list) {
    try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
}

/** Same folder whichever way its slashes or drive letter were written. */
export function sameWorkspace(a, b) {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return !!a && !!b && norm(a) === norm(b);
}

export const RecentFiles = {
    getFiles: readFiles,
    getWorkspaces: readWorkspaces,

    /**
     * Record a workspace as just opened (most recent first, de-duped).
     * Called on every switch, not only from the Welcome screen: the explorer's
     * folder button opened workspaces without ever adding them here.
     */
    recordWorkspace(path) {
        if (!path) return;
        const next = [path, ...readWorkspaces().filter((p) => !sameWorkspace(p, path))]
            .slice(0, MAX_WORKSPACES);
        writeWorkspaces(next);
    },

    forgetWorkspace(path) {
        writeWorkspaces(readWorkspaces().filter((p) => !sameWorkspace(p, path)));
    },

    /** Record a file as recently opened (most recent first, de-duped). */
    recordFile(path) {
        if (!path || /^([a-z]+):\/\//i.test(path)) return; // skip virtual tabs
        const list = readFiles();
        const next = [path, ...list.filter((p) => p !== path)].slice(0, MAX_FILES);
        writeFiles(next);
    },

    clearFiles() {
        writeFiles([]);
    },
};
