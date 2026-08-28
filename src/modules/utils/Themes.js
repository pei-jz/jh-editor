/**
 * Themes.js — the one place that knows a theme exists.
 *
 * Adding a theme used to mean editing five things, and forgetting any one of
 * them failed quietly:
 *
 *   themes.css                    the palette itself
 *   ThemeInfo.js                  is it dark? (syntax, mermaid, terminal)
 *   SettingsModal.applyTheme      the class-removal list
 *   index.html                    the <select>, AND the anti-flash colour map
 *   locales/*.js                  the visible name
 *
 * Miss the dark flag and the editor draws a light syntax palette on a dark
 * sheet. Miss the removal list and two theme classes stay on <body> at once,
 * so the palette depends on stylesheet order. Neither throws.
 *
 * So: one array. The picker is built from it, `applyTheme` derives its removal
 * list from it, `isDarkTheme` reads it, and a test checks that the CSS and the
 * dictionaries have kept up.
 *
 * `bootBg` exists because index.html paints a background BEFORE any stylesheet
 * loads, to avoid a white flash on a dark theme. That script runs before
 * modules, so it cannot import this file — the value is duplicated there and
 * the duplication is test-enforced rather than trusted.
 */

/**
 * @typedef {object} Theme
 * @property {string} id      the value stored in localStorage; the class is `theme-<id>`
 * @property {string} label   English name; also the i18n key
 * @property {boolean} dark   is the EDITOR SURFACE dark? Drives syntax palettes.
 * @property {string} bootBg  pre-stylesheet background, mirrored in index.html
 */

/** @type {Theme[]} */
export const THEMES = [
    // `light` is the bare `:root` palette — it has no class of its own, which
    // is why applyTheme treats it as "remove them all and add nothing".
    { id: 'light', label: 'Light', dark: false, bootBg: '#ffffff' },
    { id: 'dark', label: 'Dark', dark: true, bootBg: '#1e1e22' },
    { id: 'midnight', label: 'Midnight', dark: true, bootBg: '#0f0f11' },
    { id: 'latte', label: 'Latte', dark: false, bootBg: '#f0e8d0' },
    { id: 'solarized-dark', label: 'Solarized Dark', dark: true, bootBg: '#002b36' },
    { id: 'solarized-light', label: 'Solarized Light', dark: false, bootBg: '#fdf6e3' },
    { id: 'paper', label: 'Paper', dark: false, bootBg: '#e7dab9' },
    { id: 'bamboo-ancient', label: 'Bamboo Slip', dark: true, bootBg: '#2f2518' },
    { id: 'sumi-e', label: 'Ink Brush', dark: false, bootBg: '#ece8df' },
    { id: 'nord', label: 'Nord', dark: true, bootBg: '#3b4252' },
    // Hanging Scroll is deliberately NOT dark: its mounting is indigo, but the
    // sheet you actually read is moon-white silk, so code, diagrams and
    // Markdown all want light palettes.
    { id: 'kakejiku', label: 'Hanging Scroll', dark: false, bootBg: '#e8edf1' },
];

/** Legacy class some older paths still set; treated as dark. */
export const LEGACY_DARK_CLASS = 'dark-mode';

export const DEFAULT_THEME = 'dark';

/** Every `theme-<id>` class, for the removal list. `light` has none. */
export function themeClasses() {
    return THEMES.filter((t) => t.id !== 'light').map((t) => `theme-${t.id}`);
}

/** The classes whose editor surface is dark. */
export function darkThemeClasses() {
    return THEMES.filter((t) => t.dark).map((t) => `theme-${t.id}`).concat(LEGACY_DARK_CLASS);
}

/** Look a theme up by id. Unknown ids fall back to the default. */
export function themeById(id) {
    return THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === DEFAULT_THEME);
}

/** Is `id` a theme this build knows about? */
export function isKnownTheme(id) {
    return THEMES.some((t) => t.id === id);
}

export default { THEMES, themeClasses, darkThemeClasses, themeById, isKnownTheme, DEFAULT_THEME };
