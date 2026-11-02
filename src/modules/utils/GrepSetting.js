/**
 * GrepSetting.js — how many results one search collects before it stops.
 *
 * The limit is on the whole search, across all its files, and a line counts once.
 * It exists for the results tab: every result is rows in the DOM, so a search
 * that matches everything has to stop somewhere the tab can still draw. Where
 * that is depends on the machine and on what is being looked for, so it is a
 * setting, with the old constant as the default.
 *
 * In its own module so the search dialog and the settings screen can both read it
 * without importing each other.
 */

const KEY = 'settings_grepMaxMatches';

export const DEFAULT_GREP_MAX_MATCHES = 5000;
export const MIN_GREP_MAX_MATCHES = 100;
export const MAX_GREP_MAX_MATCHES = 100000;

/** Coerce anything to a usable limit. Nothing entered means the default, not 0. */
export function normalizeGrepMaxMatches(value) {
    if (value === null || value === undefined) return DEFAULT_GREP_MAX_MATCHES;
    if (typeof value === 'string' && !value.trim()) return DEFAULT_GREP_MAX_MATCHES;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_GREP_MAX_MATCHES;
    return Math.min(MAX_GREP_MAX_MATCHES, Math.max(MIN_GREP_MAX_MATCHES, n));
}

export function getGrepMaxMatches() {
    try {
        return normalizeGrepMaxMatches(localStorage.getItem(KEY));
    } catch (_) {
        return DEFAULT_GREP_MAX_MATCHES;
    }
}

/** Store a new limit. Returns the value actually stored. */
export function setGrepMaxMatches(value) {
    const limit = normalizeGrepMaxMatches(value);
    try { localStorage.setItem(KEY, String(limit)); } catch (_) { /* ignore */ }
    return limit;
}
