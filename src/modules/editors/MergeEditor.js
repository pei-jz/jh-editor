/**
 * MergeEditor.js — a side-by-side comparison where either side can be edited.
 *
 * This replaces DiffEditor, whose model was "original on the left, modified on
 * the right, Accept / Reject per block, then Apply & Save". That had three
 * problems the model itself caused:
 *
 *  - Nothing on screen said which side could be written or where Apply went.
 *    Git and agent diffs showed the same buttons and Apply simply closed them.
 *  - Decisions lived in the rendered hunks, so toggling the view, the
 *    whitespace option or the tab reset every block to Accept — while the
 *    source tab had already been handed the rejected text.
 *  - Only one direction existed. Two files could not be merged toward the left.
 *
 * Here each pane is a CodeMirror editor over its side's own text
 * (utils/MergeSides.js). A side is either writable — typed into directly, or
 * given a block with ← / → — or read-only, and the header says which. Nothing
 * reaches disk until the tab is saved, which writes each edited side to its own
 * target. Because the texts live on the tab's file object, redrawing loses
 * nothing: the diff is recomputed from what the panes hold.
 *
 * The change being worked on is outlined on both sides, and its ← / → controls
 * sit on a band as tall as the change, so the buttons read as belonging to it.
 */
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
import {
    EditorView, Decoration, keymap, lineNumbers, highlightSpecialChars, drawSelection,
    highlightActiveLine, highlightWhitespace,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import {
    MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk, getChunks, getOriginalDoc, Change,
} from '@codemirror/merge';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { t } from '../utils/I18n.js';
import { languageExtensionFor, syntaxExtensionForTheme } from '../views/CodeMirrorView.js';
import {
    canCopyToward, mergeDirty, sideDirty, blockCopyEdit, whitespaceInsensitiveChanges,
} from '../utils/MergeSides.js';

// Long unchanged stretches fold away, keeping a few lines of context.
const COLLAPSE = { margin: 3, minSize: 8 };

// Selections the comparison makes itself, so they do not count as the user
// moving away from the word being looked at.
const OWN_SELECTION = 'select.merge';

const readFlag = (key) => {
    try { return localStorage.getItem(key) === 'true'; } catch (_) { return false; }
};
const writeFlag = (key, on) => {
    try { localStorage.setItem(key, on ? 'true' : 'false'); } catch (_) { /* private mode */ }
};

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** Lines a chunk covers in `doc` (0 when it is an empty range on that side). */
function linesIn(doc, from, to) {
    if (to <= from) return 0;
    const last = Math.max(from, Math.min(doc.length, to) - 1);
    return doc.lineAt(last).number - doc.lineAt(from).number + 1;
}

/**
 * What a key press does in the comparison, or null for "not ours".
 *
 *   Alt+↑ / Alt+↓            previous / next change
 *   Alt+← / Alt+→            previous / next change inside a line (word level)
 *   Alt+Shift+← / Alt+Shift+→ copy the current change to that side
 *   Alt+I / Alt+W            ignore / show whitespace
 *   Ctrl+↑ / Ctrl+↓          previous / next file (Git comparisons only)
 */
export function mergeKeyAction(e, { hasFileNav = false } = {}) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        if (!hasFileNav) return null;
        return e.key === 'ArrowDown' ? 'next-file' : 'prev-file';
    }
    if (!e.altKey || mod) return null;
    if (e.shiftKey) {
        if (e.key === 'ArrowLeft') return 'copy-left';
        if (e.key === 'ArrowRight') return 'copy-right';
        return null;
    }
    switch (e.key) {
        case 'ArrowUp': return 'prev-change';
        case 'ArrowDown': return 'next-change';
        case 'ArrowLeft': return 'prev-inline';
        case 'ArrowRight': return 'next-inline';
        case 'i': case 'I': return 'ignore-whitespace';
        case 'w': case 'W': return 'show-whitespace';
        default: return null;
    }
}

// ── The outline around the current change ────────────────────────────────────

const setFocus = StateEffect.define();

/**
 * Line decorations drawing a rounded frame round `focus.from..to`, plus a mark
 * on the word-level change inside it. A side where the change has no lines
 * gets a rule where the other side's lines would go instead.
 */
function focusDecorations(state, focus) {
    if (!focus) return Decoration.none;
    const { doc } = state;
    const ranges = [];
    if (focus.to > focus.from) {
        const first = doc.lineAt(Math.min(focus.from, doc.length)).number;
        const last = doc.lineAt(Math.max(focus.from, Math.min(doc.length, focus.to) - 1)).number;
        for (let n = first; n <= last; n++) {
            let cls = 'cm-merge-focus';
            if (n === first) cls += ' cm-merge-focus-top';
            if (n === last) cls += ' cm-merge-focus-bottom';
            ranges.push(Decoration.line({ class: cls }).range(doc.line(n).from));
        }
    } else {
        const pos = Math.min(focus.from, doc.length);
        const line = doc.lineAt(pos);
        const after = pos >= doc.length && line.from < pos;
        ranges.push(Decoration.line({ class: after ? 'cm-merge-focus-gap-after' : 'cm-merge-focus-gap-before' })
            .range(line.from));
    }
    const inlineFrom = Math.min(focus.inlineFrom ?? 0, doc.length);
    const inlineTo = Math.min(focus.inlineTo ?? 0, doc.length);
    if (inlineTo > inlineFrom) {
        ranges.push(Decoration.mark({ class: 'cm-merge-inline-focus' }).range(inlineFrom, inlineTo));
    }
    return Decoration.set(ranges, true);
}

