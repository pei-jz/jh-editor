/**
 * DirtyState.js — does a buffer still match what is on disk?
 *
 * `isDirty` used to be a one-way latch: any edit set it and only a save
 * cleared it, so typing a character and deleting it again (or undoing back to
 * where you started) left the tab marked modified with nothing to save.
 *
 * The fix is a baseline. When a buffer is loaded or written, remember the text
 * and line ending that are now on disk; an edit then asks "does the buffer
 * still match that?" instead of assuming it no longer does.
 *
 * Some views write the document back in their own form: the Markdown block
 * view re-joins blocks with one blank line, the CSV grid re-serialises every
 * row. After any edit there, the buffer no longer has the file's original
 * bytes even if the document is unchanged, so comparing against the saved
 * text would never match again. Those views record what the saved text looks
 * like in their form (rememberSavedForm) and ask with that key; matching
 * either the saved text or its form counts as clean.
 *
 * A buffer without a baseline (untitled drafts, AI output, rope-backed huge
 * files) is never reported clean here — with no disk copy there is nothing to
 * compare against, which is how those tabs already behaved.
 */

// file -> { source, key, value }. Weak, so closed tabs take it with them.
const savedForms = new WeakMap();

/** Record the buffer's current text and EOL as what is on disk. */
export function markSaved(file) {
    if (!file || typeof file.content !== 'string') return;
    // Strings are immutable, so this shares the text rather than copying it
    // until the buffer is actually edited.
    file.savedContent = file.content;
    file.savedEol = file.eol || '\n';
}

/** Remember how the saved text looks once a view has rewritten it. */
export function rememberSavedForm(file, key, value) {
    if (!file || typeof file.savedContent !== 'string' || typeof value !== 'string') return;
    savedForms.set(file, { source: file.savedContent, key, value });
}

/** The remembered form for `key`, or undefined if none or it is stale. */
export function savedForm(file, key) {
    const form = file ? savedForms.get(file) : undefined;
    // Tied to the baseline it was made from: after a save it no longer applies.
    return form && form.key === key && form.source === file.savedContent ? form.value : undefined;
}

/**
 * True when the buffer is its last saved state — byte for byte, or, given a
 * `formKey`, in the form a view remembered for it.
 */
export function isAtSavedState(file, formKey) {
    if (!file || typeof file.savedContent !== 'string') return false;
    if ((file.eol || '\n') !== file.savedEol) return false;
    if (file.content === file.savedContent) return true;
    if (formKey === undefined) return false;
    const form = savedForm(file, formKey);
    return typeof form === 'string' && file.content === form;
}
