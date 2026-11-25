/**
 * ViewSwitch.js — which second view a tab has, and what the way there is called.
 *
 * Ctrl+Shift+E flips a tab between its text and another view of the same file:
 * Markdown blocks, the CSV table, the XML / JSON / HTML structure tree, a
 * jh-presentation deck's slides. The key was the only way there, and a key
 * nobody tells you about is a feature nobody has. The toolbar button, the
 * status bar and the key itself all ask this module, so they cannot disagree
 * about which files have a second view — the key's own extension list had
 * already drifted from a hand-copied twin once (see App.js).
 *
 * Pure: whether the file is a deck is passed in, so this stays free of the
 * deck library and can be tested on its own.
 */

/** Files with a structure view besides their text. Markdown is decided by isMarkdownFile. */
export const STRUCTURE_EXTENSIONS = ['.csv', '.xml', '.xsd', '.wsdl', '.html', '.htm', '.jsp', '.json'];

/**
 * The views by name. English keys, translated where they are drawn
 * (tests/I18nCoverage.test.js reads the labels from this table).
 */
export const VIEWS = {
    text: { label: 'Text View' },
    markdown: { label: 'Markdown View' },
    table: { label: 'Table View' },
    structure: { label: 'Structure View' },
    deck: { label: 'Deck View' },
};

function nameOf(file) {
    return ((file && (file.path || file.name)) || '').toLowerCase();
}

/**
 * Markdown, by name. A buffer with no name at all is the one case with nothing
 * to go on, and it keeps the old default of Markdown.
 */
export function isMarkdownFile(file) {
    const name = nameOf(file);
    if (!name) return true;
    return name.endsWith('.md') || name.endsWith('.markdown');
}

/** Does this file have a structure view (Markdown blocks, table, tree)? */
export function hasStructureView(file) {
    const name = nameOf(file);
    return isMarkdownFile(file) || STRUCTURE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Where Ctrl+Shift+E would take this tab, named for the button: the label is
 * the destination, never "toggle", so it says what a click will show.
 *
 * Null when there is nowhere to go — an Office or PDF preview has one view, a
 * plain .txt / .js has only its text, and Deck View already carries its own
 * "Source" button, which does more than flip (it lands on the slide's line).
 *
 * @param {object} file   the tab
 * @param {object} [opts]
 * @param {boolean} [opts.isDeck]  the file is a jh-presentation deck
 * @returns {{ to: 'text'|'structure'|'deck', label: string } | null}
 */
export function viewSwitchTarget(file, { isDeck = false } = {}) {
    if (!file) return null;
    if (file.type === 'office' || file.type === 'pdf') return null;
    if (file.viewMode === 'deck') return null;
    if (isDeck) return { to: 'deck', label: VIEWS.deck.label };
    if (!hasStructureView(file)) return null;
    if (file.viewMode === 'structure') return { to: 'text', label: VIEWS.text.label };
    return { to: 'structure', label: structureViewOf(file).label };
}

/** Which structure view this file gets: Markdown blocks, the table, or the tree. */
function structureViewOf(file) {
    if (isMarkdownFile(file)) return VIEWS.markdown;
    if (nameOf(file).endsWith('.csv')) return VIEWS.table;
    return VIEWS.structure;
}

/** The name of the view a tab is showing now, for the status bar. */
export function currentViewLabel(file) {
    if (!file) return '';
    if (file.viewMode === 'deck') return VIEWS.deck.label;
    if (file.viewMode !== 'structure') return VIEWS.text.label;
    return structureViewOf(file).label;
}
