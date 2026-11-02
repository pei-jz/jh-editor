/**
 * ExternalFiles.js — files the editor has no view for.
 *
 * Decided by extension alone: the tree lists a whole directory at a time, and
 * reading the head of every file to look for NUL bytes would make opening a
 * folder as slow as its slowest disk. So a binary with an unlisted extension
 * (.dat, .iso) still looks like a text file until it is clicked, and the read
 * refuses it then.
 *
 * Two kinds, because "the OS's default handler" means two different things:
 *
 * 'open'    — a viewer or a player starts. The backend will hand these over, and
 *             only these: OPENABLE_EXTENSIONS in src-tauri/src/commands/app.rs is
 *             the same list, and tests/ExplorerExternal.test.js keeps them equal.
 *
 * 'program' — the handler is the file itself, or a runtime that executes it. A
 *             workspace is often someone else's clone, and one stray click must
 *             not run what is in it, so these are shown but never launched.
 *
 * .xlsx/.xls/.ods/.docx/.pptx are absent on purpose: they open in the read-only
 * Office preview (views/OfficeView.js). Scripts (.bat, .ps1, .sh) are absent too:
 * they are text, and clicking one edits it.
 */
const OPENABLE = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
    'zip', 'tar', 'gz', '7z', 'rar',
    'pdf', 'doc', 'ppt',
    'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv',
    'db', 'sqlite',
]);

const PROGRAMS = new Set([
    'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o',
    'class', 'jar', 'pyc',
]);

/**
 * The extension as the OS sees it: none for `bin` or `.png`. Splitting on the
 * last dot alone made a file simply named `bin` look like a binary, and the tree
 * hid it.
 */
function extensionOf(name) {
    const dot = String(name || '').lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 'open', 'program', or null for a file the editor opens itself. */
export function externalKind(name) {
    const ext = extensionOf(name);
    if (OPENABLE.has(ext)) return 'open';
    if (PROGRAMS.has(ext)) return 'program';
    return null;
}
