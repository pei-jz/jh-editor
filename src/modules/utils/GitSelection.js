/**
 * GitSelection.js — the rules behind picking several changed files at once.
 *
 * Plain data in and out, so what a bulk Revert would touch can be tested without
 * a repository: getting that wrong loses someone's work.
 */

/**
 * A path as `git status --porcelain` wrote it, without its quoting. Git quotes
 * any path holding a space or a control character ("a b.txt"), and git itself
 * does not accept that spelling back, so one such file used to fail a command
 * for everything passed along with it.
 */
export function unquoteGitPath(raw) {
    const s = String(raw);
    if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
    const named = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    const bytes = [];
    const encoder = new TextEncoder();
    const body = s.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
        if (body[i] !== '\\') {
            // One whole character: a surrogate pair must reach the encoder together.
            const ch = String.fromCodePoint(body.codePointAt(i));
            bytes.push(...encoder.encode(ch));
            i += ch.length - 1;
            continue;
        }
        const octal = /^[0-3][0-7]{2}/.exec(body.slice(i + 1, i + 4));
        if (octal) {
            bytes.push(parseInt(octal[0], 8));
            i += 3;
        } else {
            i += 1;
            bytes.push(named[body[i]] ?? body.charCodeAt(i));
        }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * One status entry as `{ path, from }`. A rename is written `old -> new`, each
 * side quoted on its own; `path` is where the file is now and `from` where it
 * was (null when it did not move).
 */
export function parseStatusPath(raw) {
    const s = String(raw);
    const m = /^("(?:[^"\\]|\\.)*"|.*?) -> ("(?:[^"\\]|\\.)*"|.*)$/.exec(s);
    if (!m) return { path: unquoteGitPath(s), from: null };
    return { path: unquoteGitPath(m[2]), from: unquoteGitPath(m[1]) };
}

/** The entries a selection stands for: a folder means everything under it. */
export function selectedEntries(selection, entries) {
    const picked = [...selection];
    return entries.filter((e) => picked.some((p) => e.path === p || e.path.startsWith(`${p}/`)));
}

/** Everything from `anchor` to `target` in the order shown, ends included. */
export function selectRange(order, anchor, target) {
    const to = order.indexOf(target);
    if (to < 0) return [];
    const from = order.indexOf(anchor);
    if (from < 0) return [target];
    return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * Split paths into argument lists a command line can hold. Windows gives a whole
 * command line about 32K characters, and a large selection would go over it.
 */
export function batchPaths(paths, limit = 24000) {
    const batches = [];
    let current = [];
    let size = 0;
    for (const p of paths) {
        const cost = p.length + 3;
        if (current.length && size + cost > limit) {
            batches.push(current);
            current = [];
            size = 0;
        }
        current.push(p);
        size += cost;
    }
    if (current.length) batches.push(current);
    return batches;
}

/** Tracked files go back to their earlier version; untracked ones have none. */
export function splitForRevert(entries) {
    const untracked = entries.filter((e) => e.status === 'U').map((e) => e.path);
    const tracked = entries.filter((e) => e.status !== 'U').map((e) => e.path);
    return { tracked, untracked };
}

/**
 * What a bulk delete touches: a file already gone from the working tree has
 * nothing left to delete. Whether an entry is on disk is the caller's to find
 * out; here the worktree-deleted status alone rules one out.
 */
export function deletableEntries(entries) {
    return entries.filter((e) => e.status !== 'D');
}

/** The first few paths for a confirmation, and how many more there are. */
export function pathListText(paths, max = 12, more = (n) => `… +${n}`) {
    const shown = paths.slice(0, max).map((p) => `  ${p}`);
    if (paths.length > max) shown.push(`  ${more(paths.length - max)}`);
    return shown.join('\n');
}
