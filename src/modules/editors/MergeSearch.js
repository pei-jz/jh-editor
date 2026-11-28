/**
 * MergeSearch.js — Find (Ctrl+F) inside a comparison, one side at a time.
 *
 * The app's search panel talks to the active view through the "CodeMirror
 * mode" protocol (isCodeMirrorMode / performSearch / scrollToMatch / …, see
 * ui/Search.js). A comparison has two editors, and a hit list holds offsets
 * into one document, so a search runs over the side the cursor was last on:
 * left when the cursor is on the left, right when it is on the right. Clicking
 * the other side and searching again moves the search there.
 *
 * Hits inside a folded run of unchanged lines unfold that run (on both sides,
 * so the panes stay lined up) when they are landed on.
 */
import { StateEffect, StateField } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import { SearchQuery } from '@codemirror/search';
import { uncollapseUnchanged } from '@codemirror/merge';
import { State } from '../core/Store.js';
import { searchMatchLimit, firstMatchAtOrAfter } from '../utils/SearchRanges.js';
import { expandReplacement } from '../utils/TextSearchCore.js';

const setSearchMarks = StateEffect.define();

const hitMark = Decoration.mark({ class: 'cm-searchMatch' });
const currentMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

/** Hits as marks on one side; follows edits until the next search repaints it. */
export const searchMarkField = StateField.define({
    create() { return Decoration.none; },
    update(deco, tr) {
        for (const e of tr.effects) {
            if (e.is(setSearchMarks)) {
                const { matches, index } = e.value;
                const len = tr.state.doc.length;
                const ranges = [];
                matches.forEach((m, i) => {
                    if (m.start == null || m.end <= m.start || m.end > len) return;
                    ranges.push((i === index ? currentMark : hitMark).range(m.start, m.end));
                });
                return Decoration.set(ranges, true);
            }
        }
        return tr.docChanged ? deco.map(tr.changes) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
});

export const searchMarkTheme = EditorView.theme({
    '.cm-searchMatch': { backgroundColor: 'rgba(255, 214, 0, 0.42)', borderRadius: '2px' },
    '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'color-mix(in srgb, var(--accent-spark, #ff9800) 45%, #fff)',
        outline: '2px solid var(--accent-spark, #ff6d00)',
        outlineOffset: '-1px',
    },
});

function buildQuery(query, isRegex, isCaseSensitive, isWord, replaceWith) {
    return new SearchQuery({
        search: query,
        caseSensitive: isCaseSensitive,
        regexp: isRegex,
        wholeWord: isWord,
        literal: !isRegex,
        ...(replaceWith != null ? { replace: replaceWith } : {}),
    });
}

/**
 * The search half of a MergeEditor. `host` is the editor; it supplies
 * `_activeEditor()`, `_sideOf(view)`, `_unfoldAt(view, pos)` and
 * `_onSearchTargetChanged()`.
 */
export class MergeSearch {
    constructor(host) {
        this.host = host;
        this.target = null;         // the EditorView the hits belong to
        this.token = 0;
        this.lastSearchTruncated = 0;
    }

    /** The side being searched, or the one a new search would use. */
    get editorView() {
        return this.target || this.host._activeEditor();
    }

    _clear(view) {
        if (view && view.state.field(searchMarkField, false) !== undefined) {
            view.dispatch({ effects: setSearchMarks.of({ matches: [], index: -1 }) });
        }
    }

    _retarget(view) {
        if (this.target && this.target !== view) this._clear(this.target);
        const changed = this.target !== view;
        this.target = view;
        if (changed) this.host._onSearchTargetChanged();
    }

    async performSearch(query, isRegex, isCaseSensitive, isWord, onProgress) {
        const view = this.host._activeEditor();
        if (!view) return false;
        const token = ++this.token;
        this._retarget(view);
        this.lastSearchTruncated = 0;
        const sq = buildQuery(query, isRegex, isCaseSensitive, isWord);
        if (!sq.valid) {
            State.searchMatches = [];
            this.renderSearchHighlights([], 0);
            return true;
        }
        const limit = searchMatchLimit(query);
        const doc = view.state.doc;
        const matches = [];
        const cursor = sq.getCursor(view.state);
        let m;
        while (!(m = cursor.next()).done) {
            matches.push({ start: m.value.from, end: m.value.to, isCodeMirror: true });
            if (matches.length >= limit) { this.lastSearchTruncated = limit; break; }
            if (matches.length % 2000 === 0) {
                if (onProgress) onProgress(matches.length, doc.length ? m.value.to / doc.length : 1);
                await new Promise((r) => setTimeout(r, 0));
                if (token !== this.token || this.target !== view) return false;
            }
        }
        State.searchMatches = matches;
        State.currentMatchIndex = 0;
        this.renderSearchHighlights(matches, 0);
        return true;
    }

    cancelSearch() {
        this.token++;
        return false;
    }

    renderSearchHighlights(matches, index) {
        const view = this.target;
        if (!view) return;
        // Cleanup (an empty list) also ends "this side is being searched".
        view.dispatch({ effects: setSearchMarks.of({ matches: matches || [], index }) });
        if (!matches || !matches.length) {
            this.target = null;
            this.host._onSearchTargetChanged();
        }
    }

    scrollToMatch(index) {
        const view = this.target;
        const match = State.searchMatches[index];
        if (!view || !match) return;
        this.host._unfoldAt(view, match.start);
        view.dispatch({
            selection: { anchor: match.start, head: match.end },
            effects: EditorView.scrollIntoView(match.start, { y: 'center' }),
            userEvent: 'select.search',
        });
        this.renderSearchHighlights(State.searchMatches, index);
    }

    getSelectionOffsets() {
        const view = this.editorView;
        if (!view) return null;
        const s = view.state.selection.main;
        return { from: s.from, to: s.to };
    }

    _writable(view) {
        const side = this.host._sideOf(view);
        return !!(side && side.writable);
    }

    replaceNext(query, replaceWith, isRegex, isCaseSensitive, isWord, target = null) {
        const view = this.target;
        if (!view || !this._writable(view)) {
            this.host._notifyReadOnlySearch();
            return -1;
        }
        const sq = buildQuery(query, isRegex, isCaseSensitive, isWord, replaceWith || '');
        if (!sq.valid) return -1;
        const state = view.state;
        const matches = State.searchMatches || [];
        const hitAt = (from, to) => {
            const r = sq.getCursor(state, from, to).next();
            return !r.done && r.value.from === from && r.value.to === to ? r.value : null;
        };
        let match = target && target.start != null ? hitAt(target.start, target.end) : null;
        if (!match) {
            let r = sq.getCursor(state, state.selection.main.from).next();
            if (r.done) r = sq.getCursor(state, 0).next();
            if (r.done) return -1;
            match = r.value;
        }
        const insert = expandReplacement(replaceWith, match.match, isRegex);
        const before = state.doc.length;
        view.dispatch({
            changes: { from: match.from, to: match.to, insert },
            selection: { anchor: match.from + insert.length },
            scrollIntoView: true,
            userEvent: 'input.replace',
        });
        const delta = view.state.doc.length - before;
        const index = firstMatchAtOrAfter(matches, match.from);
        if (index !== -1 && matches[index].start === match.from) {
            matches.splice(index, 1);
            for (let i = index; i < matches.length; i++) {
                matches[i].start += delta;
                matches[i].end += delta;
            }
        }
        if (matches.length) this.renderSearchHighlights(matches, Math.min(Math.max(index, 0), matches.length - 1));
        else this.renderSearchHighlights([], 0);
        return index;
    }

    async replaceAll(query, replaceWith, isRegex, isCaseSensitive, isWord) {
        const view = this.host._activeEditor();
        if (!view) return 0;
        if (!this._writable(view)) {
            this.host._notifyReadOnlySearch();
            return 0;
        }
        this._retarget(view);
        const sq = buildQuery(query, isRegex, isCaseSensitive, isWord, replaceWith || '');
        if (!sq.valid) return 0;
        const changes = [];
        const cursor = sq.getCursor(view.state);
        let r;
        while (!(r = cursor.next()).done) {
            changes.push({ from: r.value.from, to: r.value.to, insert: expandReplacement(replaceWith, r.value.match, isRegex) });
        }
        if (changes.length) view.dispatch({ changes, userEvent: 'input.replace' });
        return changes.length;
    }

    /** The comparison was redrawn: its editors (and their marks) are new. */
    reset() {
        this.token++;
        this.target = null;
    }
}
