/**
 * PaletteQuery.js — what the unified palette is being asked to find.
 *
 * One input box, and its first character picks the kind of thing searched:
 * nothing for files, `@` for open tabs, `>` for commands, `#` for symbols in
 * the current file, `:` for a line number and `?` for text across the
 * workspace. The old dedicated shortcuts (Ctrl+T, Ctrl+Shift+P, …) open the
 * palette with their prefix already typed, so muscle memory still works and a
 * Backspace turns any of them into a file search.
 *
 * Plain data and pure functions, so the parsing is unit-tested without a DOM.
 */

export const MODES = [
    { id: 'files', prefix: '', label: 'Files', icon: 'file', placeholder: 'Search files by name…' },
    { id: 'tabs', prefix: '@', label: 'Tabs', icon: 'layout-columns', placeholder: 'Search open tabs…' },
    { id: 'commands', prefix: '>', label: 'Commands', icon: 'command', placeholder: 'Type a command…' },
    { id: 'symbols', prefix: '#', label: 'Symbols', icon: 'list', placeholder: 'Search headings and functions…' },
    { id: 'line', prefix: ':', label: 'Line', icon: 'chevron-right', placeholder: 'Line number…' },
    { id: 'grep', prefix: '?', label: 'Text', icon: 'search', placeholder: 'Search text in the workspace…' },
];

const BY_PREFIX = new Map(MODES.filter((m) => m.prefix).map((m) => [m.prefix, m]));
const BY_ID = new Map(MODES.map((m) => [m.id, m]));

export function modeById(id) {
    return BY_ID.get(id) || BY_ID.get('files');
}

/**
 * Split the input into its mode and the query after the prefix. The query
 * keeps its inner spaces but loses the ones right after the prefix, so
 * "@ edi" and "@edi" search the same thing.
 */
export function parsePaletteInput(text) {
    const raw = String(text ?? '');
    const mode = BY_PREFIX.get(raw.charAt(0));
    if (!mode) return { mode: BY_ID.get('files'), query: raw.trim() };
    return { mode, query: raw.slice(1).trim() };
}

/** The input text that opens `modeId` with `query` already typed. */
export function inputFor(modeId, query = '') {
    return modeById(modeId).prefix + (query || '');
}

/**
 * The line a `:` query asks for, or an error key for the hint row.
 * `total` is the document's line count, 0 when unknown.
 */
export function parseLineQuery(query, total = 0) {
    const q = String(query ?? '').trim();
    if (!q) return { error: 'empty' };
    if (!/^\d+$/.test(q)) return { error: 'invalid' };
    const line = parseInt(q, 10);
    if (line < 1) return { error: 'invalid' };
    if (total > 0 && line > total) return { error: 'range', line };
    return { line };
}

/**
 * Case-insensitive filter that ranks a match in the name above one only in
 * the detail (the folder, for a tab), and an earlier match above a later one.
 * Stable for equal scores, so the caller's own order (most recent first)
 * survives among equals.
 */
export function filterByText(items, query, nameOf, detailOf = () => '') {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return items.slice();
    const scored = [];
    items.forEach((item, order) => {
        const name = String(nameOf(item) || '').toLowerCase();
        const at = name.indexOf(q);
        if (at >= 0) {
            scored.push({ item, score: at === 0 ? 0 : 1, at, order });
            return;
        }
        const detail = String(detailOf(item) || '').toLowerCase();
        const dAt = detail.indexOf(q);
        if (dAt >= 0) scored.push({ item, score: 2, at: dAt, order });
    });
    scored.sort((a, b) => a.score - b.score || a.at - b.at || a.order - b.order);
    return scored.map((s) => s.item);
}
