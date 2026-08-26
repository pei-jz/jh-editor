import { EL } from '../core/Constants.js';
import { State } from '../core/Store.js';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { shortcuts } from '../core/ShortcutManager.js';
import { ContextMenu } from './ContextMenu.js';
import { Toast } from './Toast.js';
import { getCurrentView } from '../core/Editor.js';

// Read an option's state from the BUTTON the user actually sees (its `.active`
// class), so "display" and "behavior" can never disagree. The hidden checkboxes
// are kept in sync but are no longer the source of truth for reads.
const _optOn = (btnId) => !!document.getElementById(btnId)?.classList.contains('active');
const isRegexOn = () => _optOn('regex-toggle-btn');
const isCaseOn = () => _optOn('case-toggle-btn');
const isWordOn = () => _optOn('word-toggle-btn');

// ─── Modal open / close ───────────────────────────────────────────────────────

function isModalOpen() {
    return EL.searchPanel.style.display !== 'none';
}

function openSearchModal(replaceMode = false) {
    const replaceRow = document.getElementById('search-replace-row');
    const mb = document.getElementById('replace-mode-toggle-btn');

    if (replaceMode && replaceRow && replaceRow.style.display === 'none') {
        replaceRow.style.display = 'flex';
        mb?.classList.add('active');
    }

    EL.searchPanel.style.display = 'flex';

    // Pre-fill with selected text
    const active = document.activeElement;
    let textToSearch = '';
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !active.classList.contains('plain-text-editor')) {
        textToSearch = active.value.substring(active.selectionStart, active.selectionEnd);
    } else {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && EL.editorContent && EL.editorContent.contains(sel.anchorNode)) {
            textToSearch = sel.toString();
        } else if (active && active.classList.contains('plain-text-editor')) {
            textToSearch = active.value.substring(active.selectionStart, active.selectionEnd);
        }
    }

    if (textToSearch && !textToSearch.includes('\n')) {
        EL.findInput.value = textToSearch;
        _performSearch(true);
    }

    if (replaceMode && replaceRow && replaceRow.style.display !== 'none') {
        EL.replaceInput.focus();
    } else {
        EL.findInput.focus();
        EL.findInput.select();
    }
}

function closeSearchModal() {
    EL.searchPanel.style.display = 'none';
    // The panel was focused, so scope is stuck on 'SEARCH'. Hiding it does not
    // fire a focusin elsewhere, so reset scope to GLOBAL — otherwise global
    // shortcuts (Ctrl+K / Shift+Ctrl+K / F3 find-next/prev) get swallowed.
    try { shortcuts.setScope('GLOBAL'); } catch (e) { /* ignore */ }
    // Show status bar if search is still active
    if (State.searchMatches.length > 0) {
        _showStatusBar();
    }
}

