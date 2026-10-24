/**
 * ConflictEditor.js — three-way merge of one conflicted file.
 *
 *   current (HEAD, read-only) | result (editable, saved to the file) | incoming (read-only)
 *
 * The result starts as git's own merge (utils/ConflictRegions.js): what merged
 * cleanly is already in place, and each conflict holds the common ancestor's
 * text until it is decided. A conflict is decided with the → / ← markers in
 * the side panes' gutters, the toolbar, Alt+← / Alt+→, or by editing it by
 * hand.
 *
 * Why not MergeEditor with a third pane: @codemirror/merge's MergeView is
 * built for two documents, and MergeEditor already replaces its chunking. Here
 * three plain EditorViews sit in one scrolling body, and padding lines keep
 * them row for row (alignThree), so one scrollbar moves all three.
 *
 * The tab is an ordinary comparison tab (type 'diff') whose `merge.right` is
 * the result. Saving, the unsaved marker and "close with unsaved changes" all
 * go through the comparison code in Editor.js; `file.conflict` holds the rest,
 * so a redraw or a tab switch loses nothing.
 */
import { EditorState, Compartment, StateEffect, StateField, RangeSet } from '@codemirror/state';
import {
    EditorView, Decoration, WidgetType, GutterMarker, gutter, keymap, lineNumbers,
    highlightSpecialChars, drawSelection, highlightActiveLine,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab, invertedEffects, undo, redo } from '@codemirror/commands';
import { pageMotionKeymap } from '../utils/CMPageMotion.js';
import { t } from '../utils/I18n.js';
import { languageExtensionFor, syntaxExtensionForTheme } from '../views/CodeMirrorView.js';
import { mergeDirty, sideDirty } from '../utils/MergeSides.js';
import {
    alignThree, equalLinePairs, lineCount, resolutionText, sideConflictLines,
} from '../utils/ConflictRegions.js';

// Past this many characters in all three texts, the panes are not lined up or
// coloured: both need a line diff per edit.
const ANALYSIS_LIMIT = 4 * 1024 * 1024;

const RESOLVE = 'select.conflict-resolve';

