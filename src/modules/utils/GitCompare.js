/**
 * GitCompare.js — the pure parts of a Git comparison: the file tree, the
 * order Ctrl+Up / Ctrl+Down walks it in, and the summary counts.
 *
 * Kept apart from GitPanel.js so the comparison tab (GitCompareView) can use
 * them without pulling in the whole panel.
 */

/**
 * Group flat `a/b/c.js` paths into a directory tree, collapsing runs of
 * single-child directories into one node (`src/modules/ui` rather than three
 * nested rows) — the way every file explorer shows a deep, sparse tree.
 *
 * @param {Array<{path: string, status: string}>} files
 * @returns {{name: string, path: string, dirs: object[], files: object[]}} root
 */
export function buildFileTree(files) {
    const root = { name: '', path: '', dirs: [], files: [] };

    for (const file of files) {
        const parts = String(file.path || '').split('/').filter(Boolean);
        const name = parts.pop();
        if (!name) continue;
        let node = root;
        let sofar = '';
        for (const part of parts) {
            sofar = sofar ? `${sofar}/${part}` : part;
            let next = node.dirs.find((d) => d.name === part);
            if (!next) {
                next = { name: part, path: sofar, dirs: [], files: [] };
                node.dirs.push(next);
            }
            node = next;
        }
        node.files.push({ ...file, name });
    }

    // A directory whose only child is another directory is shown as one row.
    const collapse = (node) => {
        node.dirs.forEach(collapse);
        while (node.dirs.length === 1 && node.files.length === 0 && node !== root) {
            const only = node.dirs[0];
            node.name = `${node.name}/${only.name}`;
            node.path = only.path;
            node.dirs = only.dirs;
            node.files = only.files;
        }
    };
    collapse(root);
    return root;
}

/**
 * Sort a tree in place the way a file explorer does: folders by name, then
 * files by name, at every level. git lists paths in byte order, which puts
 * `Zeta.js` before `alpha.js` and a folder after the files beside it.
 */
export function sortTree(node) {
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    node.dirs.sort(byName);
    node.files.sort(byName);
    node.dirs.forEach(sortTree);
    return node;
}

/** Total files under a tree node, including every nested directory. */
export function countFiles(node) {
    return node.files.length + node.dirs.reduce((n, d) => n + countFiles(d), 0);
}

/**
 * Every file of the tree in the order it is drawn: a directory's
 * subdirectories first, then its own files. This is the order next / previous
 * file walks, so the keys go where the eye expects.
 */
export function fileOrder(node) {
    const out = [];
    const walk = (n) => {
        n.dirs.forEach(walk);
        n.files.forEach((f) => out.push(f.path));
    };
    walk(node);
    return out;
}

/**
 * Keep the files whose path contains `query` (case-insensitive). Several words
 * must all match, in any order, so "ui panel" finds `src/ui/GitPanel.js`.
 */
export function filterFiles(files, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return files;
    return files.filter((f) => {
        const p = String(f.path || '').toLowerCase();
        return words.every((w) => p.includes(w));
    });
}

/** How many files were added, modified, deleted and renamed. */
export function summarizeFiles(files) {
    const sum = { A: 0, M: 0, D: 0, R: 0 };
    for (const f of files) {
        const s = f.status === 'C' ? 'A' : f.status;
        if (s in sum) sum[s] += 1;
        else sum.M += 1;
    }
    return sum;
}

/**
 * The file after (or before) `current` in `order`, or null at either end.
 * A current file that has been filtered away starts from the top.
 */
export function stepFile(order, current, direction) {
    if (!order.length) return null;
    const i = order.indexOf(current);
    if (i === -1) return direction > 0 ? order[0] : order[order.length - 1];
    const next = i + direction;
    return next >= 0 && next < order.length ? order[next] : null;
}

/** NUL in the first few kilobytes: a binary file, which a text diff garbles. */
export function looksBinary(text) {
    return typeof text === 'string' && text.slice(0, 8000).includes('\u0000');
}
