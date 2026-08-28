import { EditorState, StateField, StateEffect, Compartment, RangeSetBuilder } from '@codemirror/state';
// Named `tr`, not `t`: this module already binds `t` to Lezer's highlight
// tags (see the import below), which every style rule in the file uses.
import { t as tr } from '../utils/I18n.js';
import { icon as svgIcon } from '../ui/Icons.js';
import { EditorView, Decoration, MatchDecorator, ViewPlugin, WidgetType, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, hoverTooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertTab, indentLess, undo, redo, historyField } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, defaultHighlightStyle, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { highlightSelectionMatches, SearchQuery } from '@codemirror/search';
import { Toast } from '../ui/Toast.js';
import { isDarkTheme as isAppThemeDark } from '../utils/ThemeInfo.js';

// Languages
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { java } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { vim, getCM } from '@replit/codemirror-vim';

// Monochrome line icons (inherit the button's text color via currentColor) so
// toolbar icons share one visual tone instead of mixed colorful emoji.
const ICON_PREVIEW = `<svg class="cm-tb-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_BOOK = `<svg class="cm-tb-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/></svg>`;
const ICON_KEYBOARD = `<svg class="cm-tb-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h0M10 10h0M14 10h0M18 10h0M7 14h10"/></svg>`;
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { yaml } from '@codemirror/lang-yaml';
import { svelte } from '@replit/codemirror-lang-svelte';

// Theme
import { oneDark } from '@codemirror/theme-one-dark';

// Existing imports for Book Mode & Others
import { PageFlip } from 'page-flip';
import { State } from '../core/Store.js';
import * as HtmlPreview from '../ui/HtmlPreview.js';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { SyntaxHighlighter } from '../utils/SyntaxHighlighter.js';
import { highlightCode as cmHighlight } from '../utils/CMHighlighter.js';
import { lspClient } from '../lsp/LspClient.js';
import { InlineAI } from '../ui/InlineAI.js';
import { Navigation } from '../utils/Navigation.js';
import { createInlineCompletionExtension } from '../ui/InlineCompletion.js';
import { snippetCompletionSource } from '../ui/Snippets.js';
import { allows, isPrivatePath } from '../ai/ContextScope.js';

/**
 * Cursor, scroll and undo history — kept PER PANE, on the buffer.
 *
 * A split shares the buffer object, so two views can be open on one file at
 * once. These were single slots on that object (`_cmStateJSON`,
 * `_cmScrollTop`), which meant the two panes overwrote each other's caret and
 * scroll position: leaving one pane restored the other pane's viewport.
 *
 * The document itself is deliberately NOT part of this — it belongs to the
 * buffer and is mirrored between the views (see mirrorToSibling).
 */
function viewStates(file) {
    if (!file._cmViewState) file._cmViewState = {};
    return file._cmViewState;
}

function readViewState(file, pane) {
    if (!file) return null;
    const slot = file._cmViewState && file._cmViewState[pane || 'left'];
    // `_cmStateJSON` is the single-slot shape this replaced; a session saved by
    // an older build still restores rather than opening at the top.
    return (slot && slot.json) || file._cmStateJSON || null;
}

function readViewScroll(file, pane) {
    if (!file) return 0;
    const slot = file._cmViewState && file._cmViewState[pane || 'left'];
    return (slot && slot.scrollTop) || file._cmScrollTop || 0;
}

function writeViewState(file, pane, value) {
    if (!file) return;
    viewStates(file)[pane || 'left'] = value;
    // Drop the legacy slot once a real one exists, so a stale copy cannot come
    // back and overrule the per-pane state later.
    if (file._cmStateJSON) file._cmStateJSON = null;
    if (file._cmScrollTop) file._cmScrollTop = 0;
}

// Custom Theme to match JHEditor
const jhTheme = EditorView.theme({
    "&": {
        color: "var(--text-color)",
        backgroundColor: "transparent",
        height: "100%",
        fontSize: "var(--editor-font-size, 11.5pt)",
        fontFamily: "var(--editor-font-family, Consolas, 'Courier New', monospace)",
        lineHeight: "var(--editor-line-height-px, 22px)"
    },
    ".cm-scroller": {
        // Crisper glyphs (closer to VSCode's rendering) and inherit the metrics.
        WebkitFontSmoothing: "antialiased",
        MozOsxFontSmoothing: "grayscale",
        fontFamily: "inherit",
        lineHeight: "inherit"
    },
    // Flat overlay scrollbar: invisible until the editor is hovered or actively
    // scrolling (`.is-scrolling` is toggled by App.initScrollbarAutoHide).
    ".cm-scroller::-webkit-scrollbar": {
        width: "12px",
        height: "12px"
    },
    ".cm-scroller::-webkit-scrollbar-track": {
        backgroundColor: "transparent"
    },
    ".cm-scroller::-webkit-scrollbar-thumb": {
        backgroundColor: "transparent",
        borderRadius: "0",
        border: "3px solid transparent",
        backgroundClip: "content-box",
        transition: "background-color 0.18s ease"
    },
    ".cm-scroller:hover::-webkit-scrollbar-thumb, .cm-scroller.is-scrolling::-webkit-scrollbar-thumb": {
        backgroundColor: "var(--scrollbar-thumb, rgba(0,0,0,0.26))"
    },
    ".cm-scroller::-webkit-scrollbar-thumb:hover, .cm-scroller::-webkit-scrollbar-thumb:active": {
        backgroundColor: "var(--scrollbar-thumb-hover, rgba(0,0,0,0.42))"
    },
    ".cm-content": {
        caretColor: "var(--text-color)",
        padding: "10px 10px 500px 10px" // Extra bottom padding for scroll beyond last line
    },
    "&.cm-focused": {
        outline: "none"
    },
    "&.cm-focused .cm-cursor": {
        borderLeftColor: "var(--text-color)"
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        // Theme-aware, translucent highlight (see --cm-selection-bg in themes.css
        // and the !important rule in editor.css). Light mode stays light instead
        // of rendering as a heavy dark block.
        backgroundColor: "var(--cm-selection-bg, rgba(51, 144, 250, 0.18))"
    },
    ".cm-panels": {
        backgroundColor: "var(--bg-color)",
        color: "var(--text-color)"
    },
    ".cm-panels.cm-panels-top": {
        borderBottom: "2px solid black"
    },
    ".cm-panels.cm-panels-bottom": {
        borderTop: "2px solid black"
    },
    ".cm-searchMatch": {
        backgroundColor: "rgba(255, 255, 0, 0.45)"
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "rgba(255, 152, 0, 0.45)",
        outline: "1.5px solid #ff6d00",
        outlineOffset: "-1px"
    },
    // Compact chip for a newline hit (the ↵ widget).
    ".cm-searchMatch-nl": {
        backgroundColor: "rgba(255, 255, 0, 0.45)",
        color: "var(--text-color)",
        borderRadius: "2px",
        padding: "0 2px",
        margin: "0 1px",
        opacity: "0.9"
    },
    ".cm-searchMatch-nl.cm-searchMatch-selected": {
        backgroundColor: "rgba(255, 152, 0, 0.55)",
        outline: "1px solid #ff6d00"
    },
    ".cm-activeLine": {
        backgroundColor: "rgba(255, 255, 255, 0.05)"
    },
    ".cm-selectionMatch": {
        backgroundColor: "rgba(255, 255, 255, 0.1)"
    },
    ".cm-gutters": {
        // Solid background (--gutter-bg is undefined in the themes → was
        // transparent, so horizontally-scrolled text showed through and the
        // line numbers became unreadable). Fall back to the editor background.
        backgroundColor: "var(--gutter-bg, var(--bg-color))",
        color: "var(--gutter-color)",
        border: "none",
        borderRight: "1px solid var(--border-color)",
        // Line numbers / fold markers are UI chrome, not content — don't let the
        // cursor select them as text (they were selectable by drag / triple-click).
        userSelect: "none",
        WebkitUserSelect: "none",
        MozUserSelect: "none"
    },
    ".cm-lineNumbers .cm-gutterElement": {
        // Right-aligned, tabular digits with breathing room. min-width reserves
        // space for 3 digits so the gutter doesn't jitter for lines 1–999; it
        // only grows at 4+ digits.
        padding: "0 8px 0 12px",
        minWidth: "3ch",
        boxSizing: "content-box",
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        opacity: "0.7"
    },
    // VSCode-style active line: no block highlight in the gutter, just a
    // brighter (full-opacity) number. Selector matches the dim rule's
    // specificity and comes later so it wins.
    ".cm-lineNumbers .cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--text-color)",
        opacity: "1"
    },
    ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: "none",
        color: "var(--text-color)"
    },
    ".cm-tooltip": {
        border: "1px solid var(--border-color)",
        backgroundColor: "var(--bg-color)"
    },
    ".cm-tooltip.cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": {
            backgroundColor: "var(--primary-color)",
            color: "white"
        }
    }
}, { dark: true }); // Assuming dark mode by default, can be dynamic later

// The app drives search from its own panel, not CM6's, so CM6's built-in match
// highlighter (which only paints while its own panel is open) never fires. We
// paint the "all hits" highlight ourselves via this decoration field, set from
// performSearch(). .cm-searchMatch / .cm-searchMatch-selected are styled (yellow
// / orange) in jhTheme.
const setSearchHighlights = StateEffect.define();

const searchHighlightField = StateField.define({
    create() { return Decoration.none; },
    update(decorations, tr) {
        decorations = decorations.map(tr.changes);
        for (const e of tr.effects) {
            if (e.is(setSearchHighlights)) decorations = e.value;
        }
        return decorations;
    },
    provide: f => EditorView.decorations.from(f)
});

const fullWidthSpaceDecorator = new MatchDecorator({
    regexp: /　/g,
    decoration: match => Decoration.mark({
        class: "cm-fullWidthSpace",
        attributes: { "data-display": "□" }
    })
});

