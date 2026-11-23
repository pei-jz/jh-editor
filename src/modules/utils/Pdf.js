/**
 * Pdf.js — which files get the read-only PDF preview (views/PdfView.js).
 *
 * Kept apart from the view for the same reason utils/Office.js is: the open
 * path, the session restore and the status bar all have to agree on it, and
 * the view pulls in pdf.js, which none of them should have to load to ask.
 */
import { extensionOf } from './Office.js';

export function isPdfFile(path) {
    return extensionOf(path) === 'pdf';
}