const focusField = StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setFocus)) return focusDecorations(tr.state, effect.value);
        }
        return deco.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
});

const FOCUS = 'var(--primary-color, #3794ff)';

const mergeTheme = EditorView.theme({
    '&': {
        color: 'var(--text-color)',
        backgroundColor: 'transparent',
        fontSize: 'var(--editor-font-size, 11.5pt)',
        fontFamily: "var(--editor-font-family, Consolas, 'Courier New', monospace)",
        lineHeight: 'var(--editor-line-height-px, 22px)',
    },
    '.cm-content': { caretColor: 'var(--text-color)' },
    '.cm-line': { paddingLeft: '4px' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text-color)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'var(--cm-selection-bg, rgba(51, 144, 250, 0.18))',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(127, 127, 127, 0.06)' },
    '.cm-gutters': {
        backgroundColor: 'var(--bg-color)',
        color: 'var(--text-secondary)',
        border: 'none',
    },
    // Removed on the left, added on the right, in the colours the old view used.
    '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': {
        backgroundColor: 'rgba(248, 81, 73, 0.14)',
    },
    '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
        backgroundColor: 'rgba(46, 160, 67, 0.14)',
    },
    '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': {
        background: 'rgba(248, 81, 73, 0.4)',
        borderRadius: '2px',
    },
    '&.cm-merge-b .cm-changedText': {
        background: 'rgba(46, 160, 67, 0.4)',
        borderRadius: '2px',
    },
    '&.cm-merge-a .cm-changedLineGutter': { background: '#f85149' },
    '&.cm-merge-b .cm-changedLineGutter': { background: '#3fb950' },
    '.cm-collapsedLines': {
        color: 'var(--text-secondary)',
        background: 'var(--bg-color-secondary)',
    },
    // Inset shadows rather than borders: a border would push the text over.
    '.cm-merge-focus': {
        boxShadow: `inset 2px 0 0 ${FOCUS}, inset -2px 0 0 ${FOCUS}`,
    },
    '.cm-merge-focus.cm-merge-focus-top': {
        boxShadow: `inset 2px 0 0 ${FOCUS}, inset -2px 0 0 ${FOCUS}, inset 0 2px 0 ${FOCUS}`,
        borderTopLeftRadius: '6px',
        borderTopRightRadius: '6px',
    },
    '.cm-merge-focus.cm-merge-focus-bottom': {
        boxShadow: `inset 2px 0 0 ${FOCUS}, inset -2px 0 0 ${FOCUS}, inset 0 -2px 0 ${FOCUS}`,
        borderBottomLeftRadius: '6px',
        borderBottomRightRadius: '6px',
    },
    '.cm-merge-focus.cm-merge-focus-top.cm-merge-focus-bottom': {
        boxShadow: `inset 0 0 0 2px ${FOCUS}`,
        borderRadius: '6px',
    },
    '.cm-merge-focus-gap-before': { boxShadow: `inset 0 2px 0 ${FOCUS}` },
    '.cm-merge-focus-gap-after': { boxShadow: `inset 0 -2px 0 ${FOCUS}` },
    '.cm-merge-inline-focus': {
        outline: `2px solid ${FOCUS}`,
        outlineOffset: '1px',
        borderRadius: '2px',
    },
});

export class MergeEditor {
    /**
     * @param {HTMLElement} container
     * @param {object} file     the tab; `file.merge` holds { title, path, nav, left, right }
     * @param {object} options
     *   onDirtyChange()   the tab's unsaved state flipped (redraw the tab strip)
     *   onSave()          save the tab (Ctrl+S goes the same way)
     *   extraActions      [{ label, title, onClick }] extra toolbar buttons
     */
    constructor(container, file, options = {}) {
        this.container = container;
        this.file = file;
        this.merge = file.merge;
        this.options = options;

        this.ignoreWhitespace = readFlag('diff_ignoreWhitespace');
        this.showWhitespace = readFlag('diff_showWhitespace');
        this.viewMode = 'split';
        this.mergeView = null;
        this.unifiedView = null;
        this._lastFocused = null;
        this._refreshTimer = null;
        this._layoutFrame = null;
        this._inline = null;        // the word-level change last navigated to
        this._hoverChunk = null;    // chunk whose copy band the pointer is over
        this._focusIndex = -1;      // chunk currently outlined
        this._appliedFocusKey = '';

        this.syntaxCompartment = new Compartment();
        this.whitespaceCompartment = new Compartment();

        this._onThemeChanged = () => {
            this._forEachEditor((ed) => ed.dispatch({
                effects: this.syntaxCompartment.reconfigure(syntaxExtensionForTheme()),
            }));
        };
        window.addEventListener('themeChanged', this._onThemeChanged);

        this._onKeyDown = this._onKeyDown.bind(this);
        window.addEventListener('keydown', this._onKeyDown, true);

        this._build();
    }

    // ── Layout ───────────────────────────────────────────────────────────────

    _build() {
        const c = this.container;
        c.innerHTML = '';
        c.classList.add('merge-editor');
        // The editor area pads its content for documents; a comparison is a
        // tool surface and uses the whole pane, like the editor tab does.
        c.style.padding = '0';
        c.style.overflow = 'hidden';
        c.style.display = 'flex';
        c.style.flexDirection = 'column';
        c.appendChild(this._buildToolbar());

        this.headersEl = el('div', 'merge-headers');
        c.appendChild(this.headersEl);

        this.bodyEl = el('div', 'merge-body');
        this.minimapEl = el('div', 'diff-minimap');
        this.minimapEl.title = t('Distribution of changes (click to jump)');
        this.minimapViewportEl = el('div', 'diff-minimap-viewport');
        this.minimapEl.appendChild(this.minimapViewportEl);
        this.minimapEl.addEventListener('click', (e) => this._onMinimapClick(e));
        this.bodyEl.appendChild(this.minimapEl);
        c.appendChild(this.bodyEl);

        this._mountEditors();
    }