const fullWidthSpacePlugin = ViewPlugin.fromClass(
    class {
        constructor(view) { this.decorations = fullWidthSpaceDecorator.createDeco(view); }
        update(update) { if (update.docChanged || update.viewportChanged) this.decorations = fullWidthSpaceDecorator.updateDeco(update, this.decorations); }
    },
    { decorations: v => v.decorations }
);

const tabDecorator = new MatchDecorator({
    regexp: /\t/g,
    decoration: match => Decoration.mark({
        class: "cm-tab",
        attributes: { "data-display": "→" }
    })
});

const tabPlugin = ViewPlugin.fromClass(
    class {
        constructor(view) { this.decorations = tabDecorator.createDeco(view); }
        update(update) { if (update.docChanged || update.viewportChanged) this.decorations = tabDecorator.updateDeco(update, this.decorations); }
    },
    { decorations: v => v.decorations }
);

class NewlineWidget extends WidgetType {
    constructor(glyph) { super(); this.glyph = glyph || '↓'; }
    eq(other) { return other.glyph === this.glyph; }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-newline';
        span.textContent = this.glyph;
        return span;
    }
}

// The editor content is normalized to LF, so per-line CR/LF/CRLF can't be
// recovered — instead the marker reflects the file's EOL type so it's still
// distinguishable at a glance: LF=↓, CRLF=↵, CR=←.
function eolGlyph(eol) {
    if (eol === '\r\n') return '↵';
    if (eol === '\r') return '←';
    return '↓';
}

// A compact search-hit marker for a *newline* match, so searching for a line
// break shows a small ↵ chip at the line end instead of highlighting the whole
// line (a mark spanning the '\n' fills to the right edge).
class SearchNlWidget extends WidgetType {
    constructor(cls) { super(); this.cls = cls; }
    eq(other) { return other.cls === this.cls; }
    toDOM() {
        const span = document.createElement('span');
        span.className = this.cls;
        // A small highlighted chip (no ↵ glyph) so a newline hit isn't confused
        // with the whitespace ↵ marker — otherwise it looks like two line breaks.
        span.textContent = ' ';
        return span;
    }
}

function makeNewlinePlugin(glyph) {
    return ViewPlugin.fromClass(
        class {
            constructor(view) { this.decorations = this.buildDeco(view); }
            update(update) {
                if (update.docChanged || update.viewportChanged) {
                    this.decorations = this.buildDeco(update.view);
                }
            }
            buildDeco(view) {
                const builder = new RangeSetBuilder();
                for (let { from, to } of view.visibleRanges) {
                    for (let pos = from; pos <= to;) {
                        const line = view.state.doc.lineAt(pos);
                        if (line.number < view.state.doc.lines) {
                            builder.add(line.to, line.to, Decoration.widget({
                                widget: new NewlineWidget(glyph),
                                side: 1
                            }));
                        }
                        pos = line.to + 1;
                    }
                }
                return builder.finish();
            }
        },
        { decorations: v => v.decorations }
    );
}

/**
 * A CodeMirror highlight style built from the app theme's own --hl-* variables.
 *
 * Used by themes that ship a palette tuned to their own background. oneDark is
 * not an option for those: it is a full THEME, so it would repaint the editor
 * its own blue-grey and throw the theme's background away.
 */
/**
 * Themes that carry their own syntax palette. Listed rather than inferred: every
 * theme defines --hl-*, but switching the older ones off oneDark / the CM
 * default would change how they look, which is not this list's job.
 */
const PALETTE_THEMES = ['theme-bamboo-ancient', 'theme-sumi-e', 'theme-nord', 'theme-kakejiku'];

function themeHighlightStyle() {
    const cs = getComputedStyle(document.body);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return HighlightStyle.define([
        { tag: [t.keyword, t.modifier, t.self, t.null], color: v('--hl-keyword', '#569cd6') },
        { tag: [t.controlKeyword, t.moduleKeyword], color: v('--hl-control-flow', '#c586c0') },
        { tag: [t.typeName, t.className, t.namespace, t.standard(t.name)], color: v('--hl-built-in', '#4ec9b0') },
        { tag: [t.bool, t.atom, t.literal], color: v('--hl-literal', '#569cd6') },
        { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: v('--hl-string', '#ce9178') },
        { tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
            color: v('--hl-comment', '#6a9955'), fontStyle: 'italic' },
        { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
            color: v('--hl-function', '#dcdcaa') },
        { tag: [t.variableName, t.propertyName, t.attributeName], color: v('--hl-variable', '#9cdcfe') },
        { tag: [t.number, t.integer, t.float], color: v('--hl-number', '#b5cea8') },
        { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator],
            color: v('--hl-operator', '#d4d4d4') },
        { tag: t.heading, color: v('--hl-keyword', '#569cd6'), fontWeight: 'bold' },
        { tag: [t.link, t.url], color: v('--primary-color', '#3794ff'), textDecoration: 'underline' },
        { tag: t.strong, fontWeight: 'bold' },
        { tag: t.emphasis, fontStyle: 'italic' },
        { tag: t.invalid, color: '#f14c4c' },
    ]);
}

// Full-line range covering the current selection (whole lines).
function selectedLineRange(state) {
    const sel = state.selection.main;
    return { from: state.doc.lineAt(sel.from).from, to: state.doc.lineAt(sel.to).to };
}

// Alt+A alternates direction: the first press sorts ascending, the next
// descending, and so on — a second press is how you ask for the reverse.
// Module-level so the toggle survives the command's own re-entry; it is
// deliberately NOT per-selection, so ↑↓ on the same block keeps flipping.
let _sortAscending = false;

