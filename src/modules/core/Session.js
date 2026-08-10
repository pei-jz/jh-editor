import { State } from './Store.js';

/**
 * Session.js — restore what the user was doing, and never lose unsaved work.
 *
 * Two independent mechanisms:
 *
 *  1. SESSION  — which tabs were open (per workspace), the active one, and the
 *     view mode. Saved on change, restored on startup. Only stores metadata;
 *     file content is re-read from disk.
 *
 *  2. DRAFTS   — the actual text of *unsaved* buffers, written on a short timer.
 *     This is crash/kill recovery: on restore, a dirty buffer comes back with
 *     the user's edits intact instead of the on-disk version. Untitled (never
 *     saved) buffers are kept too, since they have no disk copy at all.
 *
 * Writing to disk behind the user's back is deliberately NOT done by default —
 * "auto-save" here means "your work survives a crash", not "your file is
 * silently overwritten". A opt-in setting enables true auto-save-to-disk.
 */

const SESSION_KEY = 'jh_session_v1';
const DRAFTS_KEY = 'jh_drafts_v1';
const DRAFT_DEBOUNCE_MS = 1200;
// Guard localStorage: a few very large dirty buffers must not blow the quota.
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;   // per buffer
const MAX_DRAFTS_TOTAL = 8 * 1024 * 1024;  // all buffers

let _draftTimer = null;
let _sessionTimer = null;
let _enabled = true;
let _suspended = 0;

/** Session entries are scoped per workspace so switching projects is clean. */
function _wsKey() {
    return String(State.currentDir || '(none)');
}

function _readJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
        return fallback;
    }
}

function _writeJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (e) {
        console.warn('[Session] persist failed (quota?):', e && e.message);
        return false;
    }
}

/** True when a file is a real, restorable on-disk document. */
function _isRestorable(f) {
    if (!f || !f.path) return false;
    // Virtual tabs (diff / compare / search results / agent / ai output) have
    // no disk backing — re-opening them would be meaningless or misleading.
    if (f.type && f.type !== 'file') return false;
    if (f.viewMode === 'diff' || f.viewMode === 'compare') return false;
    return !/^(search|ai):\/\//.test(f.path);
}

function _describe(f) {
    return {
        path: f.path,
        viewMode: f.viewMode || null,
        encoding: f.encoding || null,
    };
}

// ── Session (open tabs) ──────────────────────────────────────────────────────

export function saveSession() {
    if (!_enabled || _suspended > 0) return;
    const all = _readJson(SESSION_KEY, {});
    all[_wsKey()] = {
        savedAt: Date.now(),
        left: State.openFiles.filter(_isRestorable).map(_describe),
        activeIndex: State.activeTabIndex,
        right: State.rightOpenFiles.filter(_isRestorable).map(_describe),
        rightActiveIndex: State.rightActiveTabIndex,
        splitMode: State.splitMode,
    };
    _writeJson(SESSION_KEY, all);
}

export function loadSession() {
    const all = _readJson(SESSION_KEY, {});
    return all[_wsKey()] || null;
}

export function clearSession() {
    const all = _readJson(SESSION_KEY, {});
    delete all[_wsKey()];
    _writeJson(SESSION_KEY, all);
}

// ── Drafts (unsaved content) ─────────────────────────────────────────────────

/** Stable id for a buffer: its path, or a per-tab id for untitled buffers. */
function _draftId(file) {
    if (file.path) return file.path;
    if (!file._draftId) {
        file._draftId = `untitled:${file.name || 'Untitled'}:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    }
    return file._draftId;
}

export function saveDrafts() {
    if (!_enabled || _suspended > 0) return;
    const drafts = {};
    let total = 0;
    const collect = (files) => {
        for (const f of files) {
            if (!f || !f.isDirty || typeof f.content !== 'string') continue;
            if (f.type && f.type !== 'file') continue;
            if (f.isLarge) continue; // never held fully in memory anyway
            const size = f.content.length;
            if (size > MAX_DRAFT_BYTES || total + size > MAX_DRAFTS_TOTAL) continue;
            total += size;
            drafts[_draftId(f)] = {
                content: f.content,
                name: f.name || null,
                path: f.path || null,
                encoding: f.encoding || 'UTF-8',
                eol: f.eol || '\n',
                savedAt: Date.now(),
                workspace: _wsKey(),
            };
        }
    };
    collect(State.openFiles);
    collect(State.rightOpenFiles);
    _writeJson(DRAFTS_KEY, drafts);
}

export function loadDrafts() {
    return _readJson(DRAFTS_KEY, {});
}

/** Forget a buffer's draft (called once it is saved to disk or closed clean). */
export function dropDraft(file) {
    if (!file) return;
    const drafts = _readJson(DRAFTS_KEY, {});
    const id = file.path || file._draftId;
    if (id && drafts[id]) {
        delete drafts[id];
        _writeJson(DRAFTS_KEY, drafts);
    }
}

export function clearDrafts() {
    _writeJson(DRAFTS_KEY, {});
}

// ── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Called from the editor whenever tabs or buffer content change.
 * Session metadata is cheap → written immediately. Draft text is debounced so
 * typing doesn't serialise the whole buffer on every keystroke.
 */
export function scheduleSessionSave() {
    if (!_enabled || _suspended > 0) return;
    // Both debounced: renderTabs() runs on every keystroke, and neither the
    // metadata nor the draft text needs to be written that often.
    clearTimeout(_sessionTimer);
    _sessionTimer = setTimeout(() => saveSession(), 400);
    clearTimeout(_draftTimer);
    _draftTimer = setTimeout(() => saveDrafts(), DRAFT_DEBOUNCE_MS);
}

/** Flush immediately (window close / before reload). */
export function flushSession() {
    if (!_enabled) return;
    clearTimeout(_sessionTimer);
    clearTimeout(_draftTimer);
    saveSession();
    saveDrafts();
}

/**
 * Stop persisting until resume(). Used while switching workspaces: closing the
 * old project's tabs would otherwise overwrite ITS saved session with an empty
 * list before State.currentDir moves to the new project.
 * Re-entrant (counted), so nested suspends are safe.
 */
export function suspend() {
    _suspended++;
    clearTimeout(_sessionTimer);
    clearTimeout(_draftTimer);
}

export function resume() {
    if (_suspended > 0) _suspended--;
}

export function setEnabled(on) {
    _enabled = !!on;
}

export function isEnabled() {
    return _enabled;
}
