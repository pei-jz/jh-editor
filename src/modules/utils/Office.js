/**
 * Office.js — which files get the read-only Office preview, and what to call
 * them once they are open.
 *
 * Kept apart from the view and from the open path because three places have to
 * agree on the same list: the explorer decides whether to show the file at all,
 * the open path decides whether to read it as text or hand it to the backend
 * parser, and the status bar names the format. A file that one of them thinks
 * is an Office document and another thinks is text opens as mojibake.
 *
 * The list is the formats `src-tauri/src/commands/office.rs` can actually read.
 * The pre-2007 binary `.doc` and `.ppt` are deliberately absent: there is no
 * reader for them here, and claiming them would route a file into a preview
 * that can only fail. `.xls` IS here — calamine reads the old workbook format.
 */

/** extension → the `kind` the backend returns for it. */
const OFFICE_KINDS = {
    xlsx: 'sheets',
    xlsm: 'sheets',
    xls: 'sheets',
    ods: 'sheets',
    docx: 'document',
    pptx: 'slides',
};

/** Lower-case extension with no dot, or '' when the name carries none. */
export function extensionOf(path) {
    const name = String(path || '').replace(/\\/g, '/').split('/').pop();
    const dot = name.lastIndexOf('.');
    // A leading dot is the whole name of a dotfile, not a separator.
    if (dot <= 0) return '';
    return name.slice(dot + 1).toLowerCase();
}

export function isOfficeFile(path) {
    return Object.prototype.hasOwnProperty.call(OFFICE_KINDS, extensionOf(path));
}

/** 'sheets' | 'slides' | 'document' | null — what the preview will look like. */
export function officeKind(path) {
    return OFFICE_KINDS[extensionOf(path)] || null;
}