// Alt+A — sort the selected lines (natural/numeric-aware), alternating
// ascending / descending on each press.
export function sortSelectedLines(view) {
    const { from, to } = selectedLineRange(view.state);
    const lines = view.state.doc.sliceString(from, to).split('\n');
    if (lines.length < 2) return false;
    _sortAscending = !_sortAscending;
    const dir = _sortAscending ? 1 : -1;
    lines.sort((a, b) => dir * a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const joined = lines.join('\n');
    view.dispatch({ changes: { from, to, insert: joined }, selection: { anchor: from, head: from + joined.length } });
    Toast.show(_sortAscending ? 'Sorted ascending.' : 'Sorted descending.', 'info', 1600);
    return true;
}

// Alt+M — remove duplicate lines within the selection (keeps first occurrence).
// Reports what it actually did: a silent edit on a long selection leaves you
// unsure whether anything was removed at all.
export function dedupeSelectedLines(view) {
    const { from, to } = selectedLineRange(view.state);
    const lines = view.state.doc.sliceString(from, to).split('\n');
    if (lines.length < 2) return false;
    const counts = new Map();
    const out = [];
    for (const l of lines) {
        const n = counts.get(l) || 0;
        counts.set(l, n + 1);
        if (n === 0) out.push(l);
    }
    const removed = lines.length - out.length;
    if (removed === 0) {
        Toast.show(tr('No duplicate lines found.'), 'info', 1600);
        return false;
    }
    // "kinds" = distinct values that occurred more than once — the number of
    // groups collapsed, as opposed to the number of lines deleted.
    let kinds = 0;
    for (const n of counts.values()) if (n > 1) kinds++;
    const joined = out.join('\n');
    view.dispatch({ changes: { from, to, insert: joined }, selection: { anchor: from, head: from + joined.length } });
    Toast.show(`Removed ${removed} duplicate line${removed === 1 ? '' : 's'} across ${kinds} value${kinds === 1 ? '' : 's'} (${lines.length} to ${out.length} lines).`,
        'success', 3500);
    return true;
}

export class CodeMirrorView {
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.editorView = null;
        this.file = null;
        this.lineWrappingCompartment = new Compartment();
        this.isLineWrapping = localStorage.getItem('jh_wordWrap') !== 'false';
        // Whitespace/EOL markers (↵ → □) are opt-in via the toolbar toggle; on by
        // default they just add clutter vs. a clean VSCode-like view.
        this.whitespaceCompartment = new Compartment();
        // Full Vim (vi) mode for the text editor — toggled with Ctrl+Alt+V and
        // persisted so new tabs inherit it.
        this.vimCompartment = new Compartment();
        // Syntax colours depend on the app theme, which can change while the
        // editor is mounted — keep them reconfigurable instead of baked in.
        this.syntaxCompartment = new Compartment();
        // Bound once so add/removeEventListener always see the same reference —
        // it is attached when the editor is built and detached in destroy().
        this._onThemeChanged = () => this._applySyntaxTheme();
        this.vimEnabled = localStorage.getItem('settings_editorVim') === 'true';

        // Book Mode specific
        this.pageFlipInstance = null;
        this.pages = [];
        this.currentPageIndex = 0;
        this._resizeObserver = null;
        
        this.inlineAI = new InlineAI(this);
        
        this._lspUnsubscribe = lspClient.onDiagnosticsUpdate = (path, diagnostics) => {
            if (this.file && this.file.path === path && this.editorView) {
                this._updateDiagnostics(diagnostics);
            }
        };
    }

    render(content, file) {
        this.file = file;
        this.destroy(); // Clean up previous instance/dom

        // destroy() tears down inlineAI; recreate it so re-renders (e.g. the
        // Book-mode toggle) don't leave inline AI null and crashing on use.
        if (!this.inlineAI) this.inlineAI = new InlineAI(this);

        this.container.innerHTML = '';
        this.container.style.position = 'relative';

        // Top-right toolbar (unified button styling for all view controls).
        const toolbar = document.createElement('div');
        toolbar.className = 'cm-view-toolbar';
        this.container.appendChild(toolbar);
        this._viewToolbar = toolbar;

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'cm-toolbar-btn pt-view-mode-toggle';
        toggleBtn.innerHTML = `${ICON_BOOK}<span>${State.plainTextViewMode === 'book' ? 'Edit Mode' : 'Book Mode'}</span>`;
        toggleBtn.title = 'Toggle Book / Editor view — Ctrl+Alt+B';
        toggleBtn.onclick = (e) => { e.stopPropagation(); this.toggleBookMode(); };
        toolbar.appendChild(toggleBtn);

        // HTML files get a live preview beside the source.
        if (this._isHtmlFile()) {
            const pvBtn = document.createElement('button');
            pvBtn.className = 'cm-toolbar-btn cm-html-preview-btn' + (this._htmlPreviewOn ? ' active' : '');
            pvBtn.innerHTML = `${ICON_PREVIEW}<span>Preview</span>`;
            pvBtn.title = tr('Toggle the HTML preview pane');
            pvBtn.onclick = (e) => { e.stopPropagation(); this.toggleHtmlPreview(); };
            toolbar.appendChild(pvBtn);
            this._htmlPreviewBtn = pvBtn;
        }

        if (State.plainTextViewMode === 'book') {
            this._renderBookMode(content);
            return;
        }

        this._renderEditor(content);
    }

    /** Re-render the preview frame from the current buffer. */
    _refreshHtmlPreview() {
        if (!this._htmlFrame || !this.editorView) return;
        HtmlPreview.updatePreviewFrame(
            this._htmlFrame,
            this.editorView.state.doc.toString(),
            this.file ? this.file.path : null,
        );
    }

    /** True for files whose source can be previewed as a web page. */
    _isHtmlFile() {
        const p = (this.file && (this.file.path || this.file.name) || '').toLowerCase();
        return p.endsWith('.html') || p.endsWith('.htm');
    }

    /** Show / hide the HTML preview pane (persisted per session). */
    toggleHtmlPreview() {
        this._htmlPreviewOn = !this._htmlPreviewOn;
        if (this.file) this.file._htmlPreviewOn = this._htmlPreviewOn;
        if (this._htmlPreviewBtn) this._htmlPreviewBtn.classList.toggle('active', this._htmlPreviewOn);
        // Rebuild so the split (or its absence) is laid out from scratch.
        this.render(this.editorView ? this.editorView.state.doc.toString() : (this.file?.content || ''), this.file);
    }

    _renderEditor(content) {
        // Restore the per-file preference before the split is built.
        if (this.file && this._htmlPreviewOn === undefined) {
            this._htmlPreviewOn = !!this.file._htmlPreviewOn;
        }
        const wantPreview = this._isHtmlFile() && this._htmlPreviewOn;

        // With the preview on, the editor and the frame sit side by side with a
        // draggable splitter; otherwise the editor fills the pane as before.
        let host = this.container;
        if (wantPreview) {
            const split = document.createElement('div');
            split.className = 'cm-html-split';
            split.style.cssText = 'display:flex; height:100%; width:100%; min-height:0;';
            this.container.appendChild(split);

            const left = document.createElement('div');
            left.style.cssText = 'flex:1 1 50%; min-width:180px; display:flex; min-height:0;';
            const bar = document.createElement('div');
            bar.className = 'cm-html-splitbar';
            const right = document.createElement('div');
            right.className = 'cm-html-preview-pane';
            right.style.cssText = 'flex:1 1 50%; min-width:180px; display:flex; flex-direction:column; min-height:0; border-left:1px solid var(--border-color);';

            const pvHead = document.createElement('div');
            pvHead.className = 'cm-html-preview-head';
            const scriptsLabel = document.createElement('label');
            scriptsLabel.style.cssText = 'display:inline-flex; align-items:center; gap:4px; cursor:pointer;';
            const scriptsCb = document.createElement('input');
            scriptsCb.type = 'checkbox';
            scriptsCb.checked = HtmlPreview.scriptsEnabled();
            scriptsCb.onchange = () => {
                HtmlPreview.setScriptsEnabled(scriptsCb.checked);
                this._refreshHtmlPreview();
            };
            scriptsLabel.append(scriptsCb, document.createTextNode('Enable scripts'));
            const pvTitle = document.createElement('span');
            pvTitle.textContent = tr('Preview');
            pvTitle.style.cssText = 'font-weight:600;';
            // Left-aligned on purpose: `.cm-view-toolbar` floats over the top
            // RIGHT of this pane (position:absolute, z-index 1000), so anything
            // pushed to the right edge ends up underneath it and unclickable.
            pvHead.append(pvTitle, scriptsLabel);

            this._htmlFrame = HtmlPreview.createPreviewFrame();
            right.append(pvHead, this._htmlFrame);
            split.append(left, bar, right);

            // Restore a previously dragged split width (per-file, this session)
            // instead of rebuilding at the 50/50 default on every render.
            if (this.file && this.file._htmlSplitPos != null) {
                const max = split.getBoundingClientRect().width - 180;
                left.style.flex = `0 0 ${Math.min(Math.max(180, this.file._htmlSplitPos), Math.max(180, max))}px`;
            }

            _makeSplitDrag(bar, left, split, this.file);
            host = left;
        } else {
            this._htmlFrame = null;
        }

        const editorContainer = document.createElement('div');
        editorContainer.className = 'cm-editor-wrapper';
        editorContainer.style.height = '100%';
        editorContainer.style.width = '100%';
        host.appendChild(editorContainer);

        const extensions = [
            // Vim MUST be the first extension so its keymap has top precedence.
            this.vimCompartment.of(this.vimEnabled ? vim() : []),
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            foldGutter(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            autocompletion({ override: [this._lspCompletionSource.bind(this), snippetCompletionSource()] }),
            this._lspHoverTooltip(),
            lintGutter(),
            this.lineWrappingCompartment.of(this.isLineWrapping ? EditorView.lineWrapping : []),
            indentUnit.of("\t"),
            this.whitespaceCompartment.of(this._whitespaceExtensions()),
            searchHighlightField,
            rectangularSelection(),
            crosshairCursor(),
            highlightActiveLine(),
            highlightSelectionMatches({ minSelectionLength: 2, maxMatches: 100 }),
            EditorView.domEventHandlers({
                click: (event, view) => {
                    if (event.ctrlKey || event.metaKey) {
                        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                        if (pos !== null) {
                            event.preventDefault();
                            this._triggerDefinition(pos);
                            
                            const text = view.state.doc.toString();
                            const filePath = this.file ? this.file.path : '';
                            const token = Navigation.resolveToken(text, pos, filePath);
                            if (token) {
                                Navigation.handleNavigation(token);
                            }
                        }
                    }
                }
            }),
            keymap.of([
                {
                    key: "Ctrl-Alt-u",
                    mac: "Cmd-Alt-u",
                    run: (view) => {
                        this.isLineWrapping = !this.isLineWrapping;
                        localStorage.setItem('jh_wordWrap', this.isLineWrapping.toString());
                        view.dispatch({
                            effects: this.lineWrappingCompartment.reconfigure(
                                this.isLineWrapping ? EditorView.lineWrapping : []
                            )
                        });
                        return true;
                    }
                },
                // Escape dismisses the active search — highlights AND the query.
                // Clearing only the highlights left the term in the search box,
                // so Ctrl+K / F3 immediately re-ran the search the user had just
                // dismissed (see window.clearSearch).
                {
                    key: 'Escape',
                    run: () => {
                        const hasSearch = (State.searchMatches && State.searchMatches.length)
                            || (State._autoSearchTerm);
                        if (hasSearch && typeof window.clearSearch === 'function') {
                            window.clearSearch();
                            return true;
                        }
                        return false;
                    }
                },
                // Alt+A: sort selected lines ascending. Alt+M: dedupe selected lines.
                { key: 'Alt-a', run: sortSelectedLines },
                { key: 'Alt-m', run: dedupeSelectedLines },
                ...closeBracketsKeymap,
                ...defaultKeymap,
                // NOTE: searchKeymap is intentionally omitted — it opens CM6's
                // own (2-row, cramped) search panel. The app has its own search
                // UI (#search-panel), so we don't want a second one.
                ...historyKeymap,
                ...foldKeymap,
                ...completionKeymap,
                // Tab inserts a tab at the caret (indents only when a multi-line
                // selection is active); Shift-Tab outdents. `indentWithTab` was
                // wrong here — it always indented at the line start.
                { key: 'Tab', run: insertTab, shift: indentLess }
            ]),
            jhTheme,
            // Follow the app theme: oneDark for dark themes, the default light
            // highlight style otherwise (so a light theme isn't stuck dark).
            this.syntaxCompartment.of(this._syntaxExtension()),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    const newContent = update.state.doc.toString();
                    if (this.file) {
                        this.file.content = newContent;
                        this.file.isDirty = true;
                        // The other pane may be showing this same buffer. Send
                        // it the CHANGES rather than the whole text: the two
                        // documents start identical and every edit is mirrored,
                        // so they stay identical — and the sibling keeps its own
                        // cursor, scroll and undo history, which replacing its
                        // document would throw away.
                        if (this.options.onDocChanged && !this._applyingRemote) {
                            this.options.onDocChanged(this.file, update.changes, this);
                        }
                        if (this.options.renderTabs) this.options.renderTabs();
                        // Keep the LSP server's copy in sync (debounced inside).
                        try { if (this.file.path) lspClient.didChange(this.file.path, newContent); } catch (e) { /* ignore */ }
                    }
                }
                // Keep the status bar's Ln/Col in sync on cursor moves too, not
                // just edits.
                if ((update.docChanged || update.selectionSet) && this.options.updateStatusBar) {
                    this.options.updateStatusBar();
                }
                // Selecting a word promotes it to the search term (so Ctrl+K /
                // F3 walk its occurrences) unless a real search is running.
                if (update.selectionSet && !update.docChanged) {
                    this._scheduleSelectionSearch();
                }
                // Keep the HTML preview in step with the source (debounced —
                // reloading an iframe on every keystroke is expensive).
                if (update.docChanged && this._htmlFrame) {
                    clearTimeout(this._htmlPvTimer);
                    this._htmlPvTimer = setTimeout(() => this._refreshHtmlPreview(), 400);
                }
            })
        ];

        // AI inline (ghost-text) completion — Copilot-style, Tab to accept.
        try {
            extensions.push(createInlineCompletionExtension({
                getFile: () => ({ path: this.file?.path || null, name: this.file?.name || null }),
            }));
        } catch (_) { /* inline completion must never break the editor */ }

        // Language Support — fall back to the file NAME for unsaved drafts
        // (path is null for "Untitled.md"), otherwise they open without any
        // syntax highlighting until first saved to disk.
        const langExt = this._getLanguageExtension(this.file?.path || this.file?.name);
        if (langExt) extensions.push(langExt);

        // Restore the previous editor state (including undo/redo history and
        // cursor) when re-opening this file, so switching tabs doesn't wipe the
        // history. Falls back to a fresh state if the content changed externally
        // or deserialization fails.
        let state = null;
        const savedJSON = readViewState(this.file, this.options.pane);
        if (savedJSON && savedJSON.doc === content) {
            try {
                state = EditorState.fromJSON(savedJSON, { extensions }, { history: historyField });
            } catch (e) {
                state = null;
            }
        }
        if (!state) {
            state = EditorState.create({ doc: content, extensions });
        }

        this._stateOwnerFile = this.file;
        this.editorView = new EditorView({
            state,
            parent: editorContainer
        });

        // Follow theme switches while this editor is on screen. Re-adding the
        // same reference is a no-op in the DOM, so this cannot double-register.
        window.addEventListener('themeChanged', this._onThemeChanged);

        // Restore the previous scroll position (saved in destroy()) after the
        // editor has laid out, so returning to a tab keeps the same viewport.
        const savedScrollTop = readViewScroll(this.file, this.options.pane);
        if (savedScrollTop) {
            requestAnimationFrame(() => {
                if (this.editorView) this.editorView.scrollDOM.scrollTop = savedScrollTop;
            });
        }

        // Vim status badge + hint, and (when on) mode-change tracking.
        this._setupVimUI();

        // First paint of the HTML preview, once the document is available.
        if (this._htmlFrame) this._refreshHtmlPreview();

        // LSP: announce this document to the language server (this is what
        // actually STARTS the server on the first code file). Without it no
        // server ever runs, so completion / hover / go-to-definition and
        // diagnostics never work. Requires an open workspace (server root).
        try {
            const p = this.file?.path;
            if (p && lspClient.getLanguageForFile(p)) {
                lspClient.didOpen(p, content);
                this._lspOpenedPath = p;
            }
        } catch (e) { /* non-critical */ }
    }

    // ── Vim (vi) mode ────────────────────────────────────────────────────────
    _setupVimUI() {
        if (this._vimBadge) { try { this._vimBadge.remove(); } catch (_) {} }
        const badge = document.createElement('button');
        badge.className = 'cm-toolbar-btn cm-vim-badge';
        badge.title = tr('Toggle Vim (vi) mode — Ctrl+Alt+V');
        badge.innerHTML = `${ICON_KEYBOARD}<span class="cm-tb-label"></span>`;
        badge.onclick = (e) => { e.stopPropagation(); this.setVimEnabled(!this.vimEnabled); };
        // Place it to the LEFT of the Book Mode button in the shared toolbar.
        const bar = this._viewToolbar || this.container;
        bar.insertBefore(badge, bar.firstChild);
        this._vimBadge = badge;
        this._updateVimBadge('normal');
        this._hookVimMode();
    }

    _updateVimBadge(mode) {
        if (!this._vimBadge) return;
        const label = this._vimBadge.querySelector('.cm-tb-label');
        if (this.vimEnabled) {
            if (label) label.textContent = `Vim: ${String(mode || 'normal').toUpperCase()}`;
            this._vimBadge.classList.add('active');
        } else {
            if (label) label.textContent = tr('Vim: Off');
            this._vimBadge.classList.remove('active');
        }
    }

    _hookVimMode() {
        if (!this.vimEnabled || !this.editorView) return;
        try {
            const cm = getCM(this.editorView);
            if (cm && cm.on) {
                this._vimModeHandler = (e) => this._updateVimBadge(e && e.mode ? e.mode : 'normal');
                cm.on('vim-mode-change', this._vimModeHandler);
            }
        } catch (_) { /* vim not active */ }
    }

    setVimEnabled(enabled) {
        this.vimEnabled = !!enabled;
        localStorage.setItem('settings_editorVim', this.vimEnabled ? 'true' : 'false');
        // The bottom-right usage hint has to swap to (or away from) the vi
        // command palette. Announced as an event rather than called directly:
        // Editor.js already imports this module, so the reverse import would
        // close a cycle — and the toolbar badge toggles vi through here too.
        window.dispatchEvent(new CustomEvent('vimModeChanged', {
            detail: { enabled: this.vimEnabled },
        }));
        if (this.editorView) {
            this.editorView.dispatch({
                effects: this.vimCompartment.reconfigure(this.vimEnabled ? vim() : [])
            });
            this._updateVimBadge('normal');
            if (this.vimEnabled) this._hookVimMode();
            this.editorView.focus();
        }
    }

    isVimEnabled() { return !!this.vimEnabled; }

    getLineCount() {
        return this.editorView ? this.editorView.state.doc.lines : 0;
    }

    toggleBookMode() {
        State.plainTextViewMode = State.plainTextViewMode === 'book' ? 'edit' : 'book';
        localStorage.setItem('settings_plainTextViewMode', State.plainTextViewMode);
        const content = (this.editorView ? this.editorView.state.doc.toString() : (this.file && this.file.content)) || '';
        this.render(content, this.file);
    }

    _getLanguageExtension(path) {
        if (!path) return null;
        const ext = path.split('.').pop().toLowerCase();
        switch (ext) {
            case 'js': case 'jsx': case 'ts': case 'tsx': return javascript();
            case 'html': case 'htm': case 'jsp': return html();
            case 'css': case 'scss': case 'less': return css();
            case 'json': return json();
            case 'xml': case 'xsd': case 'wsdl': case 'svg': return xml();
            case 'java': return java();
            case 'py': return python();
            case 'md': case 'markdown': return markdown();
            case 'sql': return sql();
            case 'c': case 'cpp': case 'h': case 'hpp': return cpp();
            case 'rs': return rust();
            case 'yaml': case 'yml': return yaml();
            case 'svelte': return svelte();
            default: return null;
        }
    }

    _lspCompletionSource = async (context) => {
        if (!this.file || !this.file.path) return null;
        const pos = context.pos;
        const lineObj = context.state.doc.lineAt(pos);
        const line = lineObj.number - 1; // 0-based
        const character = pos - lineObj.from;

        const items = await lspClient.getCompletion(this.file.path, line, character);
        if (!items || items.length === 0) return null;

        const word = context.matchBefore(/\w*/);
        
        return {
            from: word ? word.from : pos,
            options: items.map(item => {
                const type = this._mapLspCompletionKind(item.kind);
                return {
                    label: item.label,
                    type,
                    info: item.detail || item.documentation,
                    apply: item.insertText || item.label
                };
            })
        };
    };

    /**
     * Apply an edit made in the OTHER pane's view of this same buffer.
     *
     * A split shares the buffer object, so both panes must show the same text.
     * The changes are applied rather than the document replaced, which leaves
     * this view's cursor, scroll and undo history alone — replacing the doc
     * would reset all three on every keystroke typed next door.
     *
     * `_applyingRemote` stops the echo: the dispatch below fires this view's own
     * updateListener, which would otherwise mirror the change straight back.
     */
    applyRemoteChanges(changes) {
        if (!this.editorView || this._applyingRemote) return;
        this._applyingRemote = true;
        try {
            this.editorView.dispatch({
                changes,
                // The other pane's typing must not scroll this one.
                scrollIntoView: false,
            });
        } catch (e) {
            // Out of sync (a re-render on one side only). Fall back to the
            // buffer's text, which is the authority.
            try {
                const doc = this.editorView.state.doc;
                this.editorView.dispatch({
                    changes: { from: 0, to: doc.length, insert: this.file ? this.file.content : '' },
                    scrollIntoView: false,
                });
            } catch (_) { /* give up rather than throw into the listener */ }
        } finally {
            this._applyingRemote = false;
        }
    }

    _mapLspCompletionKind(kind) {
        const kinds = [
            'text', 'method', 'function', 'constructor', 'field',
            'variable', 'class', 'interface', 'module', 'property',
            'unit', 'value', 'enum', 'keyword', 'snippet',
            'color', 'file', 'reference', 'folder', 'enumMember',
            'constant', 'struct', 'event', 'operator', 'typeParameter'
        ];
        return kinds[kind - 1] || 'text';
    }

    _lspHoverTooltip() {
        return hoverTooltip(async (view, pos, side) => {
            if (!this.file || !this.file.path) return null;
            const lineObj = view.state.doc.lineAt(pos);
            const line = lineObj.number - 1;
            const character = pos - lineObj.from;

            const hover = await lspClient.getHover(this.file.path, line, character);
            if (!hover || !hover.contents) return null;

            let text = '';
            if (typeof hover.contents === 'string') text = hover.contents;
            else if (Array.isArray(hover.contents)) {
                text = hover.contents.map(c => typeof c === 'string' ? c : c.value).join('\n');
            } else if (hover.contents.value) text = hover.contents.value;

            if (!text) return null;

            return {
                pos,
                create(view) {
                    const dom = document.createElement("div");
                    dom.className = "cm-lsp-hover-tooltip";
                    dom.style.padding = "6px 10px";
                    dom.style.fontFamily = "var(--editor-font-family)";
                    dom.style.fontSize = "var(--editor-font-size, 11.5pt)";
                    dom.style.whiteSpace = "pre-wrap";
                    dom.style.maxWidth = "500px";
                    dom.textContent = text;
                    return { dom };
                }
            };
        });
    }

    _updateDiagnostics(diagnostics) {
        if (!this.editorView) return;
        const cmDiagnostics = diagnostics.map(d => {
            const doc = this.editorView.state.doc;
            let from = 0;
            let to = 0;
            try {
                const startLine = doc.line(d.line + 1);
                from = startLine.from + d.character;
                const endLine = doc.line((d.end_line !== undefined ? d.end_line : d.line) + 1);
                to = endLine.from + (d.end_character !== undefined ? d.end_character : d.character);
            } catch (e) {
                return null; // Line out of bounds
            }

            let severity = 'info';
            if (d.severity === 1) severity = 'error';
            else if (d.severity === 2) severity = 'warning';
            else if (d.severity === 3) severity = 'info';

            return {
                from: Math.min(from, doc.length),
                to: Math.min(to, doc.length),
                severity,
                message: d.message,
                source: d.source
            };
        }).filter(d => d !== null);

        this.editorView.dispatch(setDiagnostics(this.editorView.state, cmDiagnostics));
    }

    focus() {
        if (this.editorView) this.editorView.focus();
    }

    _whitespaceExtensions() {
        if (!State.showWhitespace) return [];
        const glyph = eolGlyph(this.file && this.file.eol);
        return [fullWidthSpacePlugin, tabPlugin, makeNewlinePlugin(glyph)];
    }

    // Called by Editor.toggleWhitespace() to show/hide the ↵ → □ markers live.
    setWhitespace() {
        if (!this.editorView) return;
        this.editorView.dispatch({
            effects: this.whitespaceCompartment.reconfigure(this._whitespaceExtensions())
        });
    }

    // Route the app's Ctrl+Z / Ctrl+Y through CM6's own history. Without these
    // methods app:undo falls back to document.execCommand('undo'), which fights
    // CM6's state and can't properly revert newlines/deletions.
    undo() {
        if (this.editorView) { undo(this.editorView); this.editorView.focus(); }
    }

    redo() {
        if (this.editorView) { redo(this.editorView); this.editorView.focus(); }
    }

    getCursorOffset() {
        if (!this.editorView) return 0;
        return this.editorView.state.selection.main.head;
    }

    // Current selection range — find-next uses `to`, find-prev uses `from`, so a
    // selected match isn't re-selected when navigating backward.
    getSelectionOffsets() {
        if (!this.editorView) return null;
        const s = this.editorView.state.selection.main;
        return { from: s.from, to: s.to };
    }

    // Apply an AI edit back to its anchor after an async round-trip. Three tiers,
    // so we never write to the wrong place: (1) if the original text still sits at
    // [from,to], replace it there; (2) else find the original text and replace the
    // nearest occurrence; (3) else insert at the caret. Returns true if applied.
    applyEditAtRange(from, to, originalText, newText) {
        if (!this.editorView) return false;
        const doc = this.editorView.state.doc;
        const len = doc.length;
        let range = null;
        if (from != null && to != null && from <= len && to <= len
            && originalText != null && doc.sliceString(from, to) === originalText) {
            range = { from, to };
        } else if (originalText) {
            const full = doc.toString();
            let idx = -1;
            if (from != null) {
                // Prefer the occurrence nearest the original anchor.
                const before = full.lastIndexOf(originalText, from);
                const after = full.indexOf(originalText, from);
                if (after !== -1 && before !== -1) {
                    idx = (from - before) <= (after - from) ? before : after;
                } else {
                    idx = after !== -1 ? after : before;
                }
            } else {
                idx = full.indexOf(originalText);
            }
            if (idx !== -1) range = { from: idx, to: idx + originalText.length };
        }
        if (range) {
            this.editorView.dispatch({
                changes: { from: range.from, to: range.to, insert: newText },
                selection: { anchor: range.from, head: range.from + newText.length },
                scrollIntoView: true
            });
        } else {
            this.insertTextAtCursor(newText);
        }
        this.editorView.focus();
        return true;
    }

    // Mirrors the dark-theme detection used elsewhere (ThemeInfo, etc).
    /**
     * Which syntax palette this theme wants.
     *
     * PALETTE_THEMES ship a full --hl-* set tuned to their own background, so
     * that is what the editor uses. oneDark is not an option for them: it is a
     * whole theme and would repaint the background its own blue-grey. CM's
     * defaultHighlightStyle is built for LIGHT backgrounds — on bamboo its dark
     * purples and reds measured 1.4-2.0:1, which is what made the code
     * unreadable. Every other theme keeps exactly what it had.
     */
    _syntaxExtension() {
        const c = document.body.classList;
        if (PALETTE_THEMES.some((t) => c.contains(t))) {
            return syntaxHighlighting(themeHighlightStyle());
        }
        return this._isDarkTheme() ? oneDark : syntaxHighlighting(defaultHighlightStyle);
    }

    /** Swap the syntax palette in place after a theme change. */
    _applySyntaxTheme() {
        if (!this.editorView) return;
        this.editorView.dispatch({
            effects: this.syntaxCompartment.reconfigure(this._syntaxExtension()),
        });
    }

    _isDarkTheme() {
        return isAppThemeDark();
    }

    // Insert text at the caret (replacing any selection). Used by the AI tools
    // and inline-AI apply path, which previously assumed a <textarea>.
    // Uses replaceSelection so CM6 handles line-ending normalization and cursor
    // placement (a manual from+length can land outside the doc when the text
    // contains CRLF).
    insertTextAtCursor(text) {
        if (!this.editorView || text == null) return;
        this.editorView.dispatch(this.editorView.state.replaceSelection(String(text)));
        this.editorView.focus();
    }

    // Currently selected text ('' if the selection is empty).
    /**
     * Debounced entry point for "selecting a word highlights it everywhere".
     * Debounced because a drag-select fires selectionSet on every mouse move.
     */
    _scheduleSelectionSearch() {
        clearTimeout(this._selSearchTimer);
        this._selSearchTimer = setTimeout(() => this._searchSelectedWord(), 200);
    }

    /**
     * Make the selected word the active search term, so it is highlighted
     * everywhere and Ctrl+K / F3 step through its occurrences.
     *
     * An explicit search the user typed always wins and is never overwritten
     * (requirement 2-1). To still allow *repeated* word selections to work, we
     * remember the term we set ourselves: if the box still holds exactly that,
     * it is ours to replace; anything else is the user's and is left alone.
     */
    _searchSelectedWord() {
        if (!this.editorView) return;
        // Only when this editor is the active view (a background pane must not
        // hijack the search box).
        try {
            if (typeof window.app?.getCurrentView === 'function' && window.app.getCurrentView() !== this) return;
        } catch (_) { /* ignore */ }

        const input = document.getElementById('find-input');
        if (!input) return;

        const sel = this.editorView.state.selection.main;
        const text = sel.empty ? '' : this.editorView.state.sliceDoc(sel.from, sel.to);

        // A "word": no whitespace, at least 2 chars, and not an entire line-worth
        // of text (long selections are almost never a word).
        const isWord = !!text && text.length >= 2 && text.length <= 80 && !/\s/.test(text);
        if (!isWord) return;

        const current = input.value;
        const ours = State._autoSearchTerm;
        // Someone else's (user-typed) search is in the box → leave it be.
        if (current && current !== ours) return;
        if (current === text) return; // already searching for it

        State._autoSearchTerm = text;
        input.value = text;
        try {
            if (typeof window.performSearchInternal === 'function') {
                // noFocus + keepPosition: highlight the occurrences without
                // stealing focus or yanking the view to the first hit — the
                // user is reading where they are.
                window.performSearchInternal(true, true);
            }
        } catch (e) { console.warn('selection search failed', e); }
    }

    getSelectedText() {
        if (!this.editorView) return '';
        const state = this.editorView.state;
        // Include EVERY selection range (rectangular / column selection produces
        // one range per line), joined by the document's line separator — matching
        // CM6's native copy. Using only selection.main copied just the first line.
        const ranges = state.selection.ranges.filter(r => !r.empty).sort((a, b) => a.from - b.from);
        if (ranges.length === 0) return '';
        return ranges.map(r => state.sliceDoc(r.from, r.to)).join(state.lineBreak);
    }

    // Replace the current selection (or insert at the caret) with `text`.
    replaceSelectedText(text) {
        this.insertTextAtCursor(text);
    }

    // Clipboard ops routed through CM6's state so the doc stays consistent
    // (the app's copy/cut/paste shortcuts call these).
    copy() {
        const text = this.getSelectedText();
        if (text) writeText(text);
    }

    cut() {
        if (!this.editorView) return;
        // Copy ALL ranges (rectangular selection = one per line), then delete
        // them — replaceSelection('') clears every range.
        const text = this.getSelectedText();
        if (!text) return;
        writeText(text);
        this.editorView.dispatch(this.editorView.state.replaceSelection(''));
        this.editorView.focus();
    }

    async paste() {
        if (!this.editorView) return;
        let text = '';
        try { text = await readText(); } catch (e) { return; }
        if (text == null || !this.editorView) return;
        // replaceSelection normalizes CRLF and places the caret correctly; a
        // manual from+length offset can point outside the doc (RangeError).
        this.editorView.dispatch(this.editorView.state.replaceSelection(String(text)));
        this.editorView.focus();
    }

    // Status-bar info: 1-based line/col of the caret and the selection length.
    getStatusInfo() {
        if (!this.editorView) return null;
        const state = this.editorView.state;
        const sel = state.selection.main;
        const line = state.doc.lineAt(sel.head);
        return {
            line: line.number,
            col: sel.head - line.from + 1,
            selectionLength: sel.to - sel.from
        };
    }

    async _triggerDefinition(offset) {
        if (!this.file || !this.file.path || !this.editorView) return;
        const lineObj = this.editorView.state.doc.lineAt(offset);
        const line = lineObj.number - 1;
        const character = offset - lineObj.from;

        const result = await lspClient.getDefinition(this.file.path, line, character);
        if (!result) return;

        const location = Array.isArray(result) ? result[0] : result;
        if (location) {
            const uri = location.uri || location.targetUri;
            const range = location.range || location.targetSelectionRange;
            if (uri && range) {
                const path = uri.replace('file:///', '').replace('file://', '');
                if (window.app && window.app.openFile) {
                    window.app.openFile(path, false, range.start.line + 1); // LSP line is 0-based
                }
            }
        }
    }

    async _triggerReferences(offset) {
        if (!this.file || !this.file.path || !this.editorView) return;
        const lineObj = this.editorView.state.doc.lineAt(offset);
        const line = lineObj.number - 1;
        const character = offset - lineObj.from;

        const results = await lspClient.getReferences(this.file.path, line, character);
        if (!results || results.length === 0) return;

        this._showReferencesModal(results);
    }

    _handleInlineAI() {
        if (!this.editorView) return;
        const state = this.editorView.state;
        const pos = state.selection.main.head;
        const coords = this.editorView.coordsAtPos(pos);
        if (!coords) return; // Cursor might be scrolled out of view

        // Context around the cursor (±20 lines) — but only when the AI context
        // scope allows the file itself to be read. At "Selection only" the
        // prompt carries the selection and nothing more, which is the whole
        // point of that setting: pressing this must not quietly widen it.
        let context = '';
        if (allows('cursorContext') && !isPrivatePath(this.file && this.file.path)) {
            const doc = state.doc;
            const line = doc.lineAt(pos);
            const startLine = Math.max(1, line.number - 20);
            const endLine = Math.min(doc.lines, line.number + 20);
            context = doc.sliceString(doc.line(startLine).from, doc.line(endLine).to);
        } else {
            context = this.getSelectedText ? (this.getSelectedText() || '') : '';
        }

        // CM6 coordsAtPos returns viewport-relative coords, which match position:fixed.
        // We'll adjust slightly so the popup doesn't block the line.
        const x = coords.left;
        const y = coords.bottom + 5;

        this.inlineAI.show(x, y, context);

        this.inlineAI.onApply = (newCode) => {
            if (!this.editorView || newCode == null) return;
            // replaceSelection handles CRLF normalization + caret placement so a
            // manual from+length offset can't fall outside the doc (RangeError).
            this.editorView.dispatch(this.editorView.state.replaceSelection(String(newCode)));
            this.editorView.focus();
        };
    }

    // ── Search Integration ──

    isCodeMirrorMode() {
        return true;
    }

    _buildQuery(query, isRegex, isCaseSensitive, isWord, replaceWith) {
        return new SearchQuery({
            search: query,
            caseSensitive: isCaseSensitive,
            regexp: isRegex,
            wholeWord: isWord,
            // When regex is OFF, treat the query literally so escape sequences
            // like \t are NOT interpreted as a tab (they were before).
            literal: !isRegex,
            ...(replaceWith != null ? { replace: replaceWith } : {})
        });
    }

    // Chunked, cancellable, async match collection so a search over a large file
    // with many hits doesn't freeze the UI. `onProgress(count)` is called between
    // chunks; a newer search (bumping _searchToken) supersedes an in-flight one.
    async performSearch(query, isRegex, isCaseSensitive, isWord, onProgress) {
        if (!this.editorView) return;
        const token = (this._searchToken = (this._searchToken || 0) + 1);

        const sq = this._buildQuery(query, isRegex, isCaseSensitive, isWord);
        if (!sq.valid) {
            State.searchMatches = [];
            this.renderSearchHighlights([], 0);
            this._updateSearchScrollbarMarks();
            return;
        }

        const matches = [];
        const MAX_MATCHES = 20000;
        const CHUNK = 2000;
        const cursor = sq.getCursor(this.editorView.state);
        let m;
        while (!(m = cursor.next()).done) {
            matches.push({ start: m.value.from, end: m.value.to, isCodeMirror: true });
            if (matches.length >= MAX_MATCHES) break;
            if (matches.length % CHUNK === 0) {
                if (onProgress) onProgress(matches.length);
                // Yield so the UI can paint; abort if superseded/destroyed.
                await new Promise(r => setTimeout(r, 0));
                if (token !== this._searchToken || !this.editorView) return;
            }
        }
        if (token !== this._searchToken || !this.editorView) return;

        State.searchMatches = matches;
        State.currentMatchIndex = 0;
        this.renderSearchHighlights(matches, 0);
        this._updateSearchScrollbarMarks();
    }

    // Paint the yellow "all hits" highlight (and orange on the active match).
    // Also called by Search.js's cleanup with an empty list to clear.
    renderSearchHighlights(matches, index) {
        if (!this.editorView) return;
        const doc = this.editorView.state.doc;
        const list = matches || [];
        const ranges = [];
        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (m.start == null || m.end == null || m.end <= m.start) continue;
            const active = i === index;
            // A pure newline hit becomes a compact ↵ chip instead of a mark that
            // spans the '\n' and paints the whole line to the right edge.
            if (m.end === m.start + 1 && doc.sliceString(m.start, m.end) === '\n') {
                const cls = active ? 'cm-searchMatch-nl cm-searchMatch-selected' : 'cm-searchMatch-nl';
                ranges.push(Decoration.widget({ widget: new SearchNlWidget(cls), side: 1 }).range(m.start));
            } else {
                const cls = active ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch';
                ranges.push(Decoration.mark({ class: cls }).range(m.start, m.end));
            }
        }
        // Decoration.set(..., true) sorts, so marks/widgets can be interleaved.
        this.editorView.dispatch({ effects: setSearchHighlights.of(Decoration.set(ranges, true)) });
    }

    _updateSearchScrollbarMarks() {
        if (!this.editorView) return;
        const wrapper = this.editorView.dom; 
        let marksContainer = wrapper.querySelector('.cm-search-scrollbar-marks');
        if (!marksContainer) {
            marksContainer = document.createElement('div');
            marksContainer.className = 'cm-search-scrollbar-marks';
            // Clickable: the strip is a mini "jump to match" ruler, so it must
            // receive pointer events (it used to be pointer-events:none).
            // Widened a little so it's an easier target.
            marksContainer.style.cssText = 'position:absolute; top:0; right:14px; width:10px; height:100%; z-index:100; cursor:pointer;';
            marksContainer.title = tr('Click to jump to the nearest match');
            marksContainer.addEventListener('click', (e) => this._jumpToScrollbarMark(e, marksContainer));
            wrapper.appendChild(marksContainer);
        }
        marksContainer.innerHTML = '';

        if (!State.searchMatches || State.searchMatches.length === 0) {
            marksContainer.style.display = 'none';
            return;
        }
        marksContainer.style.display = '';

        const doc = this.editorView.state.doc;
        const totalLines = doc.lines;

        // Cap the number of scrollbar ticks — building tens of thousands of divs
        // (and doc.lineAt calls) is itself slow. Sample evenly for big result sets.
        const all = State.searchMatches;
        const MAX_TICKS = 800;
        const step = all.length > MAX_TICKS ? Math.ceil(all.length / MAX_TICKS) : 1;

        let html = '';
        for (let i = 0; i < all.length; i += step) {
            const m = all[i];
            const line = doc.lineAt(m.start);
            const pct = (line.number / totalLines) * 100;
            // 3px tall and full width: a 2px sliver was hard to hit.
            html += `<div class="cm-search-tick" style="position:absolute; top:${pct}%; left:0; width:100%; height:3px; background-color:rgba(255, 152, 0, 0.85); pointer-events:none;"></div>`;
        }
        marksContainer.innerHTML = html;
    }

    /**
     * Click on the scrollbar mark strip → jump to the nearest search match.
     * Uses the click's vertical ratio to find the closest match by line, so
     * hitting near a tick is enough (no pixel-perfect aiming required).
     */
    _jumpToScrollbarMark(e, container) {
        if (!this.editorView || !State.searchMatches || State.searchMatches.length === 0) return;
        const rect = container.getBoundingClientRect();
        if (!rect.height) return;
        const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));

        const doc = this.editorView.state.doc;
        const targetLine = Math.max(1, Math.round(ratio * doc.lines));

        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < State.searchMatches.length; i++) {
            const m = State.searchMatches[i];
            if (m.start == null) continue;
            const dist = Math.abs(doc.lineAt(m.start).number - targetLine);
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
            if (dist === 0) break;
        }

        this.scrollToMatch(bestIdx);
        // Keep the "N / M" counter and the active-match highlight in sync.
        try {
            const m = State.searchMatches[bestIdx];
            if (m && typeof window.setSearchMatchIndexByOffset === 'function') {
                window.setSearchMatchIndexByOffset(m.start);
            }
        } catch (_) { /* ignore */ }
    }

    scrollToMatch(index) {
        if (!this.editorView || !State.searchMatches[index]) return;
        const match = State.searchMatches[index];
        this.editorView.dispatch({
            selection: { anchor: match.start, head: match.end },
            scrollIntoView: true
        });
        // Repaint so the orange "current match" moves with navigation.
        this.renderSearchHighlights(State.searchMatches, index);
    }

    // Replace is done standalone (the app doesn't include CM6's search extension,
    // so cmReplaceNext/All aren't available). SearchQuery.getReplacement handles
    // regex $1 group substitution.
    // Compute the replacement text for a match. Consistent with the search side:
    // regex ON → \n/\r/\t and $1 groups are interpreted (literal=false); regex
    // OFF → the replacement is taken literally (\n stays backslash-n), same as
    // the search field. This is CM6's SearchQuery behavior driven by `literal`.
    _computeReplacement(sq, match, replaceWith, isRegex) {
        const repl = String(replaceWith || '');
        if (!isRegex) return repl; // plain mode: literal, matching the search side
        // Regex mode: interpret \n \r \t \\, then resolve $1 / $& capture groups.
        let out = repl.replace(/\\([nrt\\])/g,
            (_, ch) => ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\');
        const groups = match && match.match;
        if (groups) {
            out = out.replace(/\$([$&]|\d+)/g,
                (m, i) => i === '&' ? (groups[0] ?? '') : i === '$' ? '$' : (groups[+i] ?? ''));
        }
        return out;
    }

    replaceNext(query, replaceWith, isRegex, isCaseSensitive, isWord) {
        if (!this.editorView) return;
        const sq = this._buildQuery(query, isRegex, isCaseSensitive, isWord, replaceWith || '');
        if (!sq.valid) return;
        const state = this.editorView.state;
        const from = state.selection.main.to;
        let cursor = sq.getCursor(state, from);
        let m = cursor.next();
        if (m.done) { m = sq.getCursor(state, 0).next(); } // wrap to top
        if (m.done) return;
        const match = m.value;
        const insert = this._computeReplacement(sq, match, replaceWith, isRegex);
        this.editorView.dispatch({
            changes: { from: match.from, to: match.to, insert },
            selection: { anchor: match.from + insert.length },
            scrollIntoView: true
        });
        this.performSearch(query, isRegex, isCaseSensitive, isWord); // refresh matches/highlights
    }

    /**
     * Replace every match.
     *
     * @returns {number} how many were replaced — the count was already sitting
     *   in `changes.length` and was simply discarded, leaving the caller to say
     *   "Replaced all occurrences" whether it replaced 900 or none at all.
     */
    replaceAll(query, replaceWith, isRegex, isCaseSensitive, isWord) {
        if (!this.editorView) return 0;
        const sq = this._buildQuery(query, isRegex, isCaseSensitive, isWord, replaceWith || '');
        if (!sq.valid) return 0;
        const state = this.editorView.state;
        const cursor = sq.getCursor(state, 0);
        const changes = [];
        let m;
        const MAX = 50000;
        while (!(m = cursor.next()).done) {
            const match = m.value;
            const insert = this._computeReplacement(sq, match, replaceWith, isRegex);
            changes.push({ from: match.from, to: match.to, insert });
            if (changes.length >= MAX) break;
        }
        if (changes.length) this.editorView.dispatch({ changes });
        this.performSearch(query, isRegex, isCaseSensitive, isWord); // refresh marks
        return changes.length;
    }

    _showReferencesModal(results) {
        // ... (We can copy the modal code from PlainTextView if needed, or maybe app-level has it?
        // Let's implement a simple modal just like PlainTextView had)
        const existing = document.getElementById('references-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'references-modal-overlay';
        overlay.className = 'tab-search-overlay';

        const container = document.createElement('div');
        container.className = 'tab-search-container';
        container.style.width = '600px';

        const header = document.createElement('div');
        header.style.padding = '12px';
        header.style.borderBottom = '1px solid var(--border-color)';
        header.style.fontWeight = 'bold';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.innerHTML = `<span>References (${results.length})</span><span style="cursor:pointer;" id="close-ref-modal-btn">${svgIcon('close', { size: 12 })}</span>`;
        container.appendChild(header);

        const closeBtn = header.querySelector('#close-ref-modal-btn');
        if (closeBtn) {
            closeBtn.onclick = () => overlay.remove();
        }

        const list = document.createElement('ul');
        list.className = 'tab-search-list';
        list.style.maxHeight = '300px';

        results.forEach((loc) => {
            const uri = loc.uri || loc.targetUri;
            const range = loc.range || loc.targetSelectionRange;
            if (!uri || !range) return;

            const path = uri.replace('file:///', '').replace('file://', '');
            const filename = path.split('/').pop();

            const li = document.createElement('li');
            li.className = 'tab-search-item';
            li.style.display = 'flex';
            li.style.flexDirection = 'column';
            li.style.alignItems = 'flex-start';
            li.style.padding = '8px 12px';

            li.innerHTML = `
                <div style="font-weight: 500; font-size: 13px;">${filename}:${range.start.line + 1}</div>
                <div style="font-size: 11px; opacity: 0.6; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;">${path}</div>
            `;

            li.onclick = () => {
                overlay.remove();
                if (window.app && window.app.openFile) {
                    window.app.openFile(path);
                    setTimeout(() => {
                        const view = window.app.getCurrentView();
                        if (view && typeof view.jumpToLine === 'function') {
                            view.jumpToLine(range.start.line);
                        }
                    }, 200);
                }
            };
            list.appendChild(li);
        });
        container.appendChild(list);
        overlay.appendChild(container);
        document.body.appendChild(overlay);
    }

    destroy() {
        // Don't let a queued selection-search fire against a torn-down view.
        clearTimeout(this._selSearchTimer);
        // Remember the Book-mode page so returning to this tab reopens it there.
        if (this.file && State.plainTextViewMode === 'book') {
            try { this.file._cmBookPage = this.currentPageIndex || 0; } catch (e) { /* ignore */ }
        }
        // LSP: tell the server this document is gone (a following render() will
        // re-open the new/same file). Prevents stale open documents piling up.
        if (this._lspOpenedPath) {
            try { lspClient.didClose(this._lspOpenedPath); } catch (e) { /* ignore */ }
            this._lspOpenedPath = null;
        }
        if (this.editorView) {
            // Preserve state (doc + undo/redo history + selection) on the file so
            // re-opening the tab restores it. _stateOwnerFile is the file the
            // editor was actually created for (this.file may already point at a
            // newer file if destroy() runs mid-render).
            if (this._stateOwnerFile) {
                try {
                    writeViewState(this._stateOwnerFile, this.options.pane, {
                        json: this.editorView.state.toJSON({ history: historyField }),
                        // Also remember the scroll position so switching tabs
                        // and coming back keeps the same viewport (restoring
                        // the cursor alone would only scroll the caret into
                        // view, not the spot the user was reading).
                        scrollTop: this.editorView.scrollDOM.scrollTop,
                    });
                } catch (e) { /* ignore serialization issues */ }
            }
            this.editorView.destroy();
            this.editorView = null;
            window.removeEventListener('themeChanged', this._onThemeChanged);
        }
        if (this.pageFlipInstance) {
            try { this.pageFlipInstance.destroy(); } catch (e) { }
            this.pageFlipInstance = null;
        }
        // Detach our diagnostics handler only if it is still the active one, so a
        // destroyed view can't keep receiving (and ignoring) diagnostics.
        if (this._lspUnsubscribe && lspClient.onDiagnosticsUpdate === this._lspUnsubscribe) {
            lspClient.onDiagnosticsUpdate = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this.inlineAI) {
            this.inlineAI.destroy();
            this.inlineAI = null;
        }
        this.container.innerHTML = '';
    }

    jumpToLine(lineIndex) {
        if (State.plainTextViewMode === 'book') {
            if (this.pageFlipInstance && this.pages) {
                const targetString = `data-line-index="${lineIndex}"`;
                const pageIndex = this.pages.findIndex(pageHtml => pageHtml.includes(targetString));
                if (pageIndex !== -1) {
                    const orientation = this.pageFlipInstance.getOrientation();
                    const current = this.pageFlipInstance.getCurrentPageIndex();
                    const targetSpreadIndex = orientation === 'landscape' ? pageIndex - (pageIndex % 2) : pageIndex;
                    const currentSpreadIndex = orientation === 'landscape' ? current - (current % 2) : current;
                    
                    if (currentSpreadIndex !== targetSpreadIndex) {
                        this.pageFlipInstance.flip(targetSpreadIndex);
                        this.currentPageIndex = targetSpreadIndex;
                    }
                }
            }
            return;
        }

        if (this.editorView) {
            const pos = this.editorView.state.doc.line(lineIndex + 1).from; // CM6 is 1-indexed for lines
            this.editorView.dispatch({
                selection: { anchor: pos, head: pos },
                effects: EditorView.scrollIntoView(pos, { y: 'center' })
            });
            this.editorView.focus();
        }
    }

    // Book Mode Implementation (Copied from PlainTextView and adapted)
    _renderBookMode(content) {
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        if (containerWidth === 0 || containerHeight === 0) return;

        // Restore the page the user was on before switching tabs (saved in
        // destroy()). Only on the initial layout for this file, not on resizes.
        if (this.file && this._lastFilePath !== this.file.path && this.file._cmBookPage) {
            this.currentPageIndex = this.file._cmBookPage;
        }

        const bookWidth = containerWidth;
        // Reserve space for the absolute overlay footer so the last lines aren't
        // hidden behind it (see MarkdownView._renderBookMode).
        const FOOTER_RESERVE = 46;
        const bookHeight = Math.max(200, containerHeight - FOOTER_RESERVE);

        const singlePageWidth = Math.round(bookWidth / 2);
        const singlePageHeight = Math.round(bookHeight);

        this._lastWidth = containerWidth;
        this._lastHeight = containerHeight;
        this._lastFilePath = this.file ? this.file.path : 'untitled';

        const rootStyles = getComputedStyle(document.documentElement);
        const lhStr = rootStyles.getPropertyValue('--editor-line-height-px');
        const actualLineHeight = parseInt(lhStr, 10) || 22;
        const fontSizeStr = rootStyles.getPropertyValue('--editor-font-size').trim() || '11.5pt';

        const fileName = (this.file && this.file.name) || (this.file && this.file.path ? this.file.path.split(/[/\\]/).pop() : '');
        const extension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : 'txt';
        const lang = (extension === 'xsd' || extension === 'wsdl') ? 'xml' : extension;

        let highlighted;
        try {
            if (lang === 'md' || lang === 'markdown' || lang === 'txt') {
                highlighted = SyntaxHighlighter.escapeHtml(content);
            } else {
                highlighted = cmHighlight(content, lang);
            }
        } catch (e) {
            highlighted = SyntaxHighlighter.escapeHtml(content);
        }

        const htmlLines = highlighted.split('\n');
        // Account for the page's vertical padding (.plain-text-page: 15px top +
        // 15px bottom = 30px) plus one line of safety so the last line isn't
        // clipped at the bottom of the page.
        const usableHeight = singlePageHeight - 30 - actualLineHeight;
        const linesPerPage = Math.max(5, Math.floor(usableHeight / actualLineHeight)) || 25;
        this.pages = [];
        
        const showLineNumbers = !(lang === 'md' || lang === 'markdown');
        const wrappedLines = htmlLines.map((line, idx) => {
            const numStr = (idx + 1).toString().padStart(4, ' ');
            const lineNumHtml = showLineNumbers 
                ? `<span style="color: var(--editor-gutter-color, #6e7681); opacity: 0.5; user-select: none; pointer-events: none;">${numStr}  </span>` 
                : '';
            return `<div class="pt-book-line" data-line-index="${idx}" style="display: block; width: 100%; min-height: ${actualLineHeight}px; box-sizing: border-box; padding-left: 5px; margin-left: -5px; transition: background-color 0.5s;">${lineNumHtml}${line || ' '}</div>`;
        });
        
        for (let i = 0; i < wrappedLines.length; i += linesPerPage) {
            this.pages.push(wrappedLines.slice(i, i + linesPerPage).join(''));
        }

        if (this.pages.length === 0) this.pages.push('');

        if (this.currentPageIndex >= this.pages.length) {
            this.currentPageIndex = Math.max(0, this.pages.length - 1);
        }

        const layoutDiv = document.createElement('div');
        layoutDiv.className = 'pt-book-layout';
        layoutDiv.tabIndex = 0;
        layoutDiv.style.outline = 'none';

        const pageContainer = document.createElement('div');
        pageContainer.className = 'pt-book-page-container';
        // Pin to the reserved book height (top-aligned) so the overlay footer
        // sits in the leftover space instead of over the content.
        pageContainer.style.flex = '0 0 auto';
        pageContainer.style.height = bookHeight + 'px';

        const bookDiv = document.createElement('div');
        bookDiv.className = 'pt-book-flipbook';

        this.pages.forEach((pageHtml, idx) => {
            const pageEl = document.createElement('div');
            pageEl.className = 'stf__page pt-book-page plain-text-page';
            pageEl.style.fontFamily = "'HackGen Console', 'HackGen', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace";
            pageEl.style.whiteSpace = 'pre';
            pageEl.style.fontSize = fontSizeStr;
            pageEl.style.lineHeight = `${actualLineHeight}px`;
            // PageFlip overwrites pageEl inline styles (padding/boxSizing), so we set the margin in editor.css (.plain-text-page).
            pageEl.innerHTML = `<pre class="cm-highlighted" style="margin: 0; padding: 0; box-sizing: border-box; height: 100%; white-space: pre; font-family: inherit; font-size: ${fontSizeStr}; line-height: ${actualLineHeight}px; color: inherit; background: transparent; overflow-x: auto;"><code>${pageHtml}</code></pre>`;
            bookDiv.appendChild(pageEl);
        });

        if (this.pages.length % 2 !== 0) {
            const blankPage = document.createElement('div');
            blankPage.className = 'stf__page pt-book-page stf__page--blank';
            bookDiv.appendChild(blankPage);
        }

        pageContainer.appendChild(bookDiv);

        const footer = document.createElement('div');
        footer.className = 'pt-book-footer';

        const progressContainer = document.createElement('div');
        progressContainer.className = 'pt-book-progress-container';

        const progressThumb = document.createElement('div');
        progressThumb.className = 'pt-book-progress-thumb';

        const progressBar = document.createElement('div');
        progressBar.className = 'pt-book-progress-bar';
        const progressPercent = this.pages.length > 1 ? (this.currentPageIndex / (this.pages.length - 1)) * 100 : 100;
        progressBar.style.width = `${progressPercent}%`;
        progressContainer.appendChild(progressBar);
        progressContainer.appendChild(progressThumb);
        progressThumb.style.left = `${progressPercent}%`;

        const pageInfo = document.createElement('span');
        pageInfo.className = 'pt-book-page-info';
        pageInfo.textContent = `Page ${this.currentPageIndex + 1} of ${this.pages.length}`;

        const hint = document.createElement('span');
        hint.className = 'pt-book-hint';
        hint.textContent = 'Alt + ← / → : turn page';

        footer.appendChild(progressContainer);
        footer.appendChild(pageInfo);
        footer.appendChild(hint);

        layoutDiv.appendChild(pageContainer);
        layoutDiv.appendChild(footer);
        this.container.appendChild(layoutDiv);

        try {
            this.pageFlipInstance = new PageFlip(bookDiv, {
                width: singlePageWidth,
                height: singlePageHeight,
                size: 'fixed',
                maxWidth: 3000,
                minHeight: 100,
                maxHeight: 3000,
                drawShadow: true,
                flippingTime: 800,
                usePortrait: false,
                showCover: false,
                autoSize: true,
                maxShadowOpacity: 0.6,
                mobileScrollSupport: false,
                disableFlipByClick: false,
                useMouseEvents: false
            });

            bookDiv.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (!this.pageFlipInstance) return;
                const rect = bookDiv.getBoundingClientRect();
                const x = e.clientX - rect.left;
                if (x < rect.width / 2) this.pageFlipInstance.flipPrev();
                else this.pageFlipInstance.flipNext();
            });

            const pageElements = bookDiv.querySelectorAll('.stf__page');
            if (pageElements.length > 0) {
                this.pageFlipInstance.loadFromHTML(pageElements);
            }

            if (this.currentPageIndex > 0 && this.currentPageIndex < this.pages.length) {
                setTimeout(() => {
                    try { this.pageFlipInstance.flip(this.currentPageIndex); } catch (e) { }
                }, 100);
            }

            this.pageFlipInstance.on('flip', (e) => {
                this.currentPageIndex = e.data;
                const percent = this.pages.length > 1 ? (this.currentPageIndex / (this.pages.length - 1)) * 100 : 100;
                progressBar.style.width = `${percent}%`;
                progressThumb.style.left = `${percent}%`;
                pageInfo.textContent = `Page ${this.currentPageIndex + 1} of ${this.pages.length}`;
            });
        } catch (e) {
            console.error('PageFlip plain text init failed:', e);
        }

        // Keyboard navigation
        if (this._keydownHandler) {
            window.removeEventListener('keydown', this._keydownHandler, true);
        }
        this._keydownHandler = (e) => {
            if (State.plainTextViewMode !== 'book') return;
            if (!this.pageFlipInstance) return;
            // The explorer owns arrow keys while it has focus: ShortcutManager
            // dispatches explorer:nav → VirtualExplorer.handleKeyDown, which
            // stamps the event. Its virtual-scroll re-render detaches the
            // focused row, so the target/activeElement guards below can't see
            // it; the stamp can.
            if (e.__explorerKeyDown) return;
            
            if (!this.container || this.container.offsetParent === null) return;

            if (document.activeElement && (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT')) {
                return;
            }
            // The explorer owns the arrow keys while it has focus: its rows
            // live in #file-list, a descendant of #explorer. Judge by the EVENT
            // TARGET first (virtual scrolling destroys the focused row on every
            // keypress, dropping activeElement to <body> and making the
            // activeElement check below miss); the target of a keydown that
            // started inside the explorer stays inside it.
            if (e.target && typeof e.target.closest === 'function' && e.target.closest('#explorer')) {
                return;
            }
            if (document.activeElement && typeof document.activeElement.closest === 'function' &&
                document.activeElement.closest('#explorer')) {
                return;
            }
            if (e.target && e.target.closest) {
                if (e.target.closest('#explorer-list-container') || e.target.closest('#explorer-search') || 
                    e.target.closest('.tab-search-overlay') || e.target.closest('#search-panel') || 
                    e.target.closest('.ai-review-overlay') || e.target.closest('.settings-modal')) {
                    return;
                }
            }

            // Page flipping is Alt+Left / Alt+Right so plain arrow keys don't
            // unexpectedly turn pages (the hint is shown in the footer).
            if (e.altKey && e.key === 'ArrowLeft') {
                e.preventDefault();
                e.stopPropagation();
                this.pageFlipInstance.flipPrev();
            } else if (e.altKey && e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                this.pageFlipInstance.flipNext();
            }
        };
        window.addEventListener('keydown', this._keydownHandler, true);
        this._keydownBound = true;

        this._resizeObserver = new ResizeObserver(() => {
            if (State.plainTextViewMode === 'book' && this.file && this.file.path === this._lastFilePath) {
                const rect = this.container.getBoundingClientRect();
                if (Math.abs(rect.width - this._lastWidth) > 5 || Math.abs(rect.height - this._lastHeight) > 5) {
                    this._renderBookMode(content);
                }
            }
        });
        this._resizeObserver.observe(this.container);
    }
}

