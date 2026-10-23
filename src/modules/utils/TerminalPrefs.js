/**
 * TerminalPrefs.js — how many lines a terminal keeps for scrolling back.
 *
 * xterm keeps 1000 by default, which a long build or test run fills in
 * seconds: the start of the log, usually where the first error is, was gone by
 * the time it finished. The default here is ten times that, and Settings can
 * raise it further. Each line costs memory per terminal, hence the ceiling.
 */
const KEY = 'settings_terminalScrollback';

export const SCROLLBACK_DEFAULT = 10000;
export const SCROLLBACK_MIN = 1000;
export const SCROLLBACK_MAX = 200000;

/** Clamp anything typed into a usable line count. */
export function normalizeScrollback(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return SCROLLBACK_DEFAULT;
    return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, n));
}

export function terminalScrollback() {
    try {
        const raw = localStorage.getItem(KEY);
        return raw == null ? SCROLLBACK_DEFAULT : normalizeScrollback(raw);
    } catch (_) {
        return SCROLLBACK_DEFAULT;
    }
}

/** Store the setting; returns the value actually kept. */
export function setTerminalScrollback(value) {
    const n = normalizeScrollback(value);
    try {
        localStorage.setItem(KEY, String(n));
    } catch (_) { /* ignore */ }
    return n;
}
