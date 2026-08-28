/**
 * LargeFileEditView.js
 *
 * Phase 2 of the huge-file roadmap: *editing* files too large for a normal
 * textarea, backed by a Rust `ropey::Rope` (see commands/large_file.rs).
 *
 * Technique — "sliding window over a rope":
 *   The Rust rope is the source of truth for the whole file. The browser only
 *   ever holds a window of WINDOW_LINES lines in a real <textarea>, so native
 *   editing (IME, selection, undo, clipboard) all work and nothing freezes.
 *   When the user scrolls near a window edge we commit the current window back
 *   to the rope (a single char-range replacement) and load a new window.
 *
 * Because a window is always a set of whole lines, edits commit as line-range
 * replacements — no UTF-16/char-offset conversion is ever needed for edits.
 *
 * Limitations (acceptable for huge-file editing):
 *   - Operations that span more than one window (e.g. select-all) act only on
 *     the loaded window.
 *   - Pathological single-giant-line files are refused edit mode upstream.
 */

import { invoke } from '@tauri-apps/api/core';
import { iconEl } from '../ui/Icons.js';

const WINDOW_LINES = 4000;   // lines held in the textarea at once
const RELOAD_MARGIN = 800;   // re-center the window when within this many lines of an edge

export class LargeFileEditView {
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.file = options.file || null;
        this.editId = this.file ? this.file.editId : null;
        this.lineCount = this.file ? (this.file.lineCount || 0) : 0;

        this.winStart = 0;        // absolute index of the first line in the window
        this.winStartChar = 0;    // rope char offset of the window start
        this.winEndChar = 0;      // rope char offset of the window end (exclusive)
        this.localLineCount = 0;  // lines currently in the textarea
        this.windowDirty = false; // textarea has edits not yet committed to the rope

        this.lineHeight = 20;
        this._loading = false;
        this._scrollRaf = false;
        this._gutterRaf = false;
        this._activeMatch = null;

        this._onScroll = this._onScroll.bind(this);
        this._onInput = this._onInput.bind(this);
        this._onKeyDown = this._onKeyDown.bind(this);
        this._onBlur = this._onBlur.bind(this);
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                          */
    /* ------------------------------------------------------------------ */

    async render(file) {
        if (file) {
            this.file = file;
            this.editId = file.editId;
            this.lineCount = file.lineCount || 0;
        }
        this._buildDom();
        this.lineHeight = this._measureLineHeight();
        await this._loadWindow(0);
    }

    destroy() {
        if (this.textarea) {
            this.textarea.removeEventListener('scroll', this._onScroll);
            this.textarea.removeEventListener('input', this._onInput);
            this.textarea.removeEventListener('keydown', this._onKeyDown);
            this.textarea.removeEventListener('blur', this._onBlur);
        }
        // Preserve in-flight edits across tab switches (fire-and-forget; the rope
        // is owned by the tab, not this view, and is closed in closeTab()).
        if (this.windowDirty) this._commit();
        this.container.innerHTML = '';
    }

    focus() {
        if (this.textarea) this.textarea.focus();
    }

    getDiagnostics() {
        return [];
    }

    /* ------------------------------------------------------------------ */
    /* DOM                                                                */
    /* ------------------------------------------------------------------ */