function toggleSearch() {
    if (isModalOpen()) {
        closeSearchModal();
    } else {
        openSearchModal(false);
    }
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function _showStatusBar() {
    if (!EL.searchStatusBar) return;
    const q = EL.findInput.value;
    if (EL.searchStatusQuery) {
        EL.searchStatusQuery.textContent = `"${q.length > 40 ? q.slice(0, 40) + '…' : q}"`;
    }
    _updateStatusBarCount();
    EL.searchStatusBar.style.display = 'flex';
}

function _hideStatusBar() {
    if (EL.searchStatusBar) EL.searchStatusBar.style.display = 'none';
}

// Show a live "Searching… N hits" indicator while an async search runs.
function _setSearchingStatus(n) {
    const label = n > 0 ? `Searching… ${n.toLocaleString()} hits` : 'Searching…';
    const countEl = document.getElementById('search-match-count');
    if (countEl) countEl.textContent = label;
    if (EL.searchStatusBar) EL.searchStatusBar.style.display = 'flex';
    if (EL.searchStatusQuery) {
        const q = EL.findInput.value;
        EL.searchStatusQuery.textContent = `"${q.length > 40 ? q.slice(0, 40) + '…' : q}"`;
    }
    if (EL.searchStatusCount) EL.searchStatusCount.textContent = label;
}

function _updateStatusBarCount() {
    if (!EL.searchStatusCount) return;
    if (State.searchMatches.length === 0) {
        EL.searchStatusCount.textContent = '0 / 0';
    } else {
        EL.searchStatusCount.textContent = `${State.currentMatchIndex + 1} / ${State.searchMatches.length}`;
    }
}

// ─── Match count (modal badge) ────────────────────────────────────────────────

const _updateMatchCount = () => {
    const countEl = document.getElementById('search-match-count');
    if (countEl) {
        if (State.searchMatches.length === 0) {
            countEl.textContent = EL.findInput.value ? '0 hits' : '';
        } else {
            countEl.textContent = `${State.currentMatchIndex + 1} / ${State.searchMatches.length}`;
        }
    }
    _updateStatusBarCount();
};

// ─── Editor helpers ───────────────────────────────────────────────────────────

const _getActiveEditorDetails = () => {
    const currentView = getCurrentView();
    let textarea = null;
    let highlights = null;

    if (currentView) {
        if (currentView.container) {
            const activeTextarea = currentView.container.querySelector('textarea.block-editor');
            if (activeTextarea && activeTextarea.offsetParent !== null) {
                return { textarea: activeTextarea, highlights: null };
            }
        }
        if (currentView.textarea) {
            textarea = currentView.textarea;
            highlights = currentView.layers ? currentView.layers.highlights : null;
        } else if (currentView.sourceTextarea) {
            textarea = currentView.sourceTextarea;
            highlights = currentView.container.querySelector('.node-source-highlights');
        }
    }

    if (!textarea && currentView && currentView.container) {
        textarea = currentView.container.querySelector('.plain-text-editor, .node-source-editor');
        highlights = currentView.container.querySelector('.plain-text-highlights, .node-source-highlights');
    }

    return { textarea, highlights, currentView };
};

// ─── Cleanup ──────────────────────────────────────────────────────────────────

const _restoreMap = new Map();

const _cleanupSearch = () => {
    State.searchMatches = [];
    State.currentMatchIndex = 0;
    const currentView = getCurrentView();
    if (currentView && currentView.renderSearchHighlights) {
        currentView.renderSearchHighlights([], 0);
    }
    // Only restore blocks that are still attached to the live DOM. After a
    // tab switch or view re-render, the original elements are detached (or, in
    // pooled views, recycled to hold a *different* file's content) — writing the
    // saved innerHTML back into them would leak one file's content into another.
    _restoreMap.forEach((html, block) => {
        if (block && block.isConnected) block.innerHTML = html;
    });
    _restoreMap.clear();
    document.querySelectorAll('.plain-text-editor, .source-layer-edit, .node-source-editor').forEach(el => {
        el.classList.remove('searching-active');
    });
    _updateMatchCount();
    _hideStatusBar();
};

window.cleanupSearch = _cleanupSearch;

/**
 * Fully dismiss the search: drop the highlights AND the query itself.
 *
 * _cleanupSearch() alone only clears the matches/highlights — it deliberately
 * keeps the term because _performSearch() calls it on every run. Escape,
 * however, means "I'm done searching", so the term must go too; otherwise
 * find-next (Ctrl+K / F3) sees a non-empty box and silently re-runs the search
 * the user just dismissed.
 */
const _clearSearchState = () => {
    _cleanupSearch();
    if (EL.findInput) EL.findInput.value = '';
    // Also forget the word auto-promoted from an editor selection, so the next
    // selection can populate the box again (see CodeMirrorView._searchSelectedWord).
    State._autoSearchTerm = null;
};

window.clearSearch = _clearSearchState;

// ─── Core search logic ────────────────────────────────────────────────────────

/**
 * @param {boolean} noFocus      don't steal focus from the editor
 * @param {boolean} keepPosition don't jump to the first hit — keep the caret /
 *        viewport where they are and just paint the highlights. Used when the
 *        search was triggered implicitly (selecting a word), where yanking the
 *        view back to hit #1 would be jarring.
 */
const _performSearch = (noFocus = false, keepPosition = false) => {
    if (State.activeTabIndex < 0) return;
    _cleanupSearch();

    // Finish a search run: either navigate to a match (normal) or stay put and
    // just refresh the highlights (keepPosition).
    const _settle = () => {
        if (!keepPosition) { _scrollToMatch(noFocus); return; }
        const view = getCurrentView();
        // Point "current match" at the occurrence under the cursor so a
        // subsequent Ctrl+K continues from here rather than from the top.
        try {
            const sel = view && typeof view.getSelectionOffsets === 'function'
                ? view.getSelectionOffsets() : null;
            if (sel) {
                const idx = State.searchMatches.findIndex(m => m.start != null && m.start >= sel.from);
                State.currentMatchIndex = idx === -1 ? 0 : idx;
            }
        } catch (_) { /* ignore */ }
        if (view && view.renderSearchHighlights) {
            view.renderSearchHighlights(State.searchMatches, State.currentMatchIndex);
        }
        _updateMatchCount();
    };

    const query = EL.findInput.value;
    if (!query) return;

    document.querySelectorAll('.plain-text-editor, .source-layer-edit, .node-source-editor').forEach(el => {
        el.classList.add('searching-active');
    });

    const isRegex = isRegexOn();
    const isCaseSensitive = isCaseOn();
    const isWord = isWordOn();
    const flags = isCaseSensitive ? 'g' : 'gi';

    // ── Book mode (PlainTextView) ────────────────────────────────────────────
    // No textarea exists; content is rendered as .pt-book-line divs across flip
    // pages. Treat each line like a markdown block: wrap matches in <mark> and
    // flip to the matched line's page on navigation.
    const _bookView = getCurrentView();
    if (_bookView && typeof _bookView.isBookMode === 'function' && _bookView.isBookMode()) {
        let bregex;
        try {
            const pattern = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            bregex = new RegExp(`(${isWord ? '\\b' + pattern + '\\b' : pattern})(?![^<]+>)`, flags);
            EL.findInput.style.borderColor = '';
            EL.findInput.title = '';
        } catch (e) {
            EL.findInput.style.borderColor = 'red';
            EL.findInput.title = 'Invalid Regular Expression';
            _updateMatchCount();
            return;
        }

        const lineEls = _bookView.container.querySelectorAll('.pt-book-line');
        lineEls.forEach((lineEl) => {
            if (bregex.test(lineEl.textContent)) {
                if (!_restoreMap.has(lineEl)) _restoreMap.set(lineEl, lineEl.innerHTML);
                const newHTML = lineEl.innerHTML.replace(bregex, '<mark>$1</mark>');
                if (newHTML !== lineEl.innerHTML) {
                    lineEl.innerHTML = newHTML;
                    const lineIndex = parseInt(lineEl.getAttribute('data-line-index'), 10);
                    State.searchMatches.push({ block: lineEl, lineIndex, isPlainText: false, isBook: true });
                }
            }
            bregex.lastIndex = 0;
        });

        if (State.searchMatches.length > 0) {
            State.currentMatchIndex = 0;
            _settle();
        }
        _updateMatchCount();
        return;
    }

    // ── CSV grid mode ────────────────────────────────────────────────────────
    // The CSV grid has no textarea; scan the model and select matching cells.
    const _csvView = getCurrentView();
    if (_csvView && typeof _csvView.isCsvGridMode === 'function' && _csvView.isCsvGridMode()) {
        let regex;
        try {
            if (!isRegex) {
                const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(isWord ? `\\b${escaped}\\b` : escaped, flags);
            } else {
                regex = new RegExp(query, flags);
            }
            EL.findInput.style.borderColor = '';
            EL.findInput.title = '';
        } catch (e) {
            EL.findInput.style.borderColor = 'red';
            EL.findInput.title = 'Invalid Regular Expression';
            _updateMatchCount();
            return;
        }

        const test = (s) => { regex.lastIndex = 0; return regex.test(s); };
        const matches = _csvView.collectCsvMatches(test);
        matches.forEach(mm => State.searchMatches.push({ r: mm.r, c: mm.c, isCsv: true }));

        if (State.searchMatches.length > 0) {
            State.currentMatchIndex = 0;
            _settle();
        }
        _updateMatchCount();
        return;
    }

    // ── CodeMirror mode (async, chunked so large files don't freeze) ──────────
    const _cmView = getCurrentView();
    if (_cmView && typeof _cmView.isCodeMirrorMode === 'function' && _cmView.isCodeMirrorMode()) {
        _setSearchingStatus(0);
        _cmView.performSearch(query, isRegex, isCaseSensitive, isWord, (n) => _setSearchingStatus(n))
            .then(() => {
                if (State.searchMatches.length > 0) {
                    State.currentMatchIndex = 0;
                    _settle();
                }
                _updateMatchCount();
                if (!isModalOpen() && State.searchMatches.length > 0) _showStatusBar();
                else if (State.searchMatches.length === 0) _hideStatusBar();
            })
            .catch(() => {});
        return;
    }

    const { textarea, highlights } = _getActiveEditorDetails();

    // Plain-text mode
    if (textarea && highlights) {
        const content = textarea.value;
        let regex;
        try {
            if (!isRegex) {
                const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(isWord ? `\\b${escaped}\\b` : escaped, flags);
            } else {
                regex = new RegExp(query, flags);
            }
            EL.findInput.style.borderColor = '';
            EL.findInput.title = '';
        } catch (e) {
            EL.findInput.style.borderColor = 'red';
            EL.findInput.title = 'Invalid Regular Expression';
            _updateMatchCount();
            return;
        }

        let match;
        const MAX_MATCHES = 10000;
        let limitReached = false;
        while ((match = regex.exec(content)) !== null) {
            State.searchMatches.push({ start: match.index, end: regex.lastIndex, text: match[0], isPlainText: true });
            if (match[0].length === 0) regex.lastIndex++;
            if (State.searchMatches.length >= MAX_MATCHES) {
                limitReached = true;
                break;
            }
        }

        const currentView = getCurrentView();
        if (currentView && currentView.renderSearchHighlights) {
            currentView.renderSearchHighlights(State.searchMatches, State.currentMatchIndex);
        }
        if (State.searchMatches.length > 0) {
            State.currentMatchIndex = 0;
            _settle();
        }
        _updateMatchCount();
        if (limitReached) {
            _showToast(`Too many matches — showing the first ${MAX_MATCHES}.`);
        }
        return;
    }

    // Markdown block mode
    let regex;
    try {
        const pattern = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(`(${isWord ? '\\b' + pattern + '\\b' : pattern})(?![^<]+>)`, flags);
        EL.findInput.style.borderColor = '';
        EL.findInput.title = '';
    } catch (e) {
        EL.findInput.style.borderColor = 'red';
        EL.findInput.title = 'Invalid Regular Expression';
        _updateMatchCount();
        return;
    }

    const currentView = getCurrentView();
    const targetContainer = (currentView && currentView.container) ? currentView.container : document;
    const blocks = targetContainer.querySelectorAll('.md-block:not(.phantom)');

    blocks.forEach((block, idx) => {
        if (regex.test(block.textContent)) {
            if (!_restoreMap.has(block)) _restoreMap.set(block, block.innerHTML);
            const newHTML = block.innerHTML.replace(regex, '<mark>$1</mark>');
            if (newHTML !== block.innerHTML) {
                block.innerHTML = newHTML;
                State.searchMatches.push({ blockIndex: idx, block, isPlainText: false });
            }
        }
        regex.lastIndex = 0;
    });

    if (State.searchMatches.length > 0) {
        State.currentMatchIndex = 0;
        _settle();
    }
    _updateMatchCount();
};

window.performSearchInternal = _performSearch;

// Re-apply the active search highlights after a view re-renders its DOM (e.g.
// book-mode ResizeObserver rebuilds the .pt-book-line / .md-block elements from
// source HTML, which does not contain the injected <mark> tags). Without this,
// search highlights silently vanish whenever the book layout is recomputed.
// Preserves the current match index where possible.
window.reapplyActiveSearch = () => {
    if (!EL.findInput || !EL.findInput.value) return;
    if (State.searchMatches.length === 0) return;
    const prevIndex = State.currentMatchIndex;
    // _performSearch rebuilds searchMatches and resets currentMatchIndex to 0.
    _performSearch(true);
    if (prevIndex > 0 && prevIndex < State.searchMatches.length) {
        State.currentMatchIndex = prevIndex;
        _scrollToMatch(true);
        _updateMatchCount();
    }
};

window.setSearchMatchIndexByOffset = (offset) => {
    if (State.searchMatches.length === 0) return;
    const index = State.searchMatches.findIndex(m => m.start === offset);
    if (index !== -1) {
        State.currentMatchIndex = index;
        const currentView = getCurrentView();
        if (currentView && currentView.renderSearchHighlights) {
            currentView.renderSearchHighlights(State.searchMatches, State.currentMatchIndex);
        }
        _updateMatchCount();
    }
};

// ─── Navigation ───────────────────────────────────────────────────────────────

// Current selection range of the active editor view (CM6), or null.
function _viewSelectionOffsets() {
    const view = getCurrentView();
    if (view && typeof view.getSelectionOffsets === 'function' && State.searchMatches[0] && State.searchMatches[0].start != null) {
        return view.getSelectionOffsets();
    }
    return null;
}

function findNext() {
    if (State.searchMatches.length === 0) {
        if (EL.findInput.value) _performSearch();
    } else {
        // First hit at/after the END of the current selection, so moving the
        // cursor then find-next continues from where you are.
        const sel = _viewSelectionOffsets();
        let next;
        if (sel != null) {
            next = State.searchMatches.findIndex(m => m.start >= sel.to);
            if (next === -1) { _showToast('Wrapped to the top'); next = 0; }
        } else {
            next = State.currentMatchIndex + 1;
            if (next >= State.searchMatches.length) { _showToast('Wrapped to the top'); next = 0; }
        }
        State.currentMatchIndex = next;
        _scrollToMatch();
        _updateMatchCount();
    }
}

function findPrev() {
    if (State.searchMatches.length === 0) {
        if (EL.findInput.value) _performSearch();
    } else {
        // Last hit that starts BEFORE the current selection start (so the current
        // match isn't re-selected).
        const sel = _viewSelectionOffsets();
        let prev;
        if (sel != null) {
            prev = -1;
            for (let i = 0; i < State.searchMatches.length; i++) {
                if (State.searchMatches[i].start < sel.from) prev = i; else break;
            }
            if (prev === -1) { _showToast('Wrapped to the bottom'); prev = State.searchMatches.length - 1; }
        } else {
            prev = State.currentMatchIndex - 1;
            if (prev < 0) { _showToast('Wrapped to the bottom'); prev = State.searchMatches.length - 1; }
        }
        State.currentMatchIndex = prev;
        _scrollToMatch();
        _updateMatchCount();
    }
}

// Replace the current match and advance — usable while the modal is closed via a
// global shortcut (mirrors how Find-Next works after the search modal closes).
function replaceNext() {
    if (State.searchMatches.length === 0) {
        if (EL.findInput.value) _performSearch(true);
        return;
    }
    _doReplace();
}

function _scrollToMatch(noFocus = false) {
    const m = State.searchMatches[State.currentMatchIndex];
    if (!m) return;
    const currentView = getCurrentView();
    if (m.isCsv) {
        if (currentView && typeof currentView.gotoCsvMatch === 'function') currentView.gotoCsvMatch(m);
        return;
    }
    if (currentView && currentView.renderSearchHighlights) {
        currentView.renderSearchHighlights(State.searchMatches, State.currentMatchIndex);
    }
    if (m.isBook) {
        // Mark the active occurrence distinctly across all book lines
        document.querySelectorAll('.pt-book-line mark.search-active').forEach(el => el.classList.remove('search-active'));
        if (m.block) m.block.querySelectorAll('mark').forEach(mk => mk.classList.add('search-active'));
        // Flip to the page containing this line
        if (currentView && typeof currentView.jumpToLine === 'function') {
            currentView.jumpToLine(m.lineIndex);
        }
        return;
    }
    if (m.isCodeMirror) {
        const currentView = getCurrentView();
        if (currentView && typeof currentView.scrollToMatch === 'function') {
            currentView.scrollToMatch(State.currentMatchIndex);
            if (!noFocus && currentView.editorView) {
                currentView.editorView.focus();
            }
        }
        return;
    }
    if (m.isPlainText) {
        const { textarea } = _getActiveEditorDetails();
        if (textarea) {
            // Place a collapsed caret (not a range) at the match so the active
            // highlight always comes from the search overlay layer — selecting the
            // range would paint the native textarea selection on top, making the
            // first hit (overlay only) and find-next/prev (overlay + selection)
            // look different.
            if (!noFocus) { textarea.focus(); textarea.setSelectionRange(m.start, m.start); }
            const lines = textarea.value.substring(0, m.start).split('\n').length;
            const lineHeight = 21;
            textarea.scrollTop = ((lines - 1) * lineHeight) - (textarea.clientHeight / 2);
        }
    } else {
        m.block.scrollIntoView({ behavior: 'smooth', block: 'center' });
        m.block.style.border = '2px solid orange';
        setTimeout(() => { m.block.style.border = '1px solid transparent'; }, 1000);
    }
}

// ─── Toast ────────────────────────────────────────────────────────────────────

/**
 * Search's own notifications.
 *
 * This used to be a private box with its own colours and a 2-second life — two
 * notification systems in one app, and the shorter one carried the messages
 * with numbers in them. It delegates now, so there is one look and one timing
 * policy.
 */
function _showToast(message, type = 'info') {
    Toast.show(message, type);
}

// ─── Replace logic ────────────────────────────────────────────────────────────

// After a single replace, rebuild the match list and land on the *next*
// remaining occurrence (the one that took the replaced match's place), so the
// user can keep firing the replace shortcut to walk through every hit.
function _advanceAfterReplace(prevIndex) {
    setTimeout(() => {
        _performSearch(true);
        if (State.searchMatches.length > 0) {
            State.currentMatchIndex = Math.min(prevIndex, State.searchMatches.length - 1);
            _scrollToMatch(true);
            _updateMatchCount();
        }
    }, 50);
}

function _doReplace() {
    if (State.searchMatches.length === 0 || State.activeTabIndex < 0) return;
    const match = State.searchMatches[State.currentMatchIndex];
    if (!match) return;
    const prevIndex = State.currentMatchIndex;

    const currentView = getCurrentView();
    if (currentView && typeof currentView.isCodeMirrorMode === 'function' && currentView.isCodeMirrorMode()) {
        const r = EL.replaceInput.value;
        const isRegex = isRegexOn();
        const isCaseSensitive = isCaseOn();
        const isWord = isWordOn();
        currentView.replaceNext(EL.findInput.value, r, isRegex, isCaseSensitive, isWord);
        _advanceAfterReplace(prevIndex);
        return;
    }

    if (match.isPlainText) {
        const { textarea } = _getActiveEditorDetails();
        if (!textarea) return;
        const r = EL.replaceInput.value;
        let replacement = r;
        if (isRegexOn()) {
            const finalR = r.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
            const flags = isCaseOn() ? '' : 'i';
            replacement = match.text.replace(new RegExp(EL.findInput.value, flags), finalR);
        }
        if (window.editorSaveHistory) window.editorSaveHistory();
        textarea.value = textarea.value.substring(0, match.start) + replacement + textarea.value.substring(match.end);
        const currentView = getCurrentView();
        if (currentView && typeof currentView.applyChanges === 'function') {
            currentView.applyChanges(textarea.value);
        } else {
            State.openFiles[State.activeTabIndex].content = textarea.value;
            State.openFiles[State.activeTabIndex].isDirty = true;
        }
        if (window.editorSaveHistory) window.editorSaveHistory();
        textarea.dispatchEvent(new Event('input'));
        _advanceAfterReplace(prevIndex);
        return;
    }

    // Markdown block replace
    const originalText = State.openFiles[State.activeTabIndex].content;
    const blocks = originalText.split(/\n\s*\n/);
    if (match.blockIndex >= blocks.length) return;
    const q = EL.findInput.value;
    const r = EL.replaceInput.value;
    const isRegex = isRegexOn();
    const flags = isCaseOn() ? '' : 'i';
    let regex = isRegex ? new RegExp(q, flags) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const finalR = isRegex ? r.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t') : r;
    blocks[match.blockIndex] = blocks[match.blockIndex].replace(regex, finalR);
    if (window.editorSaveHistory) window.editorSaveHistory();
    State.openFiles[State.activeTabIndex].content = blocks.join('\n\n');
    State.openFiles[State.activeTabIndex].isDirty = true;
    const textarea = document.querySelector('.plain-text-editor');
    if (textarea) { textarea.value = State.openFiles[State.activeTabIndex].content; textarea.dispatchEvent(new Event('input')); }
    _advanceAfterReplace(prevIndex);
}

/**
 * What the toast says after Replace All.
 *
 * Zero gets its own sentence: "Replaced 0" reads like something went wrong,
 * when the honest meaning is that nothing matched.
 */
export function _replacedMessage(count, query) {
    const q = String(query || '');
    const shown = q.length > 30 ? `${q.slice(0, 30)}…` : q;
    if (!count) return `No matches for "${shown}" — nothing replaced.`;
    return `Replaced ${count} ${count === 1 ? 'occurrence' : 'occurrences'} of "${shown}".`;
}

function _doReplaceAll() {
    if (State.activeTabIndex < 0) return;
    let content = State.openFiles[State.activeTabIndex].content;
    const q = EL.findInput.value;
    const r = EL.replaceInput.value;
    const isRegex = isRegexOn();
    const isCase = isCaseOn();
    const isWord = isWordOn();
    const flags = isCase ? 'g' : 'gi';

    const currentView = getCurrentView();
    if (currentView && typeof currentView.isCodeMirrorMode === 'function' && currentView.isCodeMirrorMode()) {
        const n = currentView.replaceAll(q, r, isRegex, isCase, isWord) || 0;
        setTimeout(_performSearch, 50);
        _showToast(_replacedMessage(n, q));
        return;
    }

    let regex;
    if (!isRegex) {
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(isWord ? `\\b${escaped}\\b` : escaped, flags);
    } else {
        regex = new RegExp(q, flags);
    }
    const finalR = isRegex ? r.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t') : r;
    if (window.editorSaveHistory) window.editorSaveHistory();
    // Count before replacing: `String.replace` does not report how many it hit,
    // and comparing before/after only answers "did anything change".
    const replaced = (content.match(regex) || []).length;
    const newContent = content.replace(regex, finalR);
    if (newContent !== content) {
        State.openFiles[State.activeTabIndex].content = newContent;
        State.openFiles[State.activeTabIndex].isDirty = true;
        const { textarea } = _getActiveEditorDetails();
        const currentView = getCurrentView();
        if (currentView && typeof currentView.render === 'function') {
            if (currentView.currentType) {
                currentView.render(newContent, State.openFiles[State.activeTabIndex], currentView.currentType);
            } else {
                currentView.render(newContent, State.openFiles[State.activeTabIndex]);
            }
        } else if (textarea) {
            textarea.value = newContent;
            textarea.dispatchEvent(new Event('input'));
        }
        if (window.editorSaveHistory) window.editorSaveHistory();
        setTimeout(_performSearch, 50);
        _showToast(_replacedMessage(replaced, q));
    } else {
        _showToast(_replacedMessage(0, q));
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function initSearch() {
    // ── Option button sync ──────────────────────────────────────────────────
    const _syncBtnStates = () => {
        document.getElementById('regex-toggle-btn')?.classList.toggle('active', EL.regexToggle.checked);
        document.getElementById('case-toggle-btn')?.classList.toggle('active', EL.caseToggle.checked);
        document.getElementById('word-toggle-btn')?.classList.toggle('active', document.getElementById('word-toggle')?.checked ?? false);
    };

    EL.regexToggle.addEventListener('change', _syncBtnStates);
    EL.caseToggle.addEventListener('change', _syncBtnStates);
    document.getElementById('word-toggle')?.addEventListener('change', _syncBtnStates);

    // Deterministic initial state. Browsers can restore hidden-checkbox `checked`
    // across reloads (incl. dev HMR); without this the button visuals wouldn't
    // reflect it, so the toggle looked ON while behaving OFF (or vice versa).
    EL.regexToggle.checked = false;
    EL.caseToggle.checked = false;
    const _wt0 = document.getElementById('word-toggle');
    if (_wt0) _wt0.checked = false;
    _syncBtnStates();

    // ── Option buttons ──────────────────────────────────────────────────────
    document.getElementById('regex-toggle-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        EL.regexToggle.checked = !EL.regexToggle.checked;
        EL.regexToggle.dispatchEvent(new Event('change'));
        _performSearch(true);
    });
    document.getElementById('case-toggle-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        EL.caseToggle.checked = !EL.caseToggle.checked;
        EL.caseToggle.dispatchEvent(new Event('change'));
        _performSearch(true);
    });
    document.getElementById('word-toggle-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        const wt = document.getElementById('word-toggle');
        if (wt) { wt.checked = !wt.checked; wt.dispatchEvent(new Event('change')); }
        _performSearch(true);
    });

    // ── Close button ────────────────────────────────────────────────────────
    EL.closeSearchBtn?.addEventListener('click', () => {
        closeSearchModal();
    });

    // ── Toolbar launch button ────────────────────────────────────────────────
    EL.searchLaunchBtn?.addEventListener('click', toggleSearch);

    // ── Overlay click to close ──────────────────────────────────────────────
    EL.searchPanel.addEventListener('click', (e) => {
        if (e.target === EL.searchPanel) closeSearchModal();
    });

    // ── Live search on typing ────────────────────────────────────────────────
    // Above this size, don't search on every keystroke (it makes typing lag) —
    // the user searches explicitly with Enter instead.
    const LIVE_SEARCH_MAX = 200 * 1024;
    const _isLargeFile = () => {
        const f = State.openFiles[State.activeTabIndex];
        return !!(f && typeof f.content === 'string' && f.content.length > LIVE_SEARCH_MAX);
    };
    let _debounce;
    EL.findInput.addEventListener('input', () => {
        clearTimeout(_debounce);
        if (_isLargeFile()) {
            // Large file: skip live search; hint that Enter runs it.
            const countEl = document.getElementById('search-match-count');
            if (countEl) countEl.textContent = EL.findInput.value ? 'Press Enter to search' : '';
            return;
        }
        _debounce = setTimeout(() => {
            if (isModalOpen()) _performSearch(true);
        }, 300);
    });

    // The CodeMirror search path is now async + chunked (see performSearch), so
    // it doesn't block and reports progress itself — just run it.
    const _runSearch = (noFocus) => { _performSearch(noFocus); };

    // ── Regex template picker (button click + Alt+T shortcut) ────────────────
    // Focus on hard-to-remember / easy-to-forget patterns. Grouped by category.
    const _regexPresets = [
        { group: 'Common' },
        { label: 'Email address',              pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.]+' },
        { label: 'URL (http/https)',            pattern: 'https?://[^\\s"\'<>]+' },
        { label: 'IPv4 address (bounded)',      pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b' },
        { label: 'Japanese only (kana / kanji)',  pattern: '[ぁ-んァ-ヶ一-龠々]+' },
        { label: 'All full-width characters',               pattern: '[^\\x00-\\x7F]+' },
        { label: 'TODO / FIXME / HACK',          pattern: '(?:TODO|FIXME|HACK|XXX|NOTE)' },

        { group: 'Lookahead / lookbehind (easy to forget)' },
        { label: 'Positive lookahead: just before foo',         pattern: 'foo(?=bar)' },
        { label: 'Negative lookahead: lines without foo',   pattern: '^(?!.*foo).*$' },
        { label: 'Positive lookbehind: amount digits',        pattern: '(?<=[￥$])\\d[\\d,]*' },
        { label: 'Negative lookbehind: not preceded by a dot',   pattern: '(?<!\\.)\\bword\\b' },
        { label: 'Value inside delimiters ("…")',       pattern: '(?<=")[^"]*(?=")' },

        { group: 'Quantifiers (greedy / lazy)' },
        { label: 'Shortest match (lazy) <…>',         pattern: '<.*?>' },
        { label: 'Markdown code block',        pattern: '```[\\s\\S]*?```' },
        { label: 'HTML / XML tag',                  pattern: '</?[a-zA-Z][^>]*>' },
        { label: 'Block comment /* ... */',    pattern: '/\\*[\\s\\S]*?\\*/' },
        { label: 'Line comment // …',             pattern: '//.*$' },

        { group: 'Groups & backreferences' },
        { label: 'Repeated word',              pattern: '\\b(\\w+)\\s+\\1\\b' },
        { label: 'Matching quotes ("" or \'\')', pattern: '(["\']).*?\\1' },
        { label: 'Named capture (year)',     pattern: '(?<year>\\d{4})' },

        { group: 'Whitespace & lines (formatting)' },
        { label: 'Trailing whitespace',                    pattern: '[ \\t]+$' },
        { label: 'Blank line (whitespace only)',           pattern: '^[ \\t]*$' },
        { label: 'Consecutive spaces',                  pattern: '[ \\t]{2,}' },
        { label: 'Full-width space',                  pattern: '\\u3000' },
        { label: 'Consecutive blank lines (3+)',        pattern: '(?:\\r?\\n){3,}' },

        { group: 'Numbers, dates & codes' },
        { label: 'Date YYYY-MM-DD',               pattern: '\\d{4}-\\d{2}-\\d{2}' },
        { label: 'Time HH:MM(:SS)',               pattern: '\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b' },
        { label: 'Hex colour #fff / #ffffff',     pattern: '#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\\b' },
        { label: 'Comma-separated number 1,234,567',    pattern: '\\b\\d{1,3}(?:,\\d{3})+\\b' },
        { label: 'Decimal (signed)',               pattern: '[+-]?\\d+(?:\\.\\d+)?' },
        { label: 'UUID',                          pattern: '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}' },
        { label: 'Semantic version',      pattern: '\\bv?\\d+\\.\\d+\\.\\d+\\b' },
        { label: 'Phone number (JP)',               pattern: '0\\d{1,4}-\\d{1,4}-\\d{4}' },
        { label: 'Postal code (JP)',               pattern: '\\d{3}-\\d{4}' }
    ];

    const _applyPreset = (pattern) => {
        EL.regexToggle.checked = true;
        EL.regexToggle.dispatchEvent(new Event('change'));
        EL.findInput.value = pattern;
        EL.findInput.focus();
        _performSearch(true);
    };

    const _showRegexPresets = (anchorEvent) => {
        const items = [];
        _regexPresets.forEach(p => {
            if (p.group) {
                if (items.length) items.push({ type: 'separator' });
                items.push({ label: `— ${p.group} —`, action: () => {} });
            } else {
                items.push({
                    label: `${p.label}    ${p.pattern}`,
                    action: () => _applyPreset(p.pattern)
                });
            }
        });
        ContextMenu.show(anchorEvent, items);
    };

    document.getElementById('regex-preset-btn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _showRegexPresets(e);
    });

    // ── Replace buttons ───────────────────────────────────────────────────────
    EL.replaceBtn.onclick   = () => { _doReplace(); if (isModalOpen()) closeSearchModal(); };
    EL.replaceAllBtn.onclick = () => { _doReplaceAll(); if (isModalOpen()) closeSearchModal(); };

    // ── Prev / Next buttons (in status bar) ───────────────────────────────────
    EL.findPrevBtn?.addEventListener('click', () => findPrev());
    EL.findNextBtn?.addEventListener('click', () => findNext());

    // ── Status bar buttons ────────────────────────────────────────────────────
    document.getElementById('search-status-reopen-btn')?.addEventListener('click', () => {
        openSearchModal(false);
    });
    document.getElementById('search-status-clear-btn')?.addEventListener('click', () => {
        _cleanupSearch();
    });

    // ── onchange: re-search (noFocus=true to keep modal focus) ───────────────
    EL.regexToggle.onchange = () => { State.searchMatches = []; _performSearch(true); };
    EL.caseToggle.onchange  = () => { State.searchMatches = []; _performSearch(true); };
    document.getElementById('word-toggle')?.addEventListener('change', () => { State.searchMatches = []; _performSearch(true); });

    // ── Clipboard support (Tauri) ─────────────────────────────────────────────
    EL.searchPanel.addEventListener('keydown', async (e) => {
        if (e.ctrlKey || e.metaKey) {
            const isInput = e.target.tagName === 'INPUT';
            if (e.key === 'c' && isInput) {
                const { selectionStart: s, selectionEnd: end, value } = e.target;
                if (s !== end) await writeText(value.substring(s, end));
                e.stopPropagation(); return;
            }
            if (e.key === 'v' && isInput) {
                e.preventDefault(); e.stopPropagation();
                try {
                    const text = await readText();
                    if (text) {
                        const { selectionStart: s, selectionEnd: end, value } = e.target;
                        e.target.value = value.substring(0, s) + text + value.substring(end);
                        e.target.selectionStart = e.target.selectionEnd = s + text.length;
                        e.target.dispatchEvent(new Event('input'));
                    }
                } catch (err) { console.warn('Search: paste failed', err); }
                return;
            }
            if (e.key === 'x' && isInput) {
                e.preventDefault(); e.stopPropagation();
                const { selectionStart: s, selectionEnd: end, value } = e.target;
                if (s !== end) {
                    await writeText(value.substring(s, end));
                    e.target.value = value.substring(0, s) + value.substring(end);
                    e.target.selectionStart = e.target.selectionEnd = s;
                    e.target.dispatchEvent(new Event('input'));
                }
                return;
            }
        }
    });

    // ── Unified search-panel key handler ─────────────────────────────────────
    // ShortcutManager yields when scope=SEARCH, so all search-specific keys
    // are handled here exclusively. This avoids capture-phase conflicts.
    const _toggleOpt = (checkbox) => {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
    };

    const _toggleReplaceRow = () => {
        const rr = document.getElementById('search-replace-row');
        const mb = document.getElementById('replace-mode-toggle-btn');
        if (!rr) return;
        const showing = rr.style.display !== 'none';
        rr.style.display = showing ? 'none' : 'flex';
        mb?.classList.toggle('active', !showing);
        if (!showing) setTimeout(() => EL.replaceInput.focus(), 0);
        else setTimeout(() => EL.findInput.focus(), 0);
    };

    // Called by both findInput and replaceInput keydown listeners
    function _handleSearchPanelKey(e) {
        const isReplace = e.target === EL.replaceInput;
        const alt  = e.altKey;
        const ctrl = e.ctrlKey || e.metaKey;
        const shift = e.shiftKey;
        const k = e.key;

        // ── Alt+Enter → Replace current match (separate from plain Enter to
        //    avoid accidental replacement) ──
        if (k === 'Enter' && alt && !ctrl && !shift) {
            e.preventDefault();
            _doReplace();
            // Close like a normal search; the global replace shortcut (Alt+Enter)
            // then drives subsequent replacements without re-opening the modal.
            if (isModalOpen()) closeSearchModal();
            return;
        }

        // ── Alt shortcuts (option toggles / actions) ──
        if (alt && !ctrl && !shift) {
            switch (k.toLowerCase()) {
                case 'e': e.preventDefault(); _toggleOpt(EL.regexToggle); return;
                case 'c': e.preventDefault(); _toggleOpt(EL.caseToggle); return;
                case 'w': e.preventDefault(); { const wt = document.getElementById('word-toggle'); if (wt) _toggleOpt(wt); } return;
                case 'p': e.preventDefault(); _toggleReplaceRow(); return;
                case 'a': e.preventDefault(); _doReplaceAll(); return;
                case 't': {
                    e.preventDefault();
                    const btn = document.getElementById('regex-preset-btn');
                    const r = btn ? btn.getBoundingClientRect() : { left: 200, bottom: 200 };
                    _showRegexPresets({
                        pageX: r.left, pageY: r.bottom,
                        preventDefault() {}, stopPropagation() {}
                    });
                    return;
                }
            }
        }

        // ── Tab navigation between find and replace ──
        if (k === 'Tab' && !ctrl && !alt) {
            const rr = document.getElementById('search-replace-row');
            if (rr && rr.style.display !== 'none') {
                e.preventDefault();
                if (shift) { EL.findInput.focus(); }
                else       { isReplace ? EL.findInput.focus() : EL.replaceInput.focus(); }
            }
            return;
        }

        // ── Enter → always Search & close (never replaces, in either input) ──
        if (k === 'Enter' && !ctrl && !alt) {
            e.preventDefault();
            if (shift) { findPrev(); } else { _runSearch(true); }
            if (EL.findInput.value) closeSearchModal();
            return;
        }

        // ── Escape ──
        if (k === 'Escape' && !ctrl && !alt && !shift) {
            e.preventDefault();
            // First Esc closes the panel (the search stays active, shown in the
            // status bar); a second Esc dismisses the search entirely — term
            // included, so find-next won't resurrect it.
            if (isModalOpen()) { closeSearchModal(); } else { _clearSearchState(); }
            return;
        }
    }

    // Wire the key handler to both inputs
    EL.findInput.addEventListener('keydown', _handleSearchPanelKey);
    EL.replaceInput.addEventListener('keydown', _handleSearchPanelKey);

    // ── Replace mode toggle button ────────────────────────────────────────────
    document.getElementById('replace-mode-toggle-btn')?.addEventListener('click', () => {
        _toggleReplaceRow();
    });
}

export { initSearch, toggleSearch, findNext, findPrev, replaceNext };
