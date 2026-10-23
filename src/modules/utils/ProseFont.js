/**
 * ProseFont.js — the face rendered Markdown is set in.
 *
 * The default lives in themes.css as --font-body, with :lang() variants for
 * Chinese and Korean. Choosing the default therefore REMOVES the override
 * rather than writing Meiryo over it, so a Chinese UI keeps its own face.
 *
 * Readability differs a great deal between readers. Meiryo measured darkest
 * on a 100%-scaled Windows screen and is the default; the others are here for
 * the reader who finds one of them easier, the textbook face above all, which
 * was drawn for readers who find ordinary type hard going.
 *
 * Latin runs come first in each stack where the Japanese face's own Latin is
 * weak: the textbook and mincho faces carry their Latin as an afterthought.
 */

const KEY = 'settings_proseFont';

export const DEFAULT_PROSE_FONT = 'meiryo';

/** id → font-family stack. `null` means "the stylesheet's own default". */
export const PROSE_FONTS = {
    meiryo: null,
    'yu-gothic': "'Segoe UI', 'Yu Gothic UI', 'Yu Gothic', '游ゴシック', 'Hiragino Sans', sans-serif",
    'biz-ud-gothic': "'Segoe UI', 'BIZ UDPGothic', 'BIZ UDPゴシック', 'Hiragino Sans', sans-serif",
    'ud-kyokasho': "'Segoe UI', 'UD Digi Kyokasho NP', 'UD デジタル 教科書体 NP', 'Hiragino Sans', sans-serif",
    mincho: "'Georgia', 'BIZ UDPMincho', 'BIZ UDP明朝', 'Yu Mincho', '游明朝', 'Hiragino Mincho ProN', 'Noto Serif JP', serif",
};

/** Anything unknown — an old value, a typo in storage — is the default. */
export function normalizeProseFont(id) {
    return Object.prototype.hasOwnProperty.call(PROSE_FONTS, id) ? id : DEFAULT_PROSE_FONT;
}

/** The configured face id. */
export function getProseFont() {
    try {
        return normalizeProseFont(localStorage.getItem(KEY));
    } catch (_) {
        return DEFAULT_PROSE_FONT;
    }
}

/** Put a face on the page. */
export function applyProseFont(id, root = document.documentElement) {
    const stack = PROSE_FONTS[normalizeProseFont(id)];
    if (stack) root.style.setProperty('--font-body', stack);
    else root.style.removeProperty('--font-body');
}

/** Store and apply. Returns the id actually stored. */
export function setProseFont(id) {
    const value = normalizeProseFont(id);
    try {
        localStorage.setItem(KEY, value);
    } catch (_) { /* storage unavailable: the choice still applies for now */ }
    applyProseFont(value);
    return value;
}

/*
 * The size. Left unset, themes.css derives it from the editor size with a
 * 15px floor — the floor is for the default only. A reader who wants smaller
 * documents sets a size here, and an explicit size is taken as given.
 */
const SIZE_KEY = 'settings_proseFontSize';

/** The narrowest and widest a document may be set, in points. */
export const MIN_PROSE_PT = 6;
export const MAX_PROSE_PT = 32;

/** A size in points, or `null` for "automatic". Blank and junk are automatic. */
export function normalizeProseSize(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(MAX_PROSE_PT, Math.max(MIN_PROSE_PT, Math.round(n * 2) / 2));
}

/** The configured size in points, or `null` for automatic. */
export function getProseSize() {
    try {
        return normalizeProseSize(localStorage.getItem(SIZE_KEY));
    } catch (_) {
        return null;
    }
}

/** Put a size on the page; `null` hands it back to the stylesheet. */
export function applyProseSize(pt, root = document.documentElement) {
    const value = normalizeProseSize(pt);
    if (value === null) root.style.removeProperty('--prose-font-size');
    else root.style.setProperty('--prose-font-size', `${value}pt`);
}

/** The size documents are set in right now, in points, automatic or not. */
export function currentProseSizePt(root = document.documentElement) {
    // The custom property holds an expression (max(calc(...), 15px)); only an
    // element using it resolves it to a length.
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--prose-font-size);';
    (root === document.documentElement ? document.body : root).appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return Number.isFinite(px) && px > 0 ? px * 0.75 : 12;
}

/**
 * Ctrl+wheel over a document. Starts from the size on screen, so the first
 * notch out of "automatic" moves by one step rather than jumping to wherever
 * the stored value happened to be — and from then on the size is explicit,
 * free of the automatic 15px floor.
 */
export function stepProseSize(deltaPt) {
    const base = getProseSize() ?? Math.round(currentProseSizePt() * 2) / 2;
    return setProseSize(base + deltaPt);
}

/** Store and apply. Returns the size actually stored, or `null`. */
export function setProseSize(pt) {
    const value = normalizeProseSize(pt);
    try {
        if (value === null) localStorage.removeItem(SIZE_KEY);
        else localStorage.setItem(SIZE_KEY, String(value));
    } catch (_) { /* storage unavailable: the choice still applies for now */ }
    applyProseSize(value);
    return value;
}
