/**
 * ThemeInfo.js — one answer to "is the current theme dark?"
 *
 * Four places used to decide this with their own hand-written allowlist of
 * theme classes: the Mermaid renderer, the Shiki highlighter, the CodeMirror
 * syntax palette and the terminal. Every theme added since drifted out of one
 * list or another, and the symptom is always the same — a light palette drawn
 * on a dark surface, or the reverse, at 1–2:1 contrast.
 *
 * Themes carry no "dark" flag of their own, so this is still a list. The point
 * is that it is now ONE list: adding a theme means editing this file, and every
 * consumer follows.
 *
 * A theme belongs here when its EDITOR SURFACE (--bg-color) is dark. Hanging
 * Scroll is deliberately absent: its mounting is indigo but the sheet you read
 * is moon-white silk, so code, diagrams and Markdown all want light palettes.
 */
const DARK_THEMES = [
    'theme-dark',
    'theme-midnight',
    'theme-solarized-dark',
    'theme-bamboo-ancient',
    'theme-nord',
    'dark-mode',        // legacy class, still set by some older paths
];

/** @returns {boolean} true when the editor surface is dark. */
export function isDarkTheme() {
    if (typeof document === 'undefined' || !document.body) return false;
    const c = document.body.classList;
    return DARK_THEMES.some((t) => c.contains(t));
}

/** The theme classes considered dark. Exported for tests and diagnostics. */
export { DARK_THEMES };
