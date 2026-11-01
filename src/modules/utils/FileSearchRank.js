/**
 * FileSearchRank.js — matching and ordering for the file search (Ctrl+Shift+R).
 *
 * The list used to be the first hundred files whose name contained the query,
 * in whatever order the directory walk produced them. Typing `App.js` could
 * put `src/legacy/OldApp.js.bak` above `src/App.js`, and a query with a typo
 * or a skipped letter (`flsrch`) found nothing at all.
 *
 * Now every candidate gets a score, in tiers that never overlap:
 *
 *   exact name  >  name prefix  >  name substring  >  path substring
 *               >  fuzzy (in order) on the name  >  fuzzy on the path
 *
 * and ties go to a recently opened file, then the shorter path, then the
 * alphabet. Fuzzy means VS Code's Ctrl+P sense: every character of the query
 * appears in the text, in order, not necessarily next to each other.
 *
 * Pure functions only — no DOM, no Tauri — so the ordering is tested directly
 * (tests/FileSearchRank.test.js).
 */

// Tier bases. A tier's own bonuses stay below the gap to the next tier.
const TIER = {
    exact: 6000,
    prefix: 5000,
    name: 4000,
    path: 3000,
    fuzzyName: 2000,
    fuzzyPath: 1000,
    glob: 1000,
};

const SEPARATORS = '/\\_-. ';

/** Slashes one way, so `src\\ui` and `src/ui` are the same query. */
function normSlashes(s) {
    return String(s || '').replace(/\\/g, '/');
}

/** Lower-cased, forward-slashed key used to compare full paths. */
export function pathKey(p) {
    return normSlashes(p).replace(/\/+$/, '').toLowerCase();
}

/**
 * `path` relative to `workspace` when it lies inside it; unchanged otherwise.
 * Both may use either kind of slash; the result uses `/`.
 */
export function toRelPath(path, workspace) {
    const p = normSlashes(path);
    const w = normSlashes(workspace).replace(/\/+$/, '');
    if (w && p.toLowerCase().startsWith(w.toLowerCase() + '/')) return p.substring(w.length + 1);
    return p;
}

/**
 * Glob to RegExp. With a `/` it matches the end of the relative path
 * (`src/*.js`); without one it matches the whole file name (`*設計*.xlsx`).
 * `*` stays within one path segment, `**` crosses them, `?` is one character.
 */
export function globToRegex(pattern) {
    const hasPath = pattern.includes('/');
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const converted = escaped
        .replace(/\*\*/g, '§§')
        .replace(/\*/g, '[^/]*')
        .replace(/§§/g, '.*')
        .replace(/\?/g, '.');
    return hasPath
        ? { regex: new RegExp(`${converted}$`, 'i'), matchPath: true }
        : { regex: new RegExp(`^${converted}$`, 'i'), matchPath: false };
}

export function isGlob(query) {
    return query.includes('*') || query.includes('?');
}

/**
 * Where the characters of `query` occur in `text`, in order, or null when they
 * do not all occur. Both are expected lower-cased already.
 *
 * Greedy left-to-right finds whether there is a match; a second pass from the
 * last matched character backwards then pulls each earlier character as far
 * right as it will go, so `abc` in `a_x_abc` highlights the tight `abc`, not
 * the scattered first `a`.
 */
export function fuzzyPositions(query, text) {
    if (!query) return [];
    const positions = new Array(query.length);
    let ti = 0;
    for (let qi = 0; qi < query.length; qi++) {
        const found = text.indexOf(query[qi], ti);
        if (found < 0) return null;
        positions[qi] = found;
        ti = found + 1;
    }
    // Tighten: walk back from the end, taking the last occurrence of each
    // character that still lies before the one after it.
    let limit = positions[query.length - 1];
    for (let qi = query.length - 2; qi >= 0; qi--) {
        const found = text.lastIndexOf(query[qi], limit - 1);
        if (found >= positions[qi]) positions[qi] = found;
        limit = positions[qi];
    }
    return positions;
}

/**
 * A fuzzy match's quality, 0..999: fewer and shorter gaps are better, and a
 * character that starts a word (after `/`, `_`, `-`, `.`, a space, or a
 * lower→upper case change in `original`) counts in its favour.
 */
function fuzzyQuality(positions, original) {
    let gaps = 0;
    let boundaries = 0;
    for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        if (i > 0 && p !== positions[i - 1] + 1) gaps += 1;
        const prev = p > 0 ? original[p - 1] : '';
        const cur = original[p];
        if (p === 0 || SEPARATORS.includes(prev)
            || (prev && prev === prev.toLowerCase() && cur !== cur.toLowerCase())) {
            boundaries += 1;
        }
    }
    const spread = positions[positions.length - 1] - positions[0] + 1 - positions.length;
    const q = 600 + boundaries * 40 - gaps * 60 - Math.min(spread, 200);
    return Math.max(0, Math.min(999, q));
}

/** Consecutive positions folded into [start, end) ranges. */
export function toRanges(positions) {
    const ranges = [];
    for (const p of positions) {
        const last = ranges[ranges.length - 1];
        if (last && last[1] === p) last[1] = p + 1;
        else ranges.push([p, p + 1]);
    }
    return ranges;
}

/**
 * Score one file against a query.
 *
 * @param {string} query   trimmed, not yet lower-cased
 * @param {{name: string, rel: string}} file  file name and workspace-relative
 *        path (forward slashes)
 * @returns {null | {score: number, kind: string, nameRanges: number[][], relRanges: number[][]}}
 *          ranges are [start, end) into `name` / `rel` for highlighting
 */
