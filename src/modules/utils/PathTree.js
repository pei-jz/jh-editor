/**
 * PathTree.js — a flat list of files, as a folder tree.
 *
 * The palette's tree view uses it to show tabs and search hits where they
 * live, because people remember where a file is better than what it was
 * called. Folders that hold nothing but one other folder are merged into one
 * row ("src/modules/core"), the way an explorer's compact folders are, so a
 * deep path costs one line instead of five.
 *
 * Plain functions over plain data, so the shape is tested without a DOM.
 */

function norm(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Compared without case on Windows paths, as Panes.js does for open files. */
function cmpKey(p) {
    const n = norm(p);
    return /^[a-zA-Z]:(?=\/|$)/.test(n) ? n.toLowerCase() : n;
}

function dirNode(label, path) {
    return { type: 'dir', label, path, children: [], dirs: new Map(), best: Infinity };
}

/**
 * Build the tree.
 *
 * `items` are anything; `dirOf(item)` gives an item's folder as an absolute
 * path, or '' for something with no folder (an untitled buffer, a terminal),
 * which lands in a top-level group labelled `otherLabel`.
 *
 * Folders inside `workspace` hang under one top node named after it; folders
 * elsewhere start from their drive. With `order: 'name'` folders and files are
 * sorted by name (folders first), as an explorer does. With `order: 'rank'`
 * the items' own order is kept — a folder takes the place of its best item —
 * which is what a list of search hits wants.
 *
 * Returns the top-level nodes: { type: 'dir', label, path, children } and
 * { type: 'leaf', item }.
 */
export function buildPathTree(items, dirOf, { workspace = '', order = 'name', otherLabel = 'Other' } = {}) {
    const root = norm(workspace);
    const rootKey = cmpKey(root);
    const top = dirNode('', '');
    const other = dirNode(otherLabel, '');
    other.other = true;

    (items || []).forEach((item, rank) => {
        const dir = norm(dirOf(item));
        let parent;
        let parts;
        let base;
        if (!dir) {
            other.children.push({ type: 'leaf', item, rank });
            other.best = Math.min(other.best, rank);
            return;
        }
        const key = cmpKey(dir);
        if (root && (key === rootKey || key.startsWith(rootKey + '/'))) {
            const name = root.slice(root.lastIndexOf('/') + 1) || root;
            if (!top.dirs.has('\u0000ws')) {
                const ws = dirNode(name, root);
                ws._ws = true;
                top.dirs.set('\u0000ws', ws);
            }
            parent = top.dirs.get('\u0000ws');
            parts = dir.slice(root.length).split('/').filter(Boolean);
            base = root;
        } else {
            parent = top;
            parts = dir.split('/').filter(Boolean);
            base = '';
            // A POSIX absolute path keeps its leading slash on the first part.
            if (dir.startsWith('/')) parts[0] = '/' + parts[0];
        }
        parent.best = Math.min(parent.best, rank);
        // Windows folder names have no case either, not just the drive.
        const fold = /^[a-zA-Z]:(?=\/|$)/.test(dir);
        let path = base;
        for (const part of parts) {
            path = path ? `${path}/${part}` : part;
            const k = fold ? part.toLowerCase() : part;
            if (!parent.dirs.has(k)) parent.dirs.set(k, dirNode(part, path));
            parent = parent.dirs.get(k);
            parent.best = Math.min(parent.best, rank);
        }
        parent.children.push({ type: 'leaf', item, rank });
    });

    const byName = (a, b) => labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base', numeric: true });
    const finish = (node) => {
        let dirs = [...node.dirs.values()].map(finish).map(compact);
        let leaves = node.children;
        if (order === 'rank') {
            const all = [...dirs, ...leaves].sort((a, b) => bestOf(a) - bestOf(b));
            node.children = all;
        } else {
            dirs.sort(byName);
            leaves = leaves.slice().sort(byName);
            node.children = [...dirs, ...leaves];
        }
        delete node.dirs;
        return node;
    };
    const tops = finish(top).children;
    if (other.children.length) {
        finish(other);
        tops.push(other);
    }
    return tops.map(strip);
}

function labelOf(node) {
    if (node.type === 'dir') return node.label;
    const it = node.item;
    return String((it && (it.name || it.label || it.path)) || '');
}

function bestOf(node) {
    return node.type === 'dir' ? node.best : node.rank;
}

/** Merge a folder whose only content is one folder into one row. */
function compact(node) {
    let n = node;
    while (n.type === 'dir' && !n.other && n.children.length === 1 && n.children[0].type === 'dir'
        && !isWorkspaceTop(n)) {
        const child = n.children[0];
        n = { ...child, label: `${n.label}/${child.label}` };
    }
    return n;
}

/** The workspace node keeps its own row: its name anchors the whole view. */
function isWorkspaceTop(node) {
    return node._ws === true;
}

function strip(node) {
    if (node.type === 'leaf') return { type: 'leaf', item: node.item };
    const out = { type: 'dir', label: node.label, path: node.path, children: node.children.map(strip) };
    if (node.other) out.other = true;
    return out;
}

/**
 * Walk the tree into rows with a depth, skipping the children of folders in
 * `collapsed` (a Set of folder paths). The palette paints these.
 */
export function flattenTree(nodes, collapsed = new Set(), depth = 0, out = []) {
    for (const node of nodes) {
        if (node.type === 'leaf') {
            out.push({ type: 'leaf', item: node.item, depth });
            continue;
        }
        const key = node.other ? '\u0000other' : node.path;
        const open = !collapsed.has(key);
        out.push({ type: 'dir', label: node.label, path: node.path, key, depth, open, count: countLeaves(node), other: !!node.other });
        if (open) flattenTree(node.children, collapsed, depth + 1, out);
    }
    return out;
}

function countLeaves(node) {
    return node.children.reduce((n, c) => n + (c.type === 'leaf' ? 1 : countLeaves(c)), 0);
}
