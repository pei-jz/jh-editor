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

const DOCK_KEY = 'terminal_dock';
const WIDTH_KEY = 'terminal_right_width';

export const TERMINAL_WIDTH_DEFAULT = 480;
export const TERMINAL_WIDTH_MIN = 240;
const TERMINAL_EDITOR_KEEP = 280;

/** Where the panel sits: 'bottom' (the default) or 'right'. */
export function terminalDock() {
    try {
        return localStorage.getItem(DOCK_KEY) === 'right' ? 'right' : 'bottom';
    } catch (_) {
        return 'bottom';
    }
}

export function setTerminalDock(dock) {
    try { localStorage.setItem(DOCK_KEY, dock === 'right' ? 'right' : 'bottom'); } catch (_) { /* ignore */ }
}

/**
 * Keep a right-docked panel usable without taking the editors' room: `room` is
 * the width beside the explorer, and the editors keep a share of it.
 */
export function clampTerminalWidth(width, room) {
    const n = Number(width);
    const wanted = Number.isFinite(n) && n > 0 ? n : TERMINAL_WIDTH_DEFAULT;
    return Math.round(Math.max(TERMINAL_WIDTH_MIN, Math.min(wanted, room - TERMINAL_EDITOR_KEEP)));
}

export function terminalRightWidth(room) {
    let raw = null;
    try { raw = localStorage.getItem(WIDTH_KEY); } catch (_) { /* default */ }
    return clampTerminalWidth(raw, room);
}

export function setTerminalRightWidth(width) {
    try { localStorage.setItem(WIDTH_KEY, String(Math.round(width))); } catch (_) { /* ignore */ }
}

/** Store the setting; returns the value actually kept. */
export function setTerminalScrollback(value) {
    const n = normalizeScrollback(value);
    try {
        localStorage.setItem(KEY, String(n));
    } catch (_) { /* ignore */ }
    return n;
}