    _button(text, title, onClick, className = 'diff-btn') {
        const b = el('button', className, text);
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    _buildToolbar() {
        const bar = el('div', 'diff-toolbar');

        const title = el('div', 'diff-toolbar-title');
        title.appendChild(el('strong', null, this.merge.title || ''));
        bar.appendChild(title);

        const actions = el('div', 'diff-toolbar-actions');

        this.summaryEl = el('div', 'diff-summary');
        actions.appendChild(this.summaryEl);

        const nav = el('div', 'diff-nav');
        nav.appendChild(this._button('↑', t('Previous change (Alt+Up)'), () => this.navigate(-1)));
        this.navLabel = el('span', 'diff-nav-label');
        nav.appendChild(this.navLabel);
        nav.appendChild(this._button('↓', t('Next change (Alt+Down)'), () => this.navigate(1)));
        actions.appendChild(nav);

        const inlineNav = el('div', 'diff-nav');
        inlineNav.appendChild(this._button('‹', t('Previous inline change (Alt+Left)'), () => this.navigateInline(-1)));
        this.inlineLabel = el('span', 'diff-nav-label');
        inlineNav.appendChild(this.inlineLabel);
        inlineNav.appendChild(this._button('›', t('Next inline change (Alt+Right)'), () => this.navigateInline(1)));
        actions.appendChild(inlineNav);

        // Bulk copies, only toward a side that can take them.
        this.copyAllLeftBtn = this._button(`⇐ ${t('Copy all')}`, t('Copy all changes to the left'),
            () => this.copyAll('left'));
        this.copyAllRightBtn = this._button(`${t('Copy all')} ⇒`, t('Copy all changes to the right'),
            () => this.copyAll('right'));
        actions.appendChild(this.copyAllLeftBtn);
        actions.appendChild(this.copyAllRightBtn);

        for (const extra of this.options.extraActions || []) {
            actions.appendChild(this._button(extra.label, extra.title || '', extra.onClick));
        }

        this.ignoreWsBtn = this._button(t('Ignore whitespace'),
            t('Ignore whitespace differences (indentation, trailing spaces, run length) — Alt+I'),
            () => this.toggleIgnoreWhitespace(), 'diff-btn diff-ws-btn');
        this.ignoreWsBtn.appendChild(el('span', 'diff-btn-key', 'Alt+I'));
        this.ignoreWsBtn.classList.toggle('active', this.ignoreWhitespace);
        actions.appendChild(this.ignoreWsBtn);

        this.showWsBtn = this._button(t('Show whitespace'),
            t('Show whitespace characters (spaces / tabs) — Alt+W'),
            () => this.toggleShowWhitespace(), 'diff-btn diff-ws-view-btn');
        this.showWsBtn.appendChild(el('span', 'diff-btn-key', 'Alt+W'));
        this.showWsBtn.classList.toggle('active', this.showWhitespace);
        actions.appendChild(this.showWsBtn);

        this.viewToggleBtn = this._button('', '', () => this.toggleViewMode());
        actions.appendChild(this.viewToggleBtn);

        // A tab with nothing it could ever write has no Save button at all.
        const saveable = ['left', 'right'].some((k) => this.merge[k].writable && !this.merge[k].live);
        if (saveable) {
            this.saveBtn = this._button(t('Save'), 'Ctrl+S', () => this._save(), 'diff-primary-btn');
            actions.appendChild(this.saveBtn);
        }

        bar.appendChild(actions);
        return bar;
    }

    _renderHeaders() {
        const h = this.headersEl;
        h.innerHTML = '';
        const header = (key) => {
            const side = this.merge[key];
            const box = el('div', `merge-header merge-header-${key}`);
            const label = el('span', 'merge-header-label', side.label);
            label.title = side.label;
            box.appendChild(label);
            box.appendChild(el('span', `merge-badge ${side.writable ? 'is-writable' : 'is-readonly'}`,
                side.writable ? t('Editable') : t('Read-only')));
            if (sideDirty(side)) box.appendChild(el('span', 'merge-badge is-unsaved', t('Unsaved')));
            return box;
        };

        if (this.viewMode === 'unified') {
            const box = el('div', 'merge-header');
            box.appendChild(el('span', 'merge-header-label',
                `${this.merge.left.label}  →  ${this.merge.right.label}`));
            box.appendChild(el('span', 'merge-note',
                t('Unified view is read-only. Switch to side-by-side view to edit.')));
            h.appendChild(box);
            return;
        }
        h.appendChild(header('left'));
        if (this._hasCopyControls()) h.appendChild(el('div', 'merge-header-gap'));
        h.appendChild(header('right'));
    }

    _hasCopyControls() {
        return canCopyToward(this.merge, 'left') || canCopyToward(this.merge, 'right');
    }

    // ── Editors ──────────────────────────────────────────────────────────────

    _commonExtensions(writable) {
        const lang = languageExtensionFor(this.merge.path);
        return [
            lineNumbers(),
            highlightSpecialChars(),
            drawSelection(),
            highlightActiveLine(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            lang || [],
            this.syntaxCompartment.of(syntaxExtensionForTheme()),
            this.whitespaceCompartment.of(this.showWhitespace ? highlightWhitespace() : []),
            EditorState.readOnly.of(!writable),
            focusField,
            mergeTheme,
        ];
    }

    /** React to an editor update: edits, cursor moves, layout changes. */
    _onEditorUpdate(u, key) {
        if (u.focusChanged && u.view.hasFocus) this._lastFocused = u.view;
        if (u.selectionSet && !u.transactions.some((tr) => tr.isUserEvent(OWN_SELECTION))) {
            // The user moved on; the word-level highlight follows the cursor now.
            this._inline = null;
        }
        if (u.docChanged && key) this._sideChanged(key, u.state.doc.toString());
        else if (u.selectionSet || u.docChanged) this._queueRefresh();
        if (u.geometryChanged || u.viewportChanged) this._scheduleControlLayout();
    }

    _sideExtensions(key) {
        const side = this.merge[key];
        return [
            ...this._commonExtensions(side.writable),
            EditorView.updateListener.of((u) => this._onEditorUpdate(u, key)),
        ];
    }

    _diffConfig() {
        if (!this.ignoreWhitespace) return { scanLimit: 500, timeout: 2000 };
        return {
            override: (a, b) => whitespaceInsensitiveChanges(a, b)
                .map((c) => new Change(c.fromA, c.toA, c.fromB, c.toB)),
        };
    }

    _mergeConfig() {
        const controls = this._hasCopyControls();
        return {
            orientation: 'a-b',
            highlightChanges: true,
            gutter: true,
            collapseUnchanged: COLLAPSE,
            diffConfig: this._diffConfig(),
            // The package only knows one direction per view. It is asked for its
            // gap column; the buttons inside are ours (see _onControlsMouseDown).
            revertControls: controls ? 'b-to-a' : undefined,
            renderRevertControl: controls ? () => this._renderCopyControl() : undefined,
        };
    }

    _renderCopyControl() {
        const box = el('div', 'merge-copy-control');
        if (canCopyToward(this.merge, 'left')) {
            const b = el('button', 'merge-copy-btn', '←');
            b.dataset.toward = 'left';
            b.title = t('Copy this change to the left (Alt+Shift+Left)');
            box.appendChild(b);
        }
        if (canCopyToward(this.merge, 'right')) {
            const b = el('button', 'merge-copy-btn', '→');
            b.dataset.toward = 'right';
            b.title = t('Copy this change to the right (Alt+Shift+Right)');
            box.appendChild(b);
        }
        return box;
    }

    _mountEditors() {
        const scrollTop = this.file._mergeScrollTop || 0;
        this._destroyEditors();
        this.container.classList.toggle('merge-no-controls',
            this.viewMode === 'unified' || !this._hasCopyControls());

        if (this.viewMode === 'unified') {
            const host = el('div', 'merge-unified');
            this.bodyEl.insertBefore(host, this.minimapEl);
            this.unifiedView = new EditorView({
                parent: host,
                state: EditorState.create({
                    doc: this.merge.right.text,
                    extensions: [
                        ...this._commonExtensions(false),
                        EditorView.editorAttributes.of({ class: 'cm-merge-b' }),
                        unifiedMergeView({
                            original: this.merge.left.text,
                            mergeControls: false,
                            highlightChanges: true,
                            gutter: true,
                            collapseUnchanged: COLLAPSE,
                            diffConfig: this._diffConfig(),
                        }),
                        EditorView.updateListener.of((u) => this._onEditorUpdate(u, null)),
                    ],
                }),
            });
            this.unifiedView.scrollDOM.addEventListener('scroll', () => this._updateMinimapViewport());
        } else {
            this.mergeView = new MergeView({
                a: { doc: this.merge.left.text, extensions: this._sideExtensions('left') },
                b: { doc: this.merge.right.text, extensions: this._sideExtensions('right') },
                parent: this.bodyEl,
                ...this._mergeConfig(),
            });
            const dom = this.mergeView.dom;
            this._onControlsMouseDown = (e) => {
                const btn = e.target && e.target.closest ? e.target.closest('.merge-copy-btn') : null;
                if (!btn) return;
                // Ahead of the package's own handler, which would always revert
                // in its single configured direction.
                e.preventDefault();
                e.stopPropagation();
                const box = btn.closest('.merge-copy-control');
                this.copyChunk(Number(box && box.dataset.chunk), btn.dataset.toward);
            };
            this._onControlsOver = (e) => {
                const box = e.target && e.target.closest ? e.target.closest('.merge-copy-control') : null;
                this._setHoverChunk(box ? Number(box.dataset.chunk) : null);
            };
            this._onControlsLeave = () => this._setHoverChunk(null);
            dom.addEventListener('mousedown', this._onControlsMouseDown, true);
            dom.addEventListener('mouseover', this._onControlsOver);
            dom.addEventListener('mouseleave', this._onControlsLeave);
            dom.addEventListener('scroll', () => this._updateMinimapViewport());

            // The package redraws its controls as chunks change or scroll into
            // view; each redraw needs our band sizing again.
            const column = dom.querySelector('.cm-merge-revert');
            if (column && typeof MutationObserver === 'function') {
                this._controlsObserver = new MutationObserver(() => this._scheduleControlLayout());
                this._controlsObserver.observe(column, { childList: true });
            }
        }

        this.viewToggleBtn.textContent = this.viewMode === 'unified' ? t('Side-by-side view') : t('Unified view');
        const split = this.viewMode === 'split';
        this.copyAllLeftBtn.hidden = !split || !canCopyToward(this.merge, 'left');
        this.copyAllRightBtn.hidden = !split || !canCopyToward(this.merge, 'right');

        this._appliedFocusKey = '';
        this._renderHeaders();
        this._refresh();
        if (scrollTop) {
            setTimeout(() => {
                const s = this._scroller();
                if (s) s.scrollTop = scrollTop;
            }, 0);
        }
    }

    _destroyEditors() {
        const s = this._scroller();
        if (s) this.file._mergeScrollTop = s.scrollTop;
        if (this._controlsObserver) {
            this._controlsObserver.disconnect();
            this._controlsObserver = null;
        }
        if (this.mergeView) {
            const dom = this.mergeView.dom;
            dom.removeEventListener('mousedown', this._onControlsMouseDown, true);
            dom.removeEventListener('mouseover', this._onControlsOver);
            dom.removeEventListener('mouseleave', this._onControlsLeave);
            this.mergeView.destroy();
            dom.remove();
            this.mergeView = null;
        }
        if (this.unifiedView) {
            const host = this.unifiedView.dom.parentNode;
            this.unifiedView.destroy();
            if (host) host.remove();
            this.unifiedView = null;
        }
        this._lastFocused = null;
        this._inline = null;
        this._hoverChunk = null;
    }

    _forEachEditor(fn) {
        if (this.mergeView) { fn(this.mergeView.a); fn(this.mergeView.b); }
        if (this.unifiedView) fn(this.unifiedView);
    }

    _scroller() {
        if (this.mergeView) return this.mergeView.dom;
        if (this.unifiedView) return this.unifiedView.scrollDOM;
        return null;
    }

    _sideChanged(key, text) {
        const side = this.merge[key];
        side.text = text;
        if (side.live && typeof side.onLive === 'function') side.onLive(text);
        const dirty = mergeDirty(this.merge);
        if (this.file.isDirty !== dirty) {
            this.file.isDirty = dirty;
            if (typeof this.options.onDirtyChange === 'function') this.options.onDirtyChange();
        }
        this._queueRefresh();
    }

    // ── State shown in the chrome ────────────────────────────────────────────

    _queueRefresh() {
        if (this._refreshTimer) return;
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            this._refresh();
        }, 0);
    }