export function scoreFile(query, file) {
    const q = normSlashes(query).toLowerCase();
    if (!q) return null;
    const name = file.name;
    const rel = file.rel;
    const nameL = file.nameLower ?? name.toLowerCase();
    const relL = file.relLower ?? rel.toLowerCase();

    // A query with a slash is about the path; the name tiers would only ever
    // match a file literally named with a slash, which cannot exist.
    if (!q.includes('/')) {
        if (nameL === q) {
            return { score: TIER.exact, kind: 'exact', nameRanges: [[0, name.length]], relRanges: [] };
        }
        if (nameL.startsWith(q)) {
            return { score: TIER.prefix, kind: 'prefix', nameRanges: [[0, q.length]], relRanges: [] };
        }
        const at = nameL.indexOf(q);
        if (at >= 0) {
            // A hit at a word start (`Search` in `FileSearchModal`) beats one
            // in the middle of a word.
            const prev = name[at - 1];
            const bonus = (SEPARATORS.includes(prev) || (prev === prev.toLowerCase() && name[at] !== name[at].toLowerCase())) ? 100 : 0;
            return { score: TIER.name + bonus, kind: 'name', nameRanges: [[at, at + q.length]], relRanges: [] };
        }
    }

    const relAt = relL.indexOf(q);
    if (relAt >= 0) {
        return { score: TIER.path, kind: 'path', nameRanges: [], relRanges: [[relAt, relAt + q.length]] };
    }

    if (!q.includes('/')) {
        const pos = fuzzyPositions(q, nameL);
        if (pos) {
            return {
                score: TIER.fuzzyName + fuzzyQuality(pos, name),
                kind: 'fuzzyName', nameRanges: toRanges(pos), relRanges: [],
            };
        }
    }
    const pos = fuzzyPositions(q, relL);
    if (pos) {
        return {
            score: TIER.fuzzyPath + fuzzyQuality(pos, rel),
            kind: 'fuzzyPath', nameRanges: [], relRanges: toRanges(pos),
        };
    }
    return null;
}

/**
 * Index entries for ranking, built once per file list rather than per
 * keystroke: lower-casing 50,000 paths on every key is the expensive part.
 *
 * @param {Array<{entry?: string, name?: string, path: string}>} items
 *        what FS.listAllFiles returns
 * @param {string} workspace
 */
export function prepareEntries(items, workspace) {
    return items.map((item) => {
        const name = item.entry || item.name || normSlashes(item.path).split('/').pop();
        const rel = toRelPath(item.path, workspace);
        return {
            item,
            name,
            rel,
            nameLower: name.toLowerCase(),
            relLower: rel.toLowerCase(),
            key: pathKey(item.path),
        };
    });
}

/**
 * Rank prepared entries for a query.
 *
 * @param {string} query
 * @param {ReturnType<typeof prepareEntries>} entries
 * @param {{limit?: number, recent?: string[]}} [opts]  `recent`: full paths,
 *        most recent first (RecentFiles.getFiles())
 * @returns {Array<{item: object, name: string, rel: string, score: number,
 *          kind: string, nameRanges: number[][], relRanges: number[][]}>}
 */
export function rankFiles(query, entries, { limit = 100, recent = [] } = {}) {
    const raw = String(query || '').trim();
    if (!raw) return [];

    const recentRank = new Map();
    recent.forEach((p, i) => {
        const k = pathKey(p);
        if (!recentRank.has(k)) recentRank.set(k, i);
    });

    const hits = [];
    if (isGlob(raw)) {
        let compiled;
        try { compiled = globToRegex(normSlashes(raw)); } catch (_) { return []; }
        const { regex, matchPath } = compiled;
        for (const e of entries) {
            if (matchPath ? regex.test(e.rel) : regex.test(e.name)) {
                hits.push({
                    entry: e, score: TIER.glob, kind: 'glob',
                    nameRanges: matchPath ? [] : [[0, e.name.length]], relRanges: [],
                });
            }
        }
    } else {
        for (const e of entries) {
            const s = scoreFile(raw, e);
            if (s) hits.push({ entry: e, ...s });
        }
    }

    const NOT_RECENT = Number.MAX_SAFE_INTEGER;
    hits.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ra = recentRank.get(a.entry.key) ?? NOT_RECENT;
        const rb = recentRank.get(b.entry.key) ?? NOT_RECENT;
        if (ra !== rb) return ra - rb;
        if (a.entry.rel.length !== b.entry.rel.length) return a.entry.rel.length - b.entry.rel.length;
        return a.entry.rel < b.entry.rel ? -1 : a.entry.rel > b.entry.rel ? 1 : 0;
    });

    return hits.slice(0, limit).map((h) => ({
        item: h.entry.item,
        name: h.entry.name,
        rel: h.entry.rel,
        score: h.score,
        kind: h.kind,
        nameRanges: h.nameRanges,
        relRanges: h.relRanges,
    }));
}

/**
 * Split ranges over `rel` into ranges over its directory part and its name
 * part, for a list that shows the two separately. `rel` = `dir/name`, or just
 * `name` at the workspace root.
 */
export function splitRelRanges(relRanges, rel, name) {
    const nameStart = rel.length - name.length;
    const dirLen = Math.max(0, nameStart - 1); // without the joining '/'
    const dir = [];
    const nm = [];
    for (const [s, e] of relRanges) {
        if (s < dirLen) dir.push([s, Math.min(e, dirLen)]);
        if (e > nameStart) nm.push([Math.max(s, nameStart) - nameStart, e - nameStart]);
    }
    return { dirRanges: dir, nameRanges: nm };
}
