import { invoke } from '@tauri-apps/api/core';
import { EditorView, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { StateEffect, Transaction } from '@codemirror/state';
import { foldEffect, foldedRanges, foldService, unfoldEffect } from '@codemirror/language';
import { State } from '../core/Store.js';
import { iconEl } from '../ui/Icons.js';
import { InlineAI } from '../ui/InlineAI.js';
import { t } from '../utils/I18n.js';
import { markSaved } from '../utils/DirtyState.js';
import { hitsUnderFolder, isFolderLine, isPathLine, isUnderFolder, locateHit, planAppend, rowPrefixLength, treePlace } from '../utils/SearchResultsText.js';
import { CodeMirrorView } from './CodeMirrorView.js';

// Renders workspace grep results as a tab of ordinary editable text, grouped by
// file, each hit shown with its whole line. Ctrl+click on a line opens the file
// there; editing the text changes this tab and nothing else. Supports STREAMING:
// the grep-match/grep-done events are owned by the MODEL (Editor.openSearchResults,
// so results keep accumulating into file.matches even while this tab isn't
// active); when active, the model calls appendMatches()/setDone() live. On
// (re)construction the view shows the tab's text, and adds what arrived meanwhile.
/**
 * Send the next `openFile` to the pane the results are NOT in.
 *
 * A results list is something you work THROUGH: opening each hit over the list
 * itself replaces the very thing you are walking down. With the editor split,
 * the other pane is free, so the hit lands there and the list stays put.
 *
 * No-op when there is no split — there is nowhere else to put it.
 */
function openHitInOtherPane() {
    if (!State.splitMode) return;
    State.activePane = State.activePane === 'right' ? 'left' : 'right';
}

const MB = 1024 * 1024;
// Only lines on screen are marked, so this is a guard against a pattern that
// hits at nearly every character of a very long line, not a budget.
const MAX_MARKS_PER_LINE = 500;

const FOLDER_LINE = Decoration.line({ class: 'sr-folder-line' });
const PATH_LINE = Decoration.line({ class: 'sr-path-line' });
const LINK = Decoration.mark({ class: 'sr-link' });
const ROW_LINE = Decoration.line({ class: 'sr-row' });
const ROW_NUMBER = Decoration.mark({ class: 'sr-line-no' });
const HIT = Decoration.mark({ class: 'sr-hit' });

// The tree is how the text is drawn, never what it says: every path stays whole
// in the document, so Ctrl+click, copying and editing see what they always did.
// Only what is on screen is worked out, so a large result costs what a small one does.
const TREE_KEY = 'search_results_tree';
const TREE_STEP = 16;
const HIDDEN = Decoration.replace({});
const BLANK_LINE = Decoration.line({ class: 'sr-blank' });
const refreshTree = StateEffect.define();
const indentLines = new Map();

/** A line drawn `depth` levels in, with a guide down each level it is inside. */
function indentLine(depth) {
    if (!indentLines.has(depth)) {
        indentLines.set(depth, Decoration.line({
            attributes: {
                style: `padding-left: ${depth * TREE_STEP + 6}px;`
                    + `background-image: repeating-linear-gradient(to right, var(--border-color) 0 1px, transparent 1px ${TREE_STEP}px);`
                    + `background-size: ${depth * TREE_STEP}px 100%; background-position: 13px 0; background-repeat: no-repeat;`,
            },
        }));
    }
    return indentLines.get(depth);
}

/** The marker in front of a folder or file in the tree. */
class TreeMarker extends WidgetType {
    constructor(open, folder) {
        super();
        this.open = open;
        this.folder = folder;
    }

    eq(other) { return other.open === this.open && other.folder === this.folder; }

    toDOM() {
        const el = document.createElement('span');
        el.className = 'sr-tree-marker';
        el.title = this.open ? t('Collapse') : t('Expand');
        el.appendChild(iconEl(this.open ? 'caret-down' : 'caret-right', { size: 14 }));
        if (this.folder) el.appendChild(iconEl(this.open ? 'folder-open' : 'folder', { size: 13 }));
        return el;
    }

    // The click is the editor's to see: it opens and closes the row.
    ignoreEvent() { return false; }
}

/** How many hits a file had: drawn beside its path, so the text stays only the path. */
class HitCount extends WidgetType {
    constructor(count) {
        super();
        this.count = count;
    }

    eq(other) { return other.count === this.count; }

    toDOM() {
        const el = document.createElement('span');
        el.className = 'sr-count';
        el.textContent = t('{n} hits', { n: this.count });
        return el;
    }

    ignoreEvent() { return false; }
}

/**
 * How far a running search has got, in words. There is no total to count down
 * to, since finding out would take a walk of its own, so the count of files
 * grows; a large file has a size, so it gets a percentage. A file read for a long
 * while then visibly moves, which is what tells working from hung.
 */
export function describeProgress(p) {
    if (!p) return '';
    const parts = [t('{n} files searched', { n: p.files })];
    // A file filter leaves the file count at 0 for as long as nothing passes
    // it, so the folders are what shows the search is moving.
    if (p.folders) parts.push(t('{n} folders', { n: p.folders }));
    if (!p.current && p.folder) parts.push(String(p.folder).replace(/\\/g, '/').split('/').slice(-2).join('/'));
    if (p.current) {
        const name = String(p.current).replace(/\\/g, '/').split('/').pop();
        const percent = p.current_size > 0 ? Math.floor((p.current_done / p.current_size) * 100) : 0;
        const size = Math.round(p.current_size / MB);
        parts.push(`${name} ${percent}% (${size} MB)`);
    }
    return parts.join('  ·  ');
}

export class SearchResultsView extends CodeMirrorView {
    constructor(container, file, options = {}) {
        const { renderTabs } = options;
        super(container, {
            ...options,
            // Results arriving are not an edit: nothing on the tab changes.
            renderTabs: () => { if (renderTabs && !this._appending) renderTabs(); },
        });
        this._outer = container;
        this.file = file;
        this.query = file.query || '';
        this._searchOptions = file.options || {};
        this.searchId = file.searchId;
        this.streaming = !!file.streaming;
        // What is on the model outlives the view: switching tabs destroys and
        // rebuilds this, and the text may hold the user's edits by then.
        if (!(file._srGroups instanceof Map)) file._srGroups = new Map();
        if (!(file._srCounts instanceof Map)) file._srCounts = new Map();
        if (typeof file._srShown !== 'number') file._srShown = 0;
        if (typeof file.content !== 'string') file.content = '';
        if (!Array.isArray(file.matches)) file.matches = [];
        this._done = !!file._done;
        this._truncated = !!file._truncated;
        this._canceled = !!file._canceled;
        this._progress = file._progress || null;
        this._injectStyles();
        this._re = this._highlighter();
        this.render(file.content, file);
        this.appendMatches();
    }

    setDone(truncated, canceled = false) {
        this._done = true;
        this._truncated = !!truncated;
        this._canceled = !!canceled;
        this._updateHeader();
    }

    /** Only the line that changed: this arrives several times a second. */
    setProgress(progress) {
        this._progress = progress;
        if (this._progressEl) this._progressEl.textContent = describeProgress(progress);
    }

    _cancelSearch() {
        invoke('cancel_grep', { searchId: this.searchId }).catch(() => {});
    }

    _injectStyles() {
        if (document.getElementById('search-results-styles')) return;
        const style = document.createElement('style');
        style.id = 'search-results-styles';
        style.textContent = `
        .search-results-view { height: 100%; display: flex; flex-direction: column; overflow: hidden; font-size: 13px; color: var(--text-color); }
        .sr-header { flex-shrink: 0; padding: 6px 12px 2px; opacity: 0.85; display: flex; align-items: center; gap: 8px; }
        .sr-summary { flex: 0 1 auto; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sr-progress { flex: 0 0 auto; opacity: 0.7; font-size: 12px; white-space: nowrap; }
        .sr-cancel { margin-left: auto; flex-shrink: 0; padding: 2px 10px; font-size: 12px; cursor: pointer; color: var(--text-color); background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 4px; }
        .sr-cancel:hover { background: var(--hover-color); border-color: var(--primary-color); }
        .sr-spinner { width: 12px; height: 12px; border: 2px solid var(--border-color); border-top-color: var(--primary-color); border-radius: 50%; animation: sr-spin 0.7s linear infinite; }
        @keyframes sr-spin { to { transform: rotate(360deg); } }
        .sr-hint { flex-shrink: 0; padding: 0 12px 6px; font-size: 12px; opacity: 0.6; border-bottom: 1px solid var(--border-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sr-editor { flex: 1; min-height: 0; position: relative; }
        .sr-tree-toggle { margin-left: auto; flex-shrink: 0; padding: 2px 10px; font-size: 12px; cursor: pointer; color: var(--text-color); background: var(--bg-color); border: 1px solid var(--border-color); border-radius: 4px; }
        .sr-tree-toggle:hover { background: var(--hover-color); }
        .sr-tree-toggle[aria-pressed="true"] { color: var(--primary-color); border-color: var(--primary-color); }
        .sr-tree-toggle + .sr-cancel { margin-left: 0; }
        .sr-editor.sr-tree .cm-gutter.cm-foldGutter { display: none !important; }
        .sr-editor.sr-tree .sr-folder-line, .sr-editor.sr-tree .sr-path-line { cursor: pointer; }
        .sr-editor.sr-tree .sr-folder-line:hover, .sr-editor.sr-tree .sr-path-line:hover { background-color: var(--hover-color); }
        .sr-editor.sr-tree .sr-folder-line { opacity: 1; }
        .sr-editor.sr-tree .sr-link { text-decoration: none; }
        .sr-editor.sr-tree .sr-blank { line-height: 4px; }
        .sr-tree-marker { display: inline-flex; align-items: center; gap: 3px; margin-right: 4px; vertical-align: -2px; color: var(--text-secondary); }
        .sr-folder-line { font-weight: 600; opacity: 0.75; }
        .sr-path-line { color: var(--primary-color); font-weight: 600; }
        .sr-editor .cm-foldGutter .cm-gutterElement { padding: 0 4px; cursor: pointer; color: var(--primary-color); }
        .sr-fold-marker { display: inline-flex; align-items: center; height: 100%; }
        .sr-link { text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
        .sr-count { margin-left: 8px; font-weight: normal; color: var(--text-color); opacity: 0.7; }
        .sr-line-no { opacity: 0.5; }
        .sr-hit { background: var(--search-highlight, #ffd54f66); border-radius: 2px; }
        /* Holding Ctrl over the text says which rows lead somewhere. */
        .sr-ctrl .sr-row:hover { cursor: pointer; text-decoration: underline; }
        `;
        document.head.appendChild(style);
    }

    _highlighter() {
        const { query, _searchOptions: options } = this;
        if (!query) return null;
        try {
            if (this.file.highlight) return new RegExp(this.file.highlight, 'gi');
            let src = options && options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (options && options.wholeWord) src = `\\b(?:${src})\\b`;
            return new RegExp(src, options && options.caseSensitive ? 'g' : 'gi');
        } catch (_) { return null; }
    }

    _isKnownPath = (path) => !!this.file && this.file._srGroups.has(path);

    /** The hits on one row's own text, not its number; empty matches mark nothing. */
    _hitRanges(text) {
        const out = [];
        const re = this._re;
        if (!re) return out;
        re.lastIndex = 0;
        let m;
        while (out.length < MAX_MARKS_PER_LINE && (m = re.exec(text)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            out.push([m.index, m.index + m[0].length]);
        }
        return out;
    }

    _decorationsFor(view) {
        const ranges = [];
        const hidden = [];
        const { doc } = view.state;
        const tree = this._treeMode();
        let lastLine = 0;
        for (const { from, to } of view.visibleRanges) {
            let rowDepth = tree ? this._rowDepthAt(doc, doc.lineAt(from).number) : 0;
            for (let pos = from; pos <= to;) {
                const line = doc.lineAt(pos);
                pos = line.to + 1;
                if (line.number === lastLine) continue;
                lastLine = line.number;
                const prefix = rowPrefixLength(line.text);
                if (prefix === null) {
                    const folder = isFolderLine(line.text);
                    if (!folder && !isPathLine(line.text, this._isKnownPath)) {
                        if (tree) {
                            if (line.text.trim()) ranges.push(indentLine(rowDepth).range(line.from));
                            else ranges.push(BLANK_LINE.range(line.from));
                        }
                        continue;
                    }
                    ranges.push((folder ? FOLDER_LINE : PATH_LINE).range(line.from));
                    const trimmed = line.text.trimEnd();
                    const place = tree ? treePlace(trimmed, this.file.root) : null;
                    if (place) {
                        rowDepth = place.depth + (folder ? 0 : 1);
                        ranges.push(indentLine(place.depth).range(line.from));
                        ranges.push(Decoration.widget({
                            widget: new TreeMarker(!this._isClosed(view.state, line.to), folder),
                            side: -1,
                        }).range(line.from));
                        hidden.push(HIDDEN.range(line.from, line.from + place.nameFrom));
                        if (place.nameTo < trimmed.length) hidden.push(HIDDEN.range(line.from + place.nameTo, line.from + trimmed.length));
                        ranges.push(LINK.range(line.from + place.nameFrom, line.from + place.nameTo));
                    } else {
                        if (tree) rowDepth = 1;
                        ranges.push(LINK.range(line.from, line.from + trimmed.length));
                    }
                    const count = tree && folder
                        ? hitsUnderFolder(this.file._srCounts, trimmed)
                        : this.file._srCounts.get(trimmed);
                    if (count) {
                        ranges.push(Decoration.widget({ widget: new HitCount(count), side: 1 }).range(line.to));
                    }
                    continue;
                }
                ranges.push(ROW_LINE.range(line.from));
                if (tree) ranges.push(indentLine(rowDepth).range(line.from));
                ranges.push(ROW_NUMBER.range(line.from, line.from + prefix));
                const start = line.from + prefix;
                for (const [a, b] of this._hitRanges(line.text.slice(prefix))) {
                    ranges.push(HIT.range(start + a, start + b));
                }
            }
        }
        return {
            decorations: Decoration.set([...ranges, ...hidden], true),
            hidden: Decoration.set(hidden, true),
        };
    }

    /** Is the folder or file whose line ends at `lineEnd` closed? */
    _isClosed(state, lineEnd) {
        let closed = false;
        foldedRanges(state).between(lineEnd, lineEnd, (from) => { if (from === lineEnd) closed = true; });
        return closed;
    }

    /** How deep the rows at this line are drawn: one in from the file above them. */
    _rowDepthAt(doc, number) {
        for (let n = number; n >= 1; n--) {
            const { text } = doc.line(n);
            if (!isPathLine(text, this._isKnownPath)) continue;
            const place = treePlace(text, this.file.root);
            return place ? place.depth + (isFolderLine(text) ? 0 : 1) : 1;
        }
        return 0;
    }

    /** A results tab from a folder search can be drawn as that folder's tree. */
    _treeMode() {
        if (!this.file || !this.file.root) return false;
        try { return localStorage.getItem(TREE_KEY) !== 'false'; } catch (_) { return true; }
    }

    _setTreeMode(on) {
        try { localStorage.setItem(TREE_KEY, on ? 'true' : 'false'); } catch (_) { /* private mode */ }
        this._syncTreeChrome();
        if (this.editorView) this.editorView.dispatch({ effects: refreshTree.of(null) });
    }

    _syncTreeChrome() {
        const on = this._treeMode();
        if (this.container) this.container.classList.toggle('sr-tree', on);
        if (this._treeToggleEl) this._treeToggleEl.setAttribute('aria-pressed', String(on));
    }

    _showsLineNumbers() { return false; } // each row carries its file's line number

    /** Opening and closing a file is a main way through the results: make it visible. */
    _foldGutterConfig() {
        return {
            markerDOM: (open) => {
                const marker = document.createElement('span');
                marker.className = 'sr-fold-marker';
                marker.title = open ? t('Collapse') : t('Expand');
                marker.appendChild(iconEl(open ? 'caret-down' : 'caret-right', { size: 16 }));
                return marker;
            },
        };
    }

    _extraExtensions() {
        const owner = this;
        const drawn = ViewPlugin.fromClass(class {
            constructor(view) { Object.assign(this, owner._decorationsFor(view)); }
            update(update) {
                if (update.docChanged || update.viewportChanged
                    || foldedRanges(update.startState) !== foldedRanges(update.state)
                    || update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshTree)))) {
                    Object.assign(this, owner._decorationsFor(update.view));
                }
            }
        }, {
            decorations: (plugin) => plugin.decorations,
            // The cursor steps over the hidden part of a path instead of into it.
            provide: (plugin) => EditorView.atomicRanges.of((view) => {
                const value = view.plugin(plugin);
                return value ? value.hidden : Decoration.none;
            }),
        });
        return [
            drawn,
            // A file folds away its rows, up to the blank line or the next file;
            // a folder folds away everything under it.
            foldService.of((state, from) => this._foldableGroup(state, from)),
            // Ctrl+click here is the way to the file, not an extra cursor.
            EditorView.clickAddsSelectionRange.of(() => false),
            EditorView.domEventHandlers({
                mousemove: (event, view) => {
                    view.scrollDOM.classList.toggle('sr-ctrl', event.ctrlKey || event.metaKey);
                },
                // A path opens and closes what is under it. Ctrl+click goes to it
                // from the editor's own handler; a drag across it is a selection.
                click: (event, view) => {
                    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
                    if (!view.state.selection.main.empty) return false;
                    // In the tree the whole row is the handle, as in any tree.
                    const row = this._treeMode() ? event.target.closest('.sr-folder-line, .sr-path-line') : null;
                    if (!row && !event.target.closest('.sr-link')) return false;
                    this._toggleGroup(view.posAtDOM(row || event.target), view);
                    return true;
                },
            }),
            // Where each group ends has to follow what the user types. A sibling
            // pane's copy of the same change is already counted by its source.
            EditorView.updateListener.of((update) => {
                if (!update.docChanged || this._appending || this._applyingRemote) return;
                const groups = this.file._srGroups;
                for (const [path, at] of groups) groups.set(path, update.changes.mapPos(at, 1));
            }),
        ];
    }

    _foldableGroup(state, from) {
        const { doc } = state;
        const head = doc.lineAt(from);
        if (!isPathLine(head.text, this._isKnownPath)) return null;
        const folder = isFolderLine(head.text);
        let end = head;
        for (let n = head.number + 1; n <= doc.lines; n++) {
            const line = doc.line(n);
            const blank = !line.text.trim();
            if (folder) {
                if (isPathLine(line.text, this._isKnownPath) && !isUnderFolder(line.text, head.text)) break;
                if (blank) continue;
            } else if (blank || isPathLine(line.text, this._isKnownPath)) break;
            end = line;
        }
        return end === head ? null : { from: head.to, to: end.to };
    }

    _toggleGroup(pos, view) {
        const { state } = view;
        const { to: head } = state.doc.lineAt(pos);
        let closed = null;
        foldedRanges(state).between(head, head, (from, to) => {
            if (from === head) closed = { from, to };
        });
        if (closed) {
            view.dispatch({ effects: unfoldEffect.of(closed) });
            return;
        }
        const range = this._foldableGroup(state, pos);
        if (range) view.dispatch({ effects: foldEffect.of(range) });
    }

    _handleModClick(pos, view) {
        const { doc } = view.state;
        const { text, number } = doc.lineAt(pos);
        if (isFolderLine(text)) {
            window.app.openDirectory(text.trimEnd().replace(/[\\/]+$/, ''));
            return;
        }
        const hit = locateHit((n) => doc.line(n).text, number, this._isKnownPath);
        if (!hit) return;
        try {
            openHitInOtherPane();
            // forcePlainText: grep reports line numbers, and only the plain-text
            // editor can jump to one (structure/CSV views aren't line-addressable).
            window.app.openFile(hit.path, false, hit.line, hit.line !== null);
        } catch (e) { console.warn(e); }
    }

    _isDirtyAfterChange() {
        // Results arriving are not an edit, nor is a change the other pane made.
        if (this._appending || this._applyingRemote) return !!this.file.isDirty;
        return super._isDirtyAfterChange();
    }

    toggleBookMode() {} // results are worked through as text

    render(content, file) {
        if (this.editorView) this.destroy();
        if (!this.inlineAI) this.inlineAI = new InlineAI(this);
        this.file = file;

        this._outer.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'search-results-view';

        this._headerEl = document.createElement('div');
        this._headerEl.className = 'sr-header';
        const hint = document.createElement('div');
        hint.className = 'sr-hint';
        hint.textContent = t('Editable text: the searched files do not change. Click a path to show or hide what is under it, or Ctrl+Click it or a line to go there.');
        hint.title = hint.textContent;
        const host = document.createElement('div');
        host.className = 'sr-editor';
        root.append(this._headerEl, hint, host);
        this._outer.appendChild(root);

        this._buildHeader();
        this._updateHeader();

        this.container = host;
        this._syncTreeChrome();
        const toolbar = document.createElement('div');
        toolbar.className = 'cm-view-toolbar';
        host.appendChild(toolbar);
        this._viewToolbar = toolbar;
        this._renderEditor(content);
        this._restoreFolds();

        // A tab nobody has edited is clean, and undoing back to this is too.
        if (!file.isDirty) markSaved(file);
    }

    /**
     * The parts of the header are made once and only their text changes. Matches
     * arrive many times a second, and rebuilding the header each time took the
     * Cancel button out of the page under the pointer: between press and release
     * it had been removed, so the browser never called it a click.
     */
    _buildHeader() {
        const parts = [];
        if (this.streaming && !this._done) {
            this._spinnerEl = document.createElement('span');
            this._spinnerEl.className = 'sr-spinner';
            parts.push(this._spinnerEl);
        }
        this._summaryEl = document.createElement('span');
        this._summaryEl.className = 'sr-summary';
        parts.push(this._summaryEl);
        if (this.streaming && !this._done) {
            this._progressEl = document.createElement('span');
            this._progressEl.className = 'sr-progress';
            this._progressEl.textContent = describeProgress(this._progress);
            this._cancelBtn = document.createElement('button');
            this._cancelBtn.className = 'sr-cancel';
            this._cancelBtn.textContent = t('Cancel');
            this._cancelBtn.onclick = () => this._cancelSearch();
            parts.push(this._progressEl);
        }
        if (this.file.root) {
            this._treeToggleEl = document.createElement('button');
            this._treeToggleEl.className = 'sr-tree-toggle';
            this._treeToggleEl.textContent = t('Tree view');
            this._treeToggleEl.title = t('Draw the results as a folder tree. The text itself keeps the full paths: turn this off to see and edit them.');
            this._treeToggleEl.onclick = () => this._setTreeMode(!this._treeMode());
            parts.push(this._treeToggleEl);
        }
        if (this._cancelBtn) parts.push(this._cancelBtn);
        this._headerEl.append(...parts);
    }

    _updateHeader() {
        if (!this._summaryEl) return;
        const running = this.streaming && !this._done;
        const total = this.file._srShown;
        const files = [...this.file._srGroups.keys()].filter((path) => !isFolderLine(path)).length;
        const base = `${t('{files} files, {hits} hits', { files, hits: total })}  —  "${this.query}"`;
        const text = running ? `${t('Searching…')}  ${base}`
            : (total === 0 && !this._canceled ? t('No results for "{query}"', { query: this.query }) : base)
              // Zero hits from zero files is a different problem from zero hits.
              + (total === 0 && !this._canceled && this._progress
                  ? `  (${t('{n} files searched', { n: this._progress.files })}  ·  ${t('{n} folders', { n: this._progress.folders })})` : '')
              + (this._truncated ? ` (${t('Stopped at the result limit. Settings can raise it.')})` : '')
              + (this._canceled ? ` (${t('canceled')})` : '');
        this._summaryEl.textContent = text;
        this._summaryEl.title = text;
        if (!running) {
            for (const el of [this._spinnerEl, this._progressEl, this._cancelBtn]) {
                if (el) el.remove();
            }
            this._spinnerEl = this._progressEl = this._cancelBtn = null;
        }
    }

    /**
     * Bring the text up to date with file.matches. Kept out of the undo history:
     * Ctrl+Z takes back what the user typed, not the results.
     */
    appendMatches() {
        const { file, editorView } = this;
        const pending = file.matches.slice(file._srShown);
        if (pending.length && editorView) {
            for (const { path } of pending) file._srCounts.set(path, (file._srCounts.get(path) || 0) + 1);
            const changes = editorView.state.changes(
                planAppend(pending, file._srGroups, editorView.state.doc.length, file.root),
            );
            const closed = this._closedRanges();
            this._appending = true;
            try {
                editorView.dispatch({ changes, annotations: Transaction.addToHistory.of(false) });
            } finally {
                this._appending = false;
            }
            file._srShown += pending.length;
            if (!file.isDirty) markSaved(file);
            this._refold(closed, changes);
        }
        this._updateHeader();
    }

    _closedRanges() {
        const out = [];
        const { state } = this.editorView;
        foldedRanges(state).between(0, state.doc.length, (from, to) => { out.push({ from, to }); });
        return out;
    }

    /**
     * What is added to a closed file or folder goes in at the edge of its fold, and
     * would show outside it: close each again around what it holds now.
     */
    _refold(closed, changes) {
        if (!closed.length) return;
        const { state } = this.editorView;
        const effects = this._closedRanges().map((range) => unfoldEffect.of(range));
        for (const { from, to } of closed) {
            const range = this._foldableGroup(state, changes.mapPos(from, -1))
                || { from: changes.mapPos(from, 1), to: changes.mapPos(to, -1) };
            if (range.to > range.from) effects.push(foldEffect.of(range));
        }
        this.editorView.dispatch({ effects });
    }

    _restoreFolds() {
        const { file, editorView } = this;
        if (!file._srFolds || !file._srFolds.length) return;
        const length = editorView.state.doc.length;
        const effects = file._srFolds.filter((r) => r.to <= length).map((r) => foldEffect.of(r));
        if (effects.length) editorView.dispatch({ effects });
    }

    destroy() {
        // Streaming listeners live on the model (see Editor.openSearchResults),
        // not the view, so they survive tab switches — nothing to tear down here.
        if (this.editorView) this.file._srFolds = this._closedRanges();
        super.destroy();
        if (this._outer) this._outer.innerHTML = '';
    }
}