const resolveEffect = StateEffect.define();   // { index, from, to, state }
const currentEffect = StateEffect.define();   // index
const analysisEffect = StateEffect.define();  // DecorationSet
const sideMarksEffect = StateEffect.define(); // DecorationSet

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** A decoration set that follows edits and is replaced wholesale by `effect`. */
const decorationField = (effect) => StateField.define({
    create: () => Decoration.none,
    update(deco, tr) {
        for (const e of tr.effects) if (e.is(effect)) return e.value;
        return tr.docChanged ? deco.map(tr.changes) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/**
 * Blank lines standing in for lines another pane has, so the three stay row
 * for row. Real empty lines rather than a computed height, as in MergeEditor:
 * a height is a fraction of a pixel off per line, and that adds up.
 */
class PadWidget extends WidgetType {
    constructor(lines) {
        super();
        this.lines = lines;
    }

    eq(other) { return other.lines === this.lines; }

    toDOM() {
        const pad = el('div', 'cm-conflict-pad');
        pad.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < this.lines; i++) pad.appendChild(el('div', 'cm-conflict-pad-line', '​'));
        return pad;
    }

    get estimatedHeight() { return this.lines * 22; }
}

/** The → / ← in a side pane's gutter that takes that side's version. */
class TakeMarker extends GutterMarker {
    constructor(arrow, title, index) {
        super();
        this.arrow = arrow;
        this.title = title;
        this.index = index;
    }

    eq(other) { return other.arrow === this.arrow && other.index === this.index; }

    toDOM() {
        const b = el('span', 'cm-conflict-take', this.arrow);
        b.title = this.title;
        return b;
    }
}

/** Pad widgets for one pane, from alignThree's [{ line, count }]. */
function padRanges(doc, pads) {
    return pads.map(({ line, count }) => (line < doc.lines
        ? Decoration.widget({ widget: new PadWidget(count), block: true, side: -1 }).range(doc.line(line + 1).from)
        : Decoration.widget({ widget: new PadWidget(count), block: true, side: 1 }).range(doc.length)));
}

/** Line decorations with `cls` over 0-based lines [from, to). */
function lineRanges(doc, from, to, cls) {
    const out = [];
    for (let l = from; l < to && l < doc.lines; l++) {
        const edge = (l === from ? ' is-first' : '') + (l === to - 1 ? ' is-last' : '');
        out.push(Decoration.line({ class: cls + edge }).range(doc.line(l + 1).from));
    }
    return out;
}

const conflictTheme = EditorView.theme({
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
    '.cm-activeLine': { backgroundColor: 'var(--cm-active-line-bg, rgba(127, 127, 127, 0.09))' },
    '.cm-gutters': { backgroundColor: 'var(--bg-color)', color: 'var(--text-secondary)', border: 'none' },
    '.cm-conflict-pad': {
        backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 5px, rgba(127, 127, 127, 0.13) 5px 6px)',
    },
    // What each pane changed: current blue, incoming green (the colours the
    // side panes use for their own changes, and the result for what it took).
    '.cm-line.cm-conflict-from-current': { backgroundColor: 'rgba(56, 139, 253, 0.13)' },
    '.cm-line.cm-conflict-from-incoming': { backgroundColor: 'rgba(46, 160, 67, 0.14)' },
    '.cm-line.cm-conflict-edited': { backgroundColor: 'rgba(210, 153, 34, 0.14)' },
    // Conflicts: red until decided, then neutral. Inset shadows, not borders,
    // so the lines stay exactly as tall as the other panes' lines.
    '.cm-line.cm-conflict.is-open': { backgroundColor: 'rgba(248, 81, 73, 0.18)' },
    '.cm-line.cm-conflict.is-resolved': { backgroundColor: 'rgba(127, 127, 127, 0.12)' },
    '.cm-line.cm-conflict.is-first': { boxShadow: 'inset 0 1px 0 rgba(248, 81, 73, 0.55)' },
    '.cm-line.cm-conflict.is-last': { boxShadow: 'inset 0 -1px 0 rgba(248, 81, 73, 0.55)' },
    '.cm-line.cm-conflict.is-first.is-last': {
        boxShadow: 'inset 0 1px 0 rgba(248, 81, 73, 0.55), inset 0 -1px 0 rgba(248, 81, 73, 0.55)',
    },
    '.cm-line.cm-conflict.is-resolved.is-first, .cm-line.cm-conflict.is-resolved.is-last': { boxShadow: 'none' },
    // A conflict with no lines on this side: a rule where its lines would be.
    '.cm-line.cm-conflict-empty': { boxShadow: 'inset 0 2px 0 #f85149' },
    '.cm-line.cm-conflict-empty.is-resolved': { boxShadow: 'inset 0 2px 0 rgba(127, 127, 127, 0.5)' },
    '.cm-line.is-current': { boxShadow: 'inset 3px 0 0 var(--primary-color, #3794ff)' },
    '.cm-line.cm-conflict-empty.is-current': {
        boxShadow: 'inset 3px 0 0 var(--primary-color, #3794ff), inset 0 2px 0 var(--primary-color, #3794ff)',
    },
    '.cm-conflict-gutter': { width: '18px' },
    '.cm-conflict-take': {
        display: 'inline-block',
        width: '16px',
        textAlign: 'center',
        borderRadius: '3px',
        cursor: 'pointer',
        color: '#fff',
        background: '#f85149',
        fontWeight: '700',
    },
    '.cm-conflict-take:hover': { background: 'var(--primary-color, #3794ff)' },
});

export class ConflictEditor {
    /**
     * @param {HTMLElement} container
     * @param {object} file   the tab: `file.merge` { left: current, right: result },
     *                        `file.conflict` as openConflictTab builds it
     * @param {object} options
     *   onDirtyChange()      the tab's unsaved state flipped
     *   onSave()             save the tab; resolves true when it was written
     */
    constructor(container, file, options = {}) {
        this.container = container;
        this.file = file;
        this.merge = file.merge;
        this.c = file.conflict;
        this.options = options;
        this.conflicts = this.c.regions.filter((r) => r.kind === 'conflict');
        this.syntaxCompartment = new Compartment();
        this._analysisTimer = null;
        this._lastCurrent = -1;
        this._analyze = this._analyze.bind(this);
        this._onKeyDown = this._onKeyDown.bind(this);
        this._onThemeChanged = () => {
            for (const v of this._views()) {
                v.dispatch({ effects: this.syntaxCompartment.reconfigure(syntaxExtensionForTheme()) });
            }
        };
        window.addEventListener('themeChanged', this._onThemeChanged);

        // Where each conflict sits in the side panes never changes: they are
        // read-only.
        this.sideLines = {
            ours: sideConflictLines(this.c.ours, this.c.regions, 'ours'),
            theirs: sideConflictLines(this.c.theirs, this.c.regions, 'theirs'),
        };
        this._build();
    }

    // ── Layout ───────────────────────────────────────────────────────────────

    _build() {
        const c = this.container;
        c.innerHTML = '';
        c.classList.add('merge-editor', 'conflict-editor');
        c.style.padding = '0';
        c.style.overflow = 'hidden';
        c.style.display = 'flex';
        c.style.flexDirection = 'column';
        c.addEventListener('keydown', this._onKeyDown, true);

        c.appendChild(this._buildToolbar());
        this.headersEl = el('div', 'merge-headers conflict-headers');
        c.appendChild(this.headersEl);
        this.bodyEl = el('div', 'conflict-body');
        c.appendChild(this.bodyEl);

        this._mountEditors();
        this.refreshState();
        this._analyze();
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
        title.appendChild(el('span', '', t('Merge')));
        const name = el('strong', '', this.c.path);
        name.title = this.c.path;
        title.appendChild(name);
        bar.appendChild(title);

        const actions = el('div', 'diff-toolbar-actions');
        this.statusEl = el('span', 'conflict-status');
        actions.appendChild(this.statusEl);
        const nav = el('div', 'diff-nav');
        nav.appendChild(this._button('↑', t('Previous conflict (Alt+↑)'), () => this.navigate(-1)));
        nav.appendChild(this._button('↓', t('Next conflict (Alt+↓)'), () => this.navigate(1)));
        actions.appendChild(nav);

        this.takeButtons = [
            this._button(t('← Current'), t('Use the current version for this conflict (Alt+←)'), () => this.resolveCurrent('ours')),
            this._button(t('Incoming →'), t('Use the incoming version for this conflict (Alt+→)'), () => this.resolveCurrent('theirs')),
            this._button(t('Both (current first)'), t('Keep both, current first'), () => this.resolveCurrent('ours-theirs')),
            this._button(t('Both (incoming first)'), t('Keep both, incoming first'), () => this.resolveCurrent('theirs-ours')),
            this._button(t('Base'), t('Back to the common ancestor\'s text (unresolved)'), () => this.resolveCurrent('base')),
        ];
        for (const b of this.takeButtons) actions.appendChild(b);

        this.saveBtn = this._button(t('Save'), t('Save the result to the file (Ctrl+S)'), () => this.options.onSave && this.options.onSave());
        this.resolveBtn = this._button(t('Save and Mark Resolved'), t('Save the result and stage it as resolved'),
            () => this.saveAndMarkResolved(), 'diff-primary-btn');
        actions.appendChild(this.saveBtn);
        actions.appendChild(this.resolveBtn);
        bar.appendChild(actions);
        return bar;
    }

    _renderHeaders() {
        const h = this.headersEl;
        h.innerHTML = '';
        const header = (label, badge, badgeClass, extra = null) => {
            const box = el('div', 'merge-header');
            const l = el('span', 'merge-header-label', label);
            l.title = label;
            box.appendChild(l);
            box.appendChild(el('span', `merge-badge ${badgeClass}`, badge));
            if (extra) box.appendChild(extra);
            return box;
        };
        const { current, incoming } = this.c.labels;
        h.appendChild(header(current ? t('Current ({name})', { name: current }) : t('Current'), t('Read-only'), 'is-readonly'));
        h.appendChild(header(t('Result'), t('Editable'), 'is-writable',
            sideDirty(this.merge.right) ? el('span', 'merge-badge is-unsaved', t('Unsaved')) : null));
        h.appendChild(header(incoming ? t('Incoming ({name})', { name: incoming }) : t('Incoming'), t('Read-only'), 'is-readonly'));
    }

    // ── Editors ──────────────────────────────────────────────────────────────

    _common(writable) {
        const lang = languageExtensionFor(this.c.path);
        return [
            lineNumbers(),
            highlightSpecialChars(),
            drawSelection(),
            highlightActiveLine(),
            keymap.of([...pageMotionKeymap, ...defaultKeymap, ...(writable ? [...historyKeymap, indentWithTab] : [])]),
            lang || [],
            this.syntaxCompartment.of(syntaxExtensionForTheme()),
            EditorState.readOnly.of(!writable),
            decorationField(analysisEffect),
            conflictTheme,
        ];
    }

    _sideExtensions(which) {
        const lines = this.sideLines[which];
        const arrow = which === 'ours' ? '→' : '←';
        const title = which === 'ours' ? t('Use the current version for this conflict') : t('Use the incoming version for this conflict');
        return [
            ...this._common(false),
            decorationField(sideMarksEffect),
            gutter({
                class: 'cm-conflict-gutter',
                markers: (view) => {
                    const doc = view.state.doc;
                    const marks = lines.map((r, i) => {
                        const line = Math.min(r.from, doc.lines - 1);
                        return new TakeMarker(arrow, title, i).range(doc.line(line + 1).from);
                    });
                    return RangeSet.of(marks, true);
                },
                domEventHandlers: {
                    mousedown: (view, block, event) => {
                        const target = event.target;
                        if (!target || !target.classList || !target.classList.contains('cm-conflict-take')) return false;
                        const at = view.state.doc.lineAt(block.from).number - 1;
                        const index = lines.findIndex((r) => Math.min(r.from, view.state.doc.lines - 1) === at);
                        if (index < 0) return false;
                        event.preventDefault();
                        this.resolve(index, which);
                        return true;
                    },
                },
            }),
            EditorView.editorAttributes.of({ class: `cm-conflict-${which}` }),
        ];
    }

    _resultExtensions() {
        const initial = { spans: this.c.spans, current: this.c.current };
        const field = StateField.define({
            create: () => ({ spans: initial.spans.map((s) => ({ ...s })), current: initial.current }),
            update(value, tr) {
                let { spans, current } = value;
                if (tr.docChanged) {
                    const own = tr.isUserEvent(RESOLVE);
                    spans = spans.map((s) => {
                        let touched = false;
                        if (!own) {
                            tr.changes.iterChangedRanges((fromA, toA) => {
                                if (fromA <= s.to && toA >= s.from) touched = true;
                            });
                        }
                        const from = tr.changes.mapPos(s.from, s.from === s.to ? -1 : 1);
                        // Typing into an empty conflict grows it to hold the text.
                        const to = Math.max(from, tr.changes.mapPos(s.to, touched && s.from === s.to ? 1 : -1));
                        return { from, to, state: touched ? 'manual' : s.state };
                    });
                }
                for (const e of tr.effects) {
                    if (e.is(resolveEffect)) {
                        const { index, from, to, state } = e.value;
                        spans = spans.map((s, i) => (i === index ? { from, to, state } : s));
                    } else if (e.is(currentEffect)) {
                        current = e.value;
                    }
                }
                return spans === value.spans && current === value.current ? value : { spans, current };
            },
        });
        this.field = field;

        const marks = EditorView.decorations.compute([field], (state) => {
            const { spans, current } = state.field(field);
            const doc = state.doc;
            const out = [];
            spans.forEach((s, i) => {
                const cls = `cm-conflict ${s.state === 'open' ? 'is-open' : 'is-resolved'}${i === current ? ' is-current' : ''}`;
                if (s.from === s.to) {
                    out.push(Decoration.line({ class: `cm-conflict-empty ${cls}` }).range(doc.lineAt(Math.min(s.from, doc.length)).from));
                    return;
                }
                const first = doc.lineAt(s.from).number - 1;
                const last = doc.lineAt(Math.max(s.from, s.to - 1)).number;
                out.push(...lineRanges(doc, first, last, cls));
            });
            return Decoration.set(out, true);
        });

        return [
            ...this._common(true),
            history(),
            field,
            marks,
            // Undo puts a decision back as it was, open or not.
            invertedEffects.of((tr) => {
                const out = [];
                for (const e of tr.effects) {
                    if (!e.is(resolveEffect)) continue;
                    const prev = tr.startState.field(field).spans[e.value.index];
                    out.push(resolveEffect.of({ index: e.value.index, ...prev }));
                }
                return out;
            }),
            EditorView.updateListener.of((u) => this._onResultUpdate(u)),
            EditorView.editorAttributes.of({ class: 'cm-conflict-result' }),
        ];
    }

    _mountEditors() {
        const pane = (cls) => {
            const p = el('div', `conflict-pane ${cls}`);
            this.bodyEl.appendChild(p);
            return p;
        };
        this.oursView = new EditorView({
            parent: pane('conflict-pane-ours'),
            state: EditorState.create({ doc: this.c.ours, extensions: this._sideExtensions('ours') }),
        });
        this.resultView = new EditorView({
            parent: pane('conflict-pane-result'),
            state: EditorState.create({ doc: this.merge.right.text, extensions: this._resultExtensions() }),
        });
        this.theirsView = new EditorView({
            parent: pane('conflict-pane-theirs'),
            state: EditorState.create({ doc: this.c.theirs, extensions: this._sideExtensions('theirs') }),
        });
        this._renderSideMarks();
        if (this.file._conflictScrollTop) {
            requestAnimationFrame(() => { this.bodyEl.scrollTop = this.file._conflictScrollTop; });
        }
        this.bodyEl.addEventListener('scroll', () => { this.file._conflictScrollTop = this.bodyEl.scrollTop; });
    }

    _views() {
        return [this.oursView, this.resultView, this.theirsView].filter(Boolean);
    }

    // ── State ────────────────────────────────────────────────────────────────

    _state() {
        return this.resultView.state.field(this.field);
    }

    _onResultUpdate(u) {
        const value = u.state.field(this.field);
        this.c.spans = value.spans;
        this.c.current = value.current;
        if (u.docChanged) {
            this.merge.right.text = u.state.doc.toString();
            const dirty = mergeDirty(this.merge);
            if (dirty !== this.file.isDirty) {
                this.file.isDirty = dirty;
                if (this.options.onDirtyChange) this.options.onDirtyChange();
            }
            clearTimeout(this._analysisTimer);
            this._analysisTimer = setTimeout(this._analyze, 150);
        }
        // The cursor moving into a conflict makes it the one the toolbar acts on.
        if (u.selectionSet && !u.transactions.some((tr) => tr.isUserEvent(RESOLVE))) {
            const head = u.state.selection.main.head;
            const at = value.spans.findIndex((s) => head >= s.from && head <= s.to);
            if (at >= 0 && at !== value.current) {
                queueMicrotask(() => this.resultView && this.resultView.dispatch({ effects: currentEffect.of(at) }));
            }
        }
        if (u.docChanged || value.current !== this._lastCurrent
            || u.transactions.some((tr) => tr.effects.some((e) => e.is(resolveEffect)))) {
            this._lastCurrent = value.current;
            this._renderSideMarks();
            this.refreshState();
        }
    }

    /** Toolbar, headers and counts, after an edit or a save. */
    refreshState() {
        if (!this.resultView) return;
        const { spans, current } = this._state();
        const open = spans.filter((s) => s.state === 'open').length;
        this.statusEl.textContent = open
            ? t('{open} of {total} conflicts unresolved', { open, total: spans.length })
            : t('All {total} conflicts resolved', { total: spans.length });
        this.statusEl.classList.toggle('is-done', open === 0);
        const has = current >= 0 && current < spans.length;
        for (const b of this.takeButtons) b.disabled = !has;
        this.saveBtn.disabled = !sideDirty(this.merge.right);
        this._renderHeaders();
    }

    /**
     * The side panes' own marks: what each side changed against the ancestor,
     * and its conflicts (the current one outlined).
     */
    _renderSideMarks() {
        const { spans, current } = this._state();
        const base = this.c.base;
        for (const which of ['ours', 'theirs']) {
            const view = which === 'ours' ? this.oursView : this.theirsView;
            if (!view) continue;
            const doc = view.state.doc;
            const text = which === 'ours' ? this.c.ours : this.c.theirs;
            const out = [];
            const conflictLines = new Set();
            this.sideLines[which].forEach((r, i) => {
                const span = spans[i];
                const cls = `cm-conflict ${span && span.state === 'open' ? 'is-open' : 'is-resolved'}${i === current ? ' is-current' : ''}`;
                if (r.from === r.to) {
                    const line = Math.min(r.from, doc.lines - 1);
                    out.push(Decoration.line({ class: `cm-conflict-empty ${cls}` }).range(doc.line(line + 1).from));
                    return;
                }
                for (let l = r.from; l < r.to; l++) conflictLines.add(l);
                out.push(...lineRanges(doc, r.from, r.to, cls));
            });
            if (this._analysable() && !this._changedLines) this._changedLines = {};
            if (this._analysable() && !this._changedLines[which]) {
                const matched = new Set(equalLinePairs(base, text).map(([, s]) => s));
                this._changedLines[which] = [];
                for (let l = 0; l < doc.lines; l++) if (!matched.has(l)) this._changedLines[which].push(l);
            }
            const changedCls = which === 'ours' ? 'cm-conflict-from-current' : 'cm-conflict-from-incoming';
            for (const l of (this._changedLines && this._changedLines[which]) || []) {
                if (conflictLines.has(l) || l >= doc.lines) continue;
                // An empty last line is the file's final line break, not a change.
                if (l === doc.lines - 1 && doc.line(l + 1).length === 0) continue;
                out.push(Decoration.line({ class: changedCls }).range(doc.line(l + 1).from));
            }
            view.dispatch({ effects: sideMarksEffect.of(Decoration.set(out, true)) });
        }
    }

    _analysable() {
        return this.c.ours.length + this.c.theirs.length + this.resultView.state.doc.length <= ANALYSIS_LIMIT;
    }

    /**
     * Line the panes up and colour the result by where each line came from.
     * Run after edits settle: it is two line diffs.
     */
    _analyze() {
        if (!this.resultView || !this._analysable()) return;
        const result = this.resultView.state.doc.toString();
        const { ours, theirs } = this.c;
        const po = equalLinePairs(ours, result);
        const pt = equalLinePairs(theirs, result);
        const nR = lineCount(result);
        const pads = alignThree(lineCount(ours), nR, lineCount(theirs), po, pt);

        const doc = this.resultView.state.doc;
        const inConflict = new Set();
        for (const s of this._state().spans) {
            if (s.from === s.to) continue;
            const first = doc.lineAt(s.from).number - 1;
            const last = doc.lineAt(Math.max(s.from, s.to - 1)).number - 1;
            for (let l = first; l <= last; l++) inConflict.add(l);
        }
        const fromOurs = new Set(po.map(([, r]) => r));
        const fromTheirs = new Set(pt.map(([, r]) => r));
        const kinds = [];
        for (let r = 0; r < nR && r < doc.lines; r++) {
            if (inConflict.has(r)) continue;
            const o = fromOurs.has(r);
            const th = fromTheirs.has(r);
            if (o && th) continue;
            if (r === doc.lines - 1 && doc.line(r + 1).length === 0) continue;
            const cls = o ? 'cm-conflict-from-current' : th ? 'cm-conflict-from-incoming' : 'cm-conflict-edited';
            kinds.push(Decoration.line({ class: cls }).range(doc.line(r + 1).from));
        }

        const set = (view, ranges) => view.dispatch({ effects: analysisEffect.of(Decoration.set(ranges, true)) });
        set(this.oursView, padRanges(this.oursView.state.doc, pads.ours));
        set(this.theirsView, padRanges(this.theirsView.state.doc, pads.theirs));
        set(this.resultView, [...padRanges(doc, pads.result), ...kinds]);
    }

    // ── Decisions ────────────────────────────────────────────────────────────

    /** Resolve conflict `index` one way (see resolutionText for the choices). */
    resolve(index, choice) {
        const view = this.resultView;
        const span = this._state().spans[index];
        const conflict = this.conflicts[index];
        if (!view || !span || !conflict) return;
        const insert = resolutionText(conflict, choice);
        view.dispatch({
            changes: { from: span.from, to: span.to, insert },
            effects: [
                resolveEffect.of({ index, from: span.from, to: span.from + insert.length, state: choice === 'base' ? 'open' : choice }),
                currentEffect.of(index),
            ],
            selection: { anchor: span.from },
            userEvent: RESOLVE,
        });
        // Straight on to the next undecided conflict, as a merge tool does.
        const next = this._nextIndex(index, 1, true);
        if (choice !== 'base' && next >= 0 && next !== index) this.goTo(next);
        else this._reveal(index);
    }

    resolveCurrent(choice) {
        const { current } = this._state();
        if (current >= 0) this.resolve(current, choice);
    }

    /** The next conflict after `from` in `direction`, open ones first. */
    _nextIndex(from, direction, openOnly) {
        const { spans } = this._state();
        const n = spans.length;
        if (!n) return -1;
        for (let step = 1; step <= n; step++) {
            const i = (((from + direction * step) % n) + n) % n;
            if (!openOnly || spans[i].state === 'open') return i;
        }
        return -1;
    }

    navigate(direction) {
        const { current } = this._state();
        const start = current < 0 ? (direction > 0 ? -1 : 0) : current;
        let next = this._nextIndex(start, direction, true);
        if (next < 0) next = this._nextIndex(start, direction, false);
        if (next >= 0) this.goTo(next);
    }

    goTo(index) {
        const span = this._state().spans[index];
        if (!span) return;
        this.resultView.dispatch({
            effects: currentEffect.of(index),
            selection: { anchor: span.from },
            userEvent: RESOLVE,
        });
        this._reveal(index);
    }

    _reveal(index) {
        const span = this._state().spans[index];
        if (!span) return;
        this.resultView.dispatch({ effects: EditorView.scrollIntoView(span.from, { y: 'center' }) });
    }

    async saveAndMarkResolved() {
        const open = this._state().spans.filter((s) => s.state === 'open').length;
        if (open) {
            const { showConfirm } = await import('../ui/Dialog.js');
            const ok = await showConfirm(
                t('{count} conflicts are still unresolved; their lines hold the common ancestor\'s text. Save and mark the file resolved anyway?', { count: open }),
                { title: t('Mark as Resolved'), kind: 'warning', okLabel: t('Mark as Resolved') },
            );
            if (!ok) return;
        }
        if (sideDirty(this.merge.right)) {
            const saved = this.options.onSave ? await this.options.onSave() : false;
            if (!saved || sideDirty(this.merge.right)) return;
        }
        const panel = window.app && window.app.gitPanel;
        if (panel && typeof panel.resolvedInMergeView === 'function') {
            await panel.resolvedInMergeView(this.c.repo, this.c.path, this.file);
        }
    }

    // ── Keys ─────────────────────────────────────────────────────────────────

    _onKeyDown(e) {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const act = {
            ArrowUp: () => this.navigate(-1),
            ArrowDown: () => this.navigate(1),
            ArrowLeft: () => this.resolveCurrent('ours'),
            ArrowRight: () => this.resolveCurrent('theirs'),
        }[e.key];
        if (!act) return;
        e.preventDefault();
        e.stopPropagation();
        act();
    }

    // ── The editor contract ──────────────────────────────────────────────────

    getSelectedText() {
        const view = this._views().find((v) => v.hasFocus) || this.resultView;
        if (!view) return '';
        const { from, to } = view.state.selection.main;
        return view.state.sliceDoc(from, to);
    }

    undo() { if (this.resultView) undo(this.resultView); }

    redo() { if (this.resultView) redo(this.resultView); }

    focus() { if (this.resultView) this.resultView.focus(); }

    destroy() {
        clearTimeout(this._analysisTimer);
        window.removeEventListener('themeChanged', this._onThemeChanged);
        this.container.removeEventListener('keydown', this._onKeyDown, true);
        for (const v of this._views()) v.destroy();
        this.oursView = this.resultView = this.theirsView = null;
        this.container.classList.remove('conflict-editor');
    }
}