    /** Redraw everything derived from the texts (also called after a save). */
    refreshState() {
        this._refresh();
    }

    _chunks() {
        if (this.mergeView) return this.mergeView.chunks;
        if (this.unifiedView) {
            const found = getChunks(this.unifiedView.state);
            return found ? found.chunks : [];
        }
        return [];
    }

    _docs() {
        if (this.mergeView) return { a: this.mergeView.a.state.doc, b: this.mergeView.b.state.doc };
        if (this.unifiedView) return { a: getOriginalDoc(this.unifiedView.state), b: this.unifiedView.state.doc };
        return null;
    }

    _refresh() {
        const chunks = this._chunks();
        const docs = this._docs();

        this.summaryEl.textContent = '';
        if (!chunks.length) {
            this.summaryEl.appendChild(el('span', 'diff-sum-none', t('No differences')));
            this.summaryEl.title = '';
        } else if (docs) {
            let left = 0;
            let right = 0;
            for (const ch of chunks) {
                left += linesIn(docs.a, ch.fromA, ch.toA);
                right += linesIn(docs.b, ch.fromB, ch.toB);
            }
            this.summaryEl.appendChild(el('span', 'diff-sum-del', `−${left}`));
            this.summaryEl.appendChild(el('span', 'diff-sum-add', `+${right}`));
            this.summaryEl.appendChild(el('span', 'diff-sum-blocks', t('{n} changes', { n: chunks.length })));
            this.summaryEl.title = t('{left} changed lines on the left, {right} on the right', { left, right });
        }

        const at = this._chunkAtCursor();
        this.navLabel.textContent = chunks.length
            ? t('Change {n} of {total}', { n: at.inside >= 0 ? at.inside + 1 : '–', total: chunks.length })
            : '';

        const inChunk = at.inside >= 0 ? this._inlineTargets().filter((tg) => tg.chunk === at.inside) : [];
        const inlinePos = this._inline && inChunk.findIndex((tg) => this._sameTarget(tg, this._inline));
        this.inlineLabel.textContent = inChunk.length
            ? t('Inline {n} of {total}', { n: inlinePos >= 0 ? inlinePos + 1 : '–', total: inChunk.length })
            : '';

        const dirty = mergeDirty(this.merge);
        if (this.saveBtn) this.saveBtn.disabled = !dirty;
        if (this.copyAllLeftBtn) this.copyAllLeftBtn.disabled = !chunks.length;
        if (this.copyAllRightBtn) this.copyAllRightBtn.disabled = !chunks.length;
        this._renderHeaders();
        this._applyFocus();
        this._buildMinimap();
        this._scheduleControlLayout();
    }