/**
 * Drag `bar` to resize `left` within `container`. Sizes are applied as a flex
 * basis so the preview pane simply takes whatever is left over.
 *
 * Uses pointer capture: while dragging, every pointer event is retargeted to
 * the bar, so moving the cursor over the preview <iframe> (which swallows
 * plain mousemove/mouseup) keeps the drag alive and guarantees the release is
 * seen. Without it the splitter stuck in "dragging" near the left edge and
 * could not be dragged back right across the iframe.
 */
function _makeSplitDrag(bar, left, container, file) {
    bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        let last = e.clientX;
        const prevSel = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
        bar.classList.add('dragging');
        bar.setPointerCapture(e.pointerId);
        const move = (ev) => {
            const w = left.getBoundingClientRect().width + (ev.clientX - last);
            last = ev.clientX;
            const max = container.getBoundingClientRect().width - 180;
            left.style.flex = `0 0 ${Math.min(Math.max(180, w), Math.max(180, max))}px`;
        };
        const up = () => {
            bar.classList.remove('dragging');
            document.body.style.userSelect = prevSel;
            bar.removeEventListener('pointermove', move);
            bar.removeEventListener('pointerup', up);
            bar.removeEventListener('pointercancel', up);
            if (bar.hasPointerCapture && bar.hasPointerCapture(e.pointerId)) {
                bar.releasePointerCapture(e.pointerId);
            }
            // Persist the split width so a re-render (e.g. switching tabs and
            // back) rebuilds the split where the user left it, not at 50/50.
            if (file) file._htmlSplitPos = left.getBoundingClientRect().width;
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
    });
}
