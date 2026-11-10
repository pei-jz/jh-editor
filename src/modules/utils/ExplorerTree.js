/**
 * ExplorerTree.js — the tree's small decisions, apart from its DOM.
 */

/**
 * Which row typing `typed` lands on, or -1. One letter, or the same letter
 * again and again, steps through the names starting with it; more letters
 * spell one name, so the row already on it stays if it still fits.
 */
export function typeAheadIndex(names, typed, current) {
    if (!typed || !names.length) return -1;
    const lower = typed.toLowerCase();
    const stepping = [...lower].every((c) => c === lower[0]);
    const needle = stepping ? lower[0] : lower;
    const start = stepping ? current + 1 : Math.max(current, 0);
    for (let i = 0; i < names.length; i++) {
        const index = (start + i) % names.length;
        if (names[index].toLowerCase().startsWith(needle)) return index;
    }
    return -1;
}

/** yyyy/mm/dd hh:mm, or nothing when the filesystem gave no time. */
export function formatModified(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