    // ── Current change: outline and copy band ────────────────────────────────

    _setHoverChunk(index) {
        const next = Number.isInteger(index) && index >= 0 ? index : null;
        if (next === this._hoverChunk) return;
        this._hoverChunk = next;
        this._applyFocus();
        this._layoutCopyControls();
    }

    /** Outline the change being worked on (hovered band first, else the cursor's). */
    _applyFocus() {
        const chunks = this._chunks();
        let index = -1;
        if (this._hoverChunk != null && chunks[this._hoverChunk]) index = this._hoverChunk;
        else index = this._chunkAtCursor().inside;
        const chunk = index >= 0 ? chunks[index] : null;
        const inline = chunk && this._inline && this._inline.chunk === index ? this._inline : null;

        const key = chunk
            ? [index, chunk.fromA, chunk.toA, chunk.fromB, chunk.toB,
                inline ? `${inline.fromA}:${inline.toA}:${inline.fromB}:${inline.toB}` : ''].join('|')
            : '';
        this._focusIndex = index;
        if (key === this._appliedFocusKey) return;
        this._appliedFocusKey = key;

        const sideFocus = (from, to, inlineFrom, inlineTo) => (chunk ? { from, to, inlineFrom, inlineTo } : null);
        if (this.mergeView) {
            this.mergeView.a.dispatch({ effects: setFocus.of(sideFocus(
                chunk && chunk.fromA, chunk && chunk.toA, inline && inline.fromA, inline && inline.toA)) });
            this.mergeView.b.dispatch({ effects: setFocus.of(sideFocus(
                chunk && chunk.fromB, chunk && chunk.toB, inline && inline.fromB, inline && inline.toB)) });
        } else if (this.unifiedView) {
            this.unifiedView.dispatch({ effects: setFocus.of(sideFocus(
                chunk && chunk.fromB, chunk && chunk.toB, inline && inline.fromB, inline && inline.toB)) });
        }
    }