    _buildDom() {
        this.container.innerHTML = '';
        this.container.style.position = 'relative';

        const root = document.createElement('div');
        root.className = 'lfe-root';

        // Banner
        const banner = document.createElement('div');
        banner.className = 'lfe-banner';

        const info = document.createElement('span');
        info.className = 'lfe-info';
        this.info = info;

        const findInput = document.createElement('input');
        findInput.type = 'text';
        findInput.placeholder = 'Search…';
        findInput.className = 'lfe-find-input';
        findInput.title = 'Search (Enter = next, Shift+Enter = previous)';
        findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.find(findInput.value, !e.shiftKey);
            }
        });
        this.findInput = findInput;

        const findStatus = document.createElement('span');
        findStatus.className = 'lfe-find-status';
        this.findStatus = findStatus;

        const saveBtn = document.createElement('button');
        saveBtn.className = 'lfe-save-btn';
        saveBtn.className = (saveBtn.className || '') + ' jh-icon-row';
        saveBtn.replaceChildren(iconEl('check', { size: 12 }), document.createTextNode('Save'));
        saveBtn.title = 'Save (Ctrl+S)';
        saveBtn.addEventListener('click', () => this.save());

        banner.append(info, findInput, findStatus, saveBtn);

        // Body: gutter + textarea
        const body = document.createElement('div');
        body.className = 'lfe-body';

        const gutter = document.createElement('div');
        gutter.className = 'lfe-gutter';
        const gutterInner = document.createElement('div');
        gutterInner.className = 'lfe-gutter-inner';
        gutter.appendChild(gutterInner);
        this.gutter = gutter;
        this.gutterInner = gutterInner;

        const textarea = document.createElement('textarea');
        textarea.className = 'lfe-textarea';
        textarea.setAttribute('wrap', 'off');
        textarea.spellcheck = false;
        textarea.autocapitalize = 'off';
        textarea.autocomplete = 'off';
        this.textarea = textarea;

        body.append(gutter, textarea);
        root.append(banner, body);
        this.container.appendChild(root);

        textarea.addEventListener('scroll', this._onScroll, { passive: true });
        textarea.addEventListener('input', this._onInput);
        textarea.addEventListener('keydown', this._onKeyDown);
        textarea.addEventListener('blur', this._onBlur);

        this._updateInfo();
    }

    _measureLineHeight() {
        const probe = document.createElement('div');
        probe.className = 'lfe-line-probe';
        probe.textContent = 'Mg';
        this.gutterInner.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        this.gutterInner.removeChild(probe);
        return Math.max(12, Math.round(h) || 20);
    }

    _updateInfo() {
        if (!this.info) return;
        const enc = this.file && this.file.encoding ? ` · ${this.file.encoding}` : '';
        this.info.classList.add('jh-icon-row');
        this.info.replaceChildren(iconEl('pencil', { size: 12 }), document.createTextNode(
            `Edit mode (large file) · ${this.lineCount.toLocaleString()} lines${enc}`));
    }

    _gutterWidthCss() {
        const digits = String(Math.max(1, this.lineCount)).length;
        return `calc(${digits}ch + 18px)`;
    }

    _renderGutter() {
        const w = this._gutterWidthCss();
        this.gutter.style.width = w;
        let html = '';
        const end = this.winStart + this.localLineCount;
        for (let i = this.winStart; i < end; i++) {
            html += `<div class="lfe-num">${i + 1}</div>`;
        }
        this.gutterInner.innerHTML = html;
        this.gutter.scrollTop = this.textarea.scrollTop;
    }

    /* ------------------------------------------------------------------ */
    /* Window load / commit                                               */
    /* ------------------------------------------------------------------ */

    async _loadWindow(startLine) {
        this._loading = true;
        try {
            if (this.windowDirty) await this._commit();
            const win = await invoke('editable_window', {
                id: this.editId,
                startLine,
                count: WINDOW_LINES,
            });
            this.textarea.value = win.text;
            this.winStart = startLine;
            this.winStartChar = win.start_char;
            this.winEndChar = win.end_char;
            this.windowDirty = false;
            this.localLineCount = this._countLines(win.text);
            this._renderGutter();
        } catch (e) {
            console.error('editable_window failed', e);
        } finally {
            this._loading = false;
        }
    }

    async _commit() {
        if (!this.windowDirty) return;
        const newText = this.textarea.value;
        try {
            const newCount = await invoke('editable_replace', {
                id: this.editId,
                startChar: this.winStartChar,
                endChar: this.winEndChar,
                text: newText,
            });
            this.lineCount = newCount;
            if (this.file) this.file.lineCount = newCount;
            // The window now spans a different char range; keep it consistent in
            // case the user keeps editing the same window before a reload.
            this.winEndChar = this.winStartChar + this._codePointCount(newText);
            this.windowDirty = false;
            this._updateInfo();
        } catch (e) {
            console.error('editable_replace failed', e);
        }
    }

    _countLines(text) {
        let n = 1;
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 10) n++;
        }
        return n;
    }

    _codePointCount(s) {
        // rope indexes by Unicode scalar value, not UTF-16 code unit.
        let n = 0;
        for (const _ of s) n++;
        return n;
    }

    /* ------------------------------------------------------------------ */
    /* Scrolling & sliding window                                         */
    /* ------------------------------------------------------------------ */

    _onScroll() {
        // Keep the gutter aligned every frame.
        if (!this._gutterRaf) {
            this._gutterRaf = true;
            requestAnimationFrame(() => {
                this._gutterRaf = false;
                this.gutter.scrollTop = this.textarea.scrollTop;
            });
        }
        // Throttle the heavier edge check.
        if (this._scrollRaf) return;
        this._scrollRaf = true;
        requestAnimationFrame(() => {
            this._scrollRaf = false;
            this._maybeSlideWindow();
        });
    }

    async _maybeSlideWindow() {
        if (this._loading) return;
        const topLocal = Math.floor(this.textarea.scrollTop / this.lineHeight);
        const viewLines = Math.ceil(this.textarea.clientHeight / this.lineHeight);
        const absTop = this.winStart + topLocal;
        const step = WINDOW_LINES - 2 * RELOAD_MARGIN;

        // Near the top edge — slide the window up.
        if (topLocal < RELOAD_MARGIN && this.winStart > 0) {
            const newStart = Math.max(0, this.winStart - step);
            await this._slideTo(newStart, absTop);
            return;
        }
        // Near the bottom edge — slide the window down.
        const bottomLocal = topLocal + viewLines;
        if (this.localLineCount - bottomLocal < RELOAD_MARGIN
            && this.winStart + this.localLineCount < this.lineCount) {
            const newStart = Math.min(
                Math.max(0, this.lineCount - 1),
                this.winStart + step
            );
            if (newStart !== this.winStart) await this._slideTo(newStart, absTop);
        }
    }

    async _slideTo(newStart, keepAbsLine) {
        await this._loadWindow(newStart);
        const localLine = Math.max(0, keepAbsLine - newStart);
        this.textarea.scrollTop = localLine * this.lineHeight;
        this.gutter.scrollTop = this.textarea.scrollTop;
    }

    /* ------------------------------------------------------------------ */
    /* Editing                                                            */
    /* ------------------------------------------------------------------ */

    _onInput() {
        this.windowDirty = true;
        if (this.file && !this.file.isDirty) {
            this.file.isDirty = true;
            if (typeof this.options.renderTabs === 'function') this.options.renderTabs();
        }
        // The number of lines in the window may have changed; refresh the gutter.
        if (!this._gutterRaf) {
            this._gutterRaf = true;
            requestAnimationFrame(() => {
                this._gutterRaf = false;
                this.localLineCount = this._countLines(this.textarea.value);
                this._renderGutter();
            });
        }
    }

    _onBlur() {
        if (this.windowDirty) this._commit();
    }

    _onKeyDown(e) {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 's') {
            e.preventDefault();
            this.save();
            return;
        }
        if (mod && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            if (this.findInput) this.findInput.focus();
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            const ta = this.textarea;
            const s = ta.selectionStart;
            const epos = ta.selectionEnd;
            ta.value = ta.value.slice(0, s) + '\t' + ta.value.slice(epos);
            ta.selectionStart = ta.selectionEnd = s + 1;
            this._onInput();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Save & find                                                        */
    /* ------------------------------------------------------------------ */

    async save() {
        if (!this.file || !this.file.path) return;
        await this._commit();
        try {
            await invoke('editable_save', { id: this.editId, path: this.file.path });
            this.file.isDirty = false;
            if (typeof this.options.renderTabs === 'function') this.options.renderTabs();
            if (window.showToast) window.showToast('Saved.');
        } catch (e) {
            console.error('editable_save failed', e);
            if (window.showToast) window.showToast(`Save failed: ${e}`);
        }
    }

    async find(term, forward = true) {
        if (!term) {
            this._activeMatch = null;
            if (this.findStatus) this.findStatus.textContent = '';
            return;
        }
        await this._commit(); // search runs over the rope; flush pending edits first
        const m = this._activeMatch;
        const fromLine = m ? m.line : (forward ? 0 : Math.max(0, this.lineCount - 1));
        const fromCol = m ? m.col : (forward ? -1 : Number.MAX_SAFE_INTEGER);
        try {
            const hit = await invoke('editable_search', {
                id: this.editId,
                query: term,
                fromLine,
                fromCol,
                forward,
                caseSensitive: false,
            });
            if (!hit) {
                this._activeMatch = null;
                if (this.findStatus) this.findStatus.textContent = 'Not found';
                return;
            }
            this._activeMatch = { line: hit.line, col: hit.col, length: hit.length };
            if (this.findStatus) this.findStatus.textContent = `Line ${hit.line + 1}`;
            await this._revealMatch(hit);
        } catch (e) {
            console.error('editable_search failed', e);
        }
    }

    async _revealMatch(hit) {
        const inWindow = hit.line >= this.winStart
            && hit.line < this.winStart + this.localLineCount;
        if (!inWindow) {
            await this._loadWindow(Math.max(0, hit.line - 10));
        }
        const localLine = hit.line - this.winStart;
        const lineStart = this._localLineStartOffset(localLine);
        const selStart = lineStart + hit.col;
        const selEnd = selStart + hit.length;
        this.textarea.focus();
        try { this.textarea.setSelectionRange(selStart, selEnd); } catch (e) { /* ignore */ }
        this.textarea.scrollTop = Math.max(0, localLine * this.lineHeight - this.textarea.clientHeight / 2);
        this.gutter.scrollTop = this.textarea.scrollTop;
    }

    // Offset (in UTF-16 code units, i.e. textarea indices) of the start of the
    // given local line within the current window text.
    _localLineStartOffset(localLine) {
        const v = this.textarea.value;
        let line = 0;
        let i = 0;
        while (line < localLine && i < v.length) {
            const nl = v.indexOf('\n', i);
            if (nl === -1) { i = v.length; break; }
            i = nl + 1;
            line++;
        }
        return i;
    }
}
