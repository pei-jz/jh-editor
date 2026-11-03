// A results tab is plain text the user may edit, so where a line leads is read
// from the text itself: a hit row says its line number, and the nearest path
// above it says the file. Nothing has to be kept in step with the edits.
//
//   C:\ws\src\a.js
//        12: const needle = 1;
//       340: return needle;
//
//   C:\ws\src\b.js
//         7: // needle
//
//   C:\ws\src\lib\
//   C:\ws\src\lib\c.js
//         3: needle
//
// A path ending in a separator is a folder. It holds every path under it, so
// the files of a folder search are kept in path order: what is under a folder
// is then always next to it, and it folds as one.

const ROW = /^\s*(\d+):/;
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

const forwardSlashes = (path) => path.replace(/\\/g, '/');

export function formatRow(line, text) {
    // A lone \r would count as a line break in the editor, and split the row.
    return `${String(line).padStart(6)}: ${String(text).replace(/[\r\n]/g, ' ')}`;
}

/** The text before a hit row's own text, or null when this is not a row. */
export function rowPrefixLength(text) {
    const row = ROW.exec(text);
    if (!row) return null;
    return row[0].length + (text[row[0].length] === ' ' ? 1 : 0);
}

/**
 * Is this line a file? `isKnownPath` covers what a search reported that does not
 * look like a path (an untitled tab, by name). A note typed between the rows is
 * neither, so it does not cut the rows under it off from their file.
 */
export function isPathLine(text, isKnownPath = () => false) {
    if (ROW.test(text)) return false;
    const path = text.trimEnd();
    return ABSOLUTE_PATH.test(path) || isKnownPath(path);
}

export function isFolderLine(text) {
    return isPathLine(text) && /[\\/]$/.test(text.trimEnd());
}

/** Does this path line sit under that folder line? Windows paths ignore case. */
export function isUnderFolder(text, folder) {
    return forwardSlashes(text.trimEnd()).toLowerCase()
        .startsWith(forwardSlashes(folder.trimEnd()).toLowerCase());
}

/**
 * Where a line of the text leads: { path, line }, with line null on a path line.
 * Null for anything else, such as a note, a blank line or a folder.
 */
export function locateHit(lineText, lineNo, isKnownPath) {
    const text = lineText(lineNo);
    const row = ROW.exec(text);
    if (!row && !isPathLine(text, isKnownPath)) return null;
    for (let n = lineNo; n >= 1; n--) {
        const candidate = lineText(n);
        if (isPathLine(candidate, isKnownPath)) {
            if (isFolderLine(candidate)) return null;
            return { path: candidate.trimEnd(), line: row ? Number(row[1]) : null };
        }
    }
    return null;
}

/** The folders between the searched folder and a file, outermost first. */
export function foldersBetween(root, path) {
    if (!root) return [];
    const base = `${forwardSlashes(root).replace(/\/+$/, '')}/`;
    const plain = forwardSlashes(path);
    if (!plain.toLowerCase().startsWith(base.toLowerCase())) return [];
    const out = [];
    for (let i = plain.indexOf('/', base.length); i !== -1; i = plain.indexOf('/', i + 1)) {
        out.push(path.slice(0, i + 1));
    }
    return out;
}

/** Sorts folders before the files beside them; a folder's key starts all of its contents'. */
function treeKey(path) {
    const parts = forwardSlashes(path).toLowerCase().split('/');
    const last = parts.pop();
    return parts.map((part) => `0${part}/`).join('') + (last ? `1${last}` : '');
}

/**
 * The inserts that add `matches` to the text, each row under its file's group,
 * and each new file in its place in path order under any folder it needs. `root`
 * is the searched folder; without one there are no folder lines.
 *
 * A folder search reads files in parallel, so hits arrive interleaved. `groups`
 * maps a path to where its group ends in the text, and is updated here to the
 * positions after these inserts. Changes are all relative to the text as it
 * stands, as CodeMirror takes them.
 */
export function planAppend(matches, groups, docLength, root) {
    const rowsOf = new Map();
    const fresh = new Map(); // what has no place in the text yet: path -> its rows
    for (const m of matches) {
        if (!groups.has(m.path) && !fresh.has(m.path)) {
            for (const folder of foldersBetween(root, m.path)) {
                if (!groups.has(folder)) fresh.set(folder, []);
            }
            fresh.set(m.path, []);
        }
        const into = fresh.get(m.path) || rowsOf.get(m.path) || [];
        into.push(formatRow(m.line, m.text));
        if (!fresh.has(m.path)) rowsOf.set(m.path, into);
    }

    // One insert per place in the text: a group's new rows, then what follows it.
    const places = new Map();
    const placeAfter = (anchor) => {
        if (!places.has(anchor)) {
            places.set(anchor, {
                anchor,
                from: anchor === null ? 0 : Math.min(groups.get(anchor), docLength),
                insert: '',
                ownLength: 0,
                ends: [],
            });
        }
        return places.get(anchor);
    };
    for (const [path, rows] of rowsOf) {
        const place = placeAfter(path);
        place.insert = rows.map((row) => `\n${row}`).join('');
        place.ownLength = place.insert.length;
    }

    const keys = new Map([...groups.keys(), ...fresh.keys()].map((path) => [path, treeKey(path)]));
    const inTreeOrder = (a, b) => (keys.get(a) < keys.get(b) ? -1 : 1);
    const placed = [...groups.keys()].sort(inTreeOrder);
    let i = 0;
    let previous = null;
    for (const path of [...fresh.keys()].sort(inTreeOrder)) {
        while (i < placed.length && keys.get(placed[i]) < keys.get(path)) i += 1;
        const anchor = i > 0 ? placed[i - 1] : null;
        const place = placeAfter(anchor);
        const first = place.ends.length === 0;
        const after = first ? anchor : previous;
        if (after !== null) place.insert += isFolderLine(after) ? '\n' : '\n\n';
        const rows = fresh.get(path);
        place.insert += [path, ...rows].join('\n');
        place.ends.push([path, place.insert.length]);
        // A folder's next line sits straight under it, and needs parting from this.
        place.tail = anchor === null ? docLength > 0 : (isFolderLine(anchor) && i < placed.length);
        previous = path;
    }

    const changes = [...places.values()].sort((a, b) => a.from - b.from);
    let total = 0;
    for (const place of changes) {
        if (place.tail) place.insert += place.anchor === null ? '\n\n' : '\n';
        place.before = total;
        total += place.insert.length;
    }

    // Each group moves by whatever goes in before it, and by its own new rows.
    let next = 0;
    let shift = 0;
    for (const [path, at] of [...groups].sort((a, b) => a[1] - b[1])) {
        const end = Math.min(at, docLength);
        while (next < changes.length && changes[next].from < end) {
            shift += changes[next].insert.length;
            next += 1;
        }
        const own = places.get(path);
        groups.set(path, end + shift + (own ? own.ownLength : 0));
    }
    for (const place of changes) {
        for (const [path, end] of place.ends) groups.set(path, place.from + place.before + end);
    }

    return changes.map(({ from, insert }) => ({ from, insert }));
}
