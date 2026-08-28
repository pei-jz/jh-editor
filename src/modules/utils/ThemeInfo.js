import { darkThemeClasses } from './Themes.js';

/**
 * ThemeInfo.js — one answer to "is the current theme dark?"
 *
 * Four places used to decide this with their own hand-written allowlist of
 * theme classes: the Mermaid renderer, the syntax highlighter, the CodeMirror
 * syntax palette and the terminal. Every theme added since drifted out of one
 * list or another, and the symptom is always the same — a light palette drawn
 * on a dark surface, or the reverse, at 1–2:1 contrast.
 *
 * The list itself has since moved again, into `Themes.js`, where the palette,
 * the picker and this flag are declared together — a theme cannot now be added
 * without saying whether it is dark.
 *
 * A theme counts as dark when its EDITOR SURFACE (--bg-color) is dark.
 */

/** @returns {boolean} true when the editor surface is dark. */
export function isDarkTheme() {
    if (typeof document === 'undefined' || !document.body) return false;
    const c = document.body.classList;
    return darkThemeClasses().some((t) => c.contains(t));
}

/** The theme classes considered dark. Exported for tests and diagnostics. */
export const DARK_THEMES = darkThemeClasses();
