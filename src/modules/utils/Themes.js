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
 *
 * What the user picks is a FAMILY plus a mode (light / dark / follow the OS).
 * Every family has exactly one light and one dark theme, so "the dark one of
 * Hanging Scroll" always exists and the mode never has to be greyed out. The
 * themes themselves — ids, classes, palettes — are unchanged by this: a
 * family is only a way of grouping them.
 */

/**
 * @typedef {object} Theme
 * @property {string} id      the value stored in localStorage; the class is `theme-<id>`
 * @property {string} family  the Family it is the light or dark half of
 * @property {boolean} dark   is the EDITOR SURFACE dark? Drives syntax palettes,
 *                            and picks which half of the family this is.
 * @property {string} bootBg  pre-stylesheet background, mirrored in index.html
 */

/**
 * @typedef {object} Family
 * @property {string} id     stored for a workspace's own theme
 * @property {string} label  English name; also the i18n key
 */

/** In picker order. @type {Family[]} */
export const FAMILIES = [
    { id: 'standard', label: 'Standard' },
    { id: 'paper', label: 'Paper' },
    { id: 'sumi-e', label: 'Ink Brush' },
    { id: 'kakejiku', label: 'Hanging Scroll' },
    { id: 'bamboo', label: 'Bamboo Slip' },
    { id: 'coffee', label: 'Coffee' },
    { id: 'nord', label: 'Nord' },
    { id: 'solarized', label: 'Solarized' },
];

/** @type {Theme[]} */
export const THEMES = [
    // `light` is the bare `:root` palette — it has no class of its own, which
    // is why applyTheme treats it as "remove them all and add nothing".
    { id: 'light', family: 'standard', dark: false, bootBg: '#ffffff' },
    { id: 'dark', family: 'standard', dark: true, bootBg: '#1e1e22' },
    { id: 'paper', family: 'paper', dark: false, bootBg: '#e7dab9' },
    { id: 'paper-dark', family: 'paper', dark: true, bootBg: '#221a13' },
    { id: 'sumi-e', family: 'sumi-e', dark: false, bootBg: '#ece8df' },
    { id: 'sumi-e-dark', family: 'sumi-e', dark: true, bootBg: '#0f0f0f' },
    // Hanging Scroll is deliberately NOT dark: its mounting is indigo, but the
    // sheet you actually read is moon-white silk, so code, diagrams and
    // Markdown all want light palettes.
    { id: 'kakejiku', family: 'kakejiku', dark: false, bootBg: '#e8edf1' },
    // 夜の掛軸: the same hanging scroll at night — deep indigo silk with a
    // gold-damask mount and a vermillion seal brightened for the dark ground.
    { id: 'kakejiku-dark', family: 'kakejiku', dark: true, bootBg: '#232c3f' },
    // Fresh green slips, the same bundle before it was buried.
    { id: 'bamboo-light', family: 'bamboo', dark: false, bootBg: '#e2e4cf' },
    { id: 'bamboo-ancient', family: 'bamboo', dark: true, bootBg: '#2f2518' },
    // Catppuccin Latte and Mocha.
    { id: 'latte', family: 'coffee', dark: false, bootBg: '#f0e8d0' },
    { id: 'latte-dark', family: 'coffee', dark: true, bootBg: '#1e1e2e' },
    // Nord's Snow Storm greys, with the Frost and Aurora inks darkened to read.
    { id: 'nord-light', family: 'nord', dark: false, bootBg: '#e5e9f0' },
    { id: 'nord', family: 'nord', dark: true, bootBg: '#3b4252' },
    { id: 'solarized-light', family: 'solarized', dark: false, bootBg: '#fdf6e3' },
    { id: 'solarized-dark', family: 'solarized', dark: true, bootBg: '#002b36' },
];

/** Legacy class some older paths still set; treated as dark. */
export const LEGACY_DARK_CLASS = 'dark-mode';

export const DEFAULT_THEME = 'kakejiku';

/**
 * Themes that were removed, and what a saved setting naming one becomes.
 * index.html and Layout.js both migrate at startup; the boot script cannot
 * import this, so it repeats the table and a test holds the two together.
 */
export const RETIRED_THEMES = {
    // The same sheet as Ink Brush, 6 RGB units apart.
    'paper-subtle': 'sumi-e',
    // A violet-accented dark navy with no light half. Mocha is the same night
    // and has Latte.
    midnight: 'latte-dark',
};

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

/** Is `id` a family this build knows about? */
export function isKnownFamily(id) {
    return FAMILIES.some((f) => f.id === id);
}

/**
 * The family a stored value means. Workspaces stored a theme id before they
 * stored a family, so either is accepted; anything else is null.
 */
export function familyOf(value) {
    if (isKnownFamily(value)) return value;
    const id = RETIRED_THEMES[value] || value;
    const th = THEMES.find((t) => t.id === id);
    return th ? th.family : null;
}

/** The light or dark half of `family`. */
export function variantOf(family, dark) {
    const fam = isKnownFamily(family) ? family : themeById(DEFAULT_THEME).family;
    return THEMES.find((t) => t.family === fam && t.dark === !!dark).id;
}

export default {
    THEMES, FAMILIES, themeClasses, darkThemeClasses, themeById, isKnownTheme,
    isKnownFamily, familyOf, variantOf, DEFAULT_THEME, RETIRED_THEMES,
};