    _scheduleControlLayout() {
        if (this._layoutFrame || !this.mergeView) return;
        const run = () => {
            this._layoutFrame = null;
            this._layoutCopyControls();
        };
        this._layoutFrame = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(run)
            : setTimeout(run, 16);
    }

    /** Vertical extent of a chunk, in the aligned coordinates both editors share. */
    _chunkSpan(chunk) {
        const mv = this.mergeView;
        const side = (ed, from, to) => {
            const len = ed.state.doc.length;
            const top = ed.lineBlockAt(Math.min(from, len)).top;
            const bottom = to > from ? ed.lineBlockAt(Math.max(from, Math.min(len, to) - 1)).bottom : top;
            return { top, bottom };
        };
        const a = side(mv.a, chunk.fromA, chunk.toA);
        const b = side(mv.b, chunk.fromB, chunk.toB);
        return { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), anchor: a.top };
    }

    /**
     * Stretch each copy control into a band as tall as its change. The package
     * positions the control at the chunk's first line on the left and resets
     * `top` whenever it re-measures, so the band is offset with a margin
     * instead of moving `top` itself.
     */
    _layoutCopyControls() {
        const mv = this.mergeView;
        if (!mv) return;
        const chunks = mv.chunks;
        for (const box of mv.dom.querySelectorAll('.merge-copy-control')) {
            const index = Number(box.dataset.chunk);
            const chunk = chunks[index];
            if (!chunk) continue;
            const span = this._chunkSpan(chunk);
            box.style.marginTop = `${span.top - span.anchor}px`;
            box.style.height = `${Math.max(28, span.bottom - span.top)}px`;
            box.classList.toggle('is-current', index === this._focusIndex);
        }
    }

    // ── Navigation and copying ───────────────────────────────────────────────

    _activeEditor() {
        if (this.unifiedView) return this.unifiedView;
        const mv = this.mergeView;
        if (!mv) return null;
        if (mv.a.hasFocus) return mv.a;
        if (mv.b.hasFocus) return mv.b;
        if (this._lastFocused === mv.a || this._lastFocused === mv.b) return this._lastFocused;
        if (this.merge.right.writable || !this.merge.left.writable) return mv.b;
        return mv.a;
    }

    /** The chunk under the cursor (`inside`), and the first one after it (`next`). */
    _chunkAtCursor() {
        const ed = this._activeEditor();
        const chunks = this._chunks();
        const result = { inside: -1, next: -1 };
        if (!ed || !chunks.length) return result;
        const isA = this.mergeView ? ed === this.mergeView.a : false;
        const pos = ed.state.selection.main.head;
        for (let i = 0; i < chunks.length; i++) {
            const from = isA ? chunks[i].fromA : chunks[i].fromB;
            const to = isA ? chunks[i].toA : chunks[i].toB;
            if (pos >= from && pos <= Math.max(from, to - 1)) { result.inside = i; break; }
            if (pos < from) { result.next = i; break; }
        }
        return result;
    }

    navigate(direction) {
        const ed = this._activeEditor();
        if (!ed) return;
        const command = direction > 0 ? goToNextChunk : goToPreviousChunk;
        command({ state: ed.state, dispatch: (tr) => ed.dispatch(tr) });
        this._inline = null;
        ed.focus();
        this._queueRefresh();
    }

    /** Every word-level change, in document order, with positions on both sides. */
    _inlineTargets() {
        const out = [];
        this._chunks().forEach((ch, i) => {
            if (ch.changes && ch.changes.length) {
                for (const c of ch.changes) {
                    out.push({
                        chunk: i,
                        fromA: ch.fromA + c.fromA, toA: ch.fromA + c.toA,
                        fromB: ch.fromB + c.fromB, toB: ch.fromB + c.toB,
                    });
                }
            } else {
                out.push({ chunk: i, fromA: ch.fromA, toA: ch.endA, fromB: ch.fromB, toB: ch.endB });
            }
        });
        return out;
    }

    _sameTarget(x, y) {
        return !!x && !!y && x.fromA === y.fromA && x.toA === y.toA && x.fromB === y.fromB && x.toB === y.toB;
    }

    /**
     * Move to the previous / next word-level change (Alt+← / Alt+→), across
     * change boundaries and wrapping at either end. Selects it on both sides.
     */
    navigateInline(direction) {
        const targets = this._inlineTargets();
        const ed = this._activeEditor();
        if (!targets.length || !ed) return false;
        const isA = !!this.mergeView && ed === this.mergeView.a;
        const fromOf = (tg) => (isA ? tg.fromA : tg.fromB);
        const n = targets.length;

        let index = this._inline ? targets.findIndex((tg) => this._sameTarget(tg, this._inline)) : -1;
        if (index >= 0) {
            index = (((index + direction) % n) + n) % n;
        } else {
            const head = ed.state.selection.main.head;
            if (direction > 0) {
                index = targets.findIndex((tg) => fromOf(tg) >= head);
                if (index < 0) index = 0;
            } else {
                index = -1;
                for (let i = n - 1; i >= 0; i--) {
                    if (fromOf(targets[i]) < head) { index = i; break; }
                }
                if (index < 0) index = n - 1;
            }
        }

        const target = targets[index];
        this._inline = target;
        const pairs = this.mergeView
            ? [[this.mergeView.a, target.fromA, target.toA], [this.mergeView.b, target.fromB, target.toB]]
            : [[this.unifiedView, target.fromB, target.toB]];
        for (const [view, from, to] of pairs) {
            const len = view.state.doc.length;
            const anchor = Math.min(from, len);
            const head = Math.min(Math.max(from, to), len);
            view.dispatch({
                selection: { anchor, head },
                effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
                userEvent: OWN_SELECTION,
            });
        }
        ed.focus();
        this._queueRefresh();
        return true;
    }

    /**
     * Copy chunk `index` into the side `toward` points at. Refused when that
     * side is read-only. Returns whether anything was copied.
     */
    copyChunk(index, toward) {
        const mv = this.mergeView;
        const chunk = mv && mv.chunks[index];
        if (!chunk || !canCopyToward(this.merge, toward)) return false;
        const toLeft = toward === 'left';
        const src = toLeft ? mv.b : mv.a;
        const dest = toLeft ? mv.a : mv.b;
        const edit = toLeft
            ? blockCopyEdit(src.state.doc.toString(), dest.state.doc.toString(), chunk.fromB, chunk.toB, chunk.fromA, chunk.toA)
            : blockCopyEdit(src.state.doc.toString(), dest.state.doc.toString(), chunk.fromA, chunk.toA, chunk.fromB, chunk.toB);
        dest.dispatch({ changes: edit, userEvent: 'input.copy' });
        this._hoverChunk = null;
        return true;
    }

    /** Copy the change under (or just after) the cursor. */
    copyAtCursor(toward) {
        const at = this._chunkAtCursor();
        const index = at.inside >= 0 ? at.inside : at.next;
        return index >= 0 ? this.copyChunk(index, toward) : false;
    }

    /** Copy every change toward one side, as a single undoable edit. */
    copyAll(toward) {
        const mv = this.mergeView;
        if (!mv || !mv.chunks.length || !canCopyToward(this.merge, toward)) return false;
        const toLeft = toward === 'left';
        const src = (toLeft ? mv.b : mv.a).state.doc.toString();
        const destView = toLeft ? mv.a : mv.b;
        const dest = destView.state.doc.toString();
        const changes = mv.chunks.map((ch) => (toLeft
            ? blockCopyEdit(src, dest, ch.fromB, ch.toB, ch.fromA, ch.toA)
            : blockCopyEdit(src, dest, ch.fromA, ch.toA, ch.fromB, ch.toB)));
        destView.dispatch({ changes, userEvent: 'input.copy' });
        return true;
    }

    // ── Toolbar toggles ──────────────────────────────────────────────────────

    toggleIgnoreWhitespace() {
        this.ignoreWhitespace = !this.ignoreWhitespace;
        writeFlag('diff_ignoreWhitespace', this.ignoreWhitespace);
        this.ignoreWsBtn.classList.toggle('active', this.ignoreWhitespace);
        // MergeView.reconfigure only stores a new diffConfig for the NEXT edit;
        // the changes on screen are not recomputed. Rebuilding is what applies
        // it now — and loses nothing, since the texts live on the tab.
        this._mountEditors();
    }

    toggleShowWhitespace() {
        this.showWhitespace = !this.showWhitespace;
        writeFlag('diff_showWhitespace', this.showWhitespace);
        this.showWsBtn.classList.toggle('active', this.showWhitespace);
        this._forEachEditor((ed) => ed.dispatch({
            effects: this.whitespaceCompartment.reconfigure(this.showWhitespace ? highlightWhitespace() : []),
        }));
    }

    toggleViewMode() {
        this.viewMode = this.viewMode === 'split' ? 'unified' : 'split';
        this._mountEditors();
    }

    async _save() {
        if (typeof this.options.onSave !== 'function') return;
        await this.options.onSave();
        this._refresh();
    }

    // ── Keyboard, clipboard, history ─────────────────────────────────────────

    _onKeyDown(e) {
        if (!this.container || !this.container.isConnected || this.container.offsetParent === null) return;
        // Two comparisons can be on screen at once (split panes): only the one
        // holding focus, or any when nothing does, answers.
        const ae = document.activeElement;
        if (ae && ae !== document.body && !this.container.contains(ae)) return;

        const action = mergeKeyAction(e, { hasFileNav: !!this.merge.nav });
        if (!action) return;
        const handled = this.runKeyAction(action);
        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    /** Perform a `mergeKeyAction` result. Returns whether the key was used. */
    runKeyAction(action) {
        switch (action) {
            case 'next-file': this.merge.nav.onNextFile(); return true;
            case 'prev-file': this.merge.nav.onPrevFile(); return true;
            case 'prev-change': this.navigate(-1); return true;
            case 'next-change': this.navigate(1); return true;
            // Always swallowed: CodeMirror would otherwise jump by syntax unit.
            case 'prev-inline': this.navigateInline(-1); return true;
            case 'next-inline': this.navigateInline(1); return true;
            case 'copy-left': return this.copyAtCursor('left');
            case 'copy-right': return this.copyAtCursor('right');
            case 'ignore-whitespace': this.toggleIgnoreWhitespace(); return true;
            case 'show-whitespace': this.toggleShowWhitespace(); return true;
            default: return false;
        }
    }

    _sideOf(ed) {
        if (!this.mergeView) return null;
        if (ed === this.mergeView.a) return this.merge.left;
        if (ed === this.mergeView.b) return this.merge.right;
        return null;
    }

    _canEdit(ed) {
        const side = this._sideOf(ed);
        return !!(side && side.writable);
    }

    getSelectedText() {
        const ed = this._activeEditor();
        if (!ed) return '';
        const { state } = ed;
        return state.selection.ranges.filter((r) => !r.empty)
            .map((r) => state.sliceDoc(r.from, r.to)).join(state.lineBreak);
    }

    async copy() {
        const text = this.getSelectedText();
        if (text) await writeText(text);
    }

    async cut() {
        const ed = this._activeEditor();
        const text = this.getSelectedText();
        if (!ed || !text) return;
        await writeText(text);
        if (this._canEdit(ed)) ed.dispatch(ed.state.replaceSelection(''));
    }

    async paste() {
        const ed = this._activeEditor();
        if (!ed || !this._canEdit(ed)) return;
        let text = '';
        try { text = await readText(); } catch (_) { return; }
        if (text) ed.dispatch(ed.state.replaceSelection(text));
    }

    undo() {
        const ed = this._activeEditor();
        if (ed && this._canEdit(ed)) undo(ed);
    }

    redo() {
        const ed = this._activeEditor();
        if (ed && this._canEdit(ed)) redo(ed);
    }

    focus() {
        const ed = this._activeEditor();
        if (ed) ed.focus();
    }

    getDiagnostics() {
        return [];
    }

    // ── Minimap ──────────────────────────────────────────────────────────────

    _buildMinimap() {
        const map = this.minimapEl;
        if (!map) return;
        map.querySelectorAll('.diff-minimap-mark').forEach((n) => n.remove());
        const scroller = this._scroller();
        const chunks = this._chunks();
        const total = scroller ? scroller.scrollHeight : 0;
        this._minimapTotal = total;
        if (!total || !chunks.length) {
            map.style.display = 'none';
            return;
        }
        map.style.display = '';

        const scrollTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
        const place = (ed, from, to) => {
            const top = ed.lineBlockAt(from).top + ed.documentTop - scrollTop;
            const end = ed.lineBlockAt(Math.max(from, Math.min(ed.state.doc.length, to) - 1)).bottom
                + ed.documentTop - scrollTop;
            return { top, height: Math.max(2, end - top) };
        };

        const frag = document.createDocumentFragment();
        for (const ch of chunks) {
            const onLeft = ch.toA > ch.fromA;
            const onRight = ch.toB > ch.fromB;
            let box;
            if (this.mergeView) {
                box = onRight ? place(this.mergeView.b, ch.fromB, ch.toB) : place(this.mergeView.a, ch.fromA, ch.toA);
            } else {
                box = place(this.unifiedView, ch.fromB, Math.max(ch.toB, ch.fromB + 1));
            }
            const mark = el('div', `diff-minimap-mark ${onLeft && onRight ? 'is-mod' : onRight ? 'is-add' : 'is-del'}`);
            mark.style.top = `${(box.top / total) * 100}%`;
            mark.style.height = `${Math.max(0.4, (box.height / total) * 100)}%`;
            frag.appendChild(mark);
        }
        map.appendChild(frag);
        this._updateMinimapViewport();
    }

    _updateMinimapViewport() {
        const scroller = this._scroller();
        const total = this._minimapTotal;
        if (!scroller || !total || !this.minimapViewportEl) return;
        // Everything fits: a box covering the whole strip says nothing.
        this.minimapViewportEl.hidden = scroller.clientHeight >= total - 1;
        this.minimapViewportEl.style.top = `${(scroller.scrollTop / total) * 100}%`;
        this.minimapViewportEl.style.height = `${Math.min(100, (scroller.clientHeight / total) * 100)}%`;
    }

    _onMinimapClick(e) {
        const scroller = this._scroller();
        if (!scroller || !this._minimapTotal) return;
        const rect = this.minimapEl.getBoundingClientRect();
        const ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
        scroller.scrollTop = Math.max(0, ratio * this._minimapTotal - scroller.clientHeight / 2);
    }

    destroy() {
        window.removeEventListener('keydown', this._onKeyDown, true);
        window.removeEventListener('themeChanged', this._onThemeChanged);
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (this._layoutFrame) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._layoutFrame);
            clearTimeout(this._layoutFrame);
            this._layoutFrame = null;
        }
        this._destroyEditors();
        if (this.container) this.container.classList.remove('merge-editor', 'merge-no-controls');
    }
}
