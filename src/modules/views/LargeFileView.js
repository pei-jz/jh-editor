/**
 * LargeFileView.js
 *
 * Phase 0 of the huge-file roadmap: a *read-only*, virtualized viewer that can
 * open 100MB+ text files without freezing.
 *
 * Why this exists:
 *   The normal PlainTextView puts the whole file into a <textarea> and rebuilds
 *   a highlight mirror. A <textarea> holding 100MB hangs the browser regardless
 *   of any backend data structure. This view never touches a textarea. It keeps
 *   the file as a single immutable string, builds a line-offset index over it
 *   (one O(n) scan, no per-line String objects), and only ever materializes the
 *   handful of lines currently on screen.
 *
 * Scope (intentionally minimal):
 *   - Read-only display + horizontal/vertical virtual scroll + line gutter.
 *   - Go-to-line and in-memory find (native indexOf / RegExp, no copy).
 *   - Escape hatch: "edit anyway" forces the full PlainTextView.
 *   Editing huge files (Rust rope / mmap) is Phase 1+ and deliberately not here.
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '../utils/I18n.js';

const MAX_SAFE_SCROLL_HEIGHT = 30_000_000; // browsers cap element height (~33.5M in Chrome)
const BUFFER_ROWS = 3;
const LINE_CACHE_LIMIT = 20_000; // cap cached backend lines to bound memory

function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class LargeFileView {
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.content = '';
        this.file = null;

        // 'memory': the whole file is a JS string (Phase 0, e.g. unsaved AI output).
        // 'backend': the file lives in Rust (mmap); lines are fetched on demand.
        this.mode = 'memory';
        this.byteSize = 0;

        // Line index (memory mode): lineStarts[i] is the offset where line i begins.
        this.lineStarts = [];
        this.lineCount = 0;

        // Backend mode state.
        this.backendId = null;
        this.lineCache = new Map();   // lineIndex -> string
        this._pendingRanges = new Set();

        this.lineHeight = 20;
        this.scale = 1;               // virtual->scroll compression factor when content exceeds MAX_SAFE_SCROLL_HEIGHT
        this.scrollHeight = 0;
        this._rafPending = false;
        this._activeMatch = null;     // { line, col, length }
        this._lastFindIndex = -1;     // char offset of last match, to resume search

        this._onScroll = this._onScroll.bind(this);
        this._onWheel = this._onWheel.bind(this);
        this._onKeyDown = this._onKeyDown.bind(this);
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                          */
    /* ------------------------------------------------------------------ */

    render(content, file) {
        this.file = file;

        if (file && file.isLarge && file.largeId != null) {
            // Backend (mmap) mode: file content stays in Rust.
            this.mode = 'backend';
            this.backendId = file.largeId;
            this.lineCount = file.lineCount || 0;
            this.byteSize = (file.stats && file.stats.size) || 0;
            this.lineCache = new Map();
            this._pendingRanges = new Set();
        } else {
            // In-memory mode: the whole file is a JS string.
            this.mode = 'memory';
            this.content = content || '';
            this._buildLineIndex();
            this.byteSize = this.content.length;
        }

        this._buildDom();
        // Layout must settle before we can measure clientHeight / line height.
        requestAnimationFrame(() => {
            this.lineHeight = this._measureLineHeight();
            this._computeScale();
            this._renderViewport();
        });
    }

    destroy() {
        if (this.viewport) {
            this.viewport.removeEventListener('scroll', this._onScroll);
            this.viewport.removeEventListener('wheel', this._onWheel);
        }
        if (this.root) {
            this.root.removeEventListener('keydown', this._onKeyDown);
        }
        // NOTE: the backend (mmap) handle is owned by the tab, not this view, so
        // it is NOT closed here — it must survive tab switches. closeTab() frees it.
        this.container.innerHTML = '';
        this.content = '';
        this.lineStarts = [];
        this.lineCache = new Map();
    }

    focus() {
        if (this.viewport) this.viewport.focus();
    }

    getDiagnostics() {
        return [];
    }

    /* ------------------------------------------------------------------ */
    /* Indexing                                                           */
    /* ------------------------------------------------------------------ */

    _buildLineIndex() {
        // Single forward scan. indexOf resumes from the previous newline, so the
        // total work is one pass over the string even for millions of lines.
        const content = this.content;
        const starts = [0];
        let idx = 0;
        let p;
        while ((p = content.indexOf('\n', idx)) !== -1) {
            starts.push(p + 1);
            idx = p + 1;
        }
        this.lineStarts = starts;
        this.lineCount = starts.length;
    }

    _lineText(i) {
        const start = this.lineStarts[i];
        const end = i + 1 < this.lineCount
            ? this.lineStarts[i + 1] - 1 // drop the trailing '\n'
            : this.content.length;
        return this.content.slice(start, end);
    }

    // Binary search: which line contains the given char offset.
    _lineAtOffset(offset) {
        const starts = this.lineStarts;
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    // Unified line accessor. Returns the line text, or null when a backend line
    // has not been fetched yet (the caller renders a placeholder and triggers a
    // fetch via _ensureRange).
    _getLineText(i) {
        if (this.mode === 'memory') return this._lineText(i);
        const cached = this.lineCache.get(i);
        return cached === undefined ? null : cached;
    }

    async _ensureRange(start, end) {
        const count = end - start + 1;
        const key = `${start}:${count}`;
        if (this._pendingRanges.has(key)) return;
        this._pendingRanges.add(key);
        let added = false;
        try {
            const lines = await invoke('large_file_lines', {
                id: this.backendId,
                start,
                count,
            });
            const before = this.lineCache.size;
            for (let k = 0; k < lines.length; k++) {
                this.lineCache.set(start + k, lines[k]);
            }
            added = this.lineCache.size > before;
            if (this.lineCache.size > LINE_CACHE_LIMIT) this._trimCache(start, end);
        } catch (e) {
            console.error('large_file_lines failed', e);
        } finally {
            this._pendingRanges.delete(key);
        }
        // Re-render only when new lines arrived, so a backend error can't spin.
        if (added) this._renderViewport();
    }

    // Drop cached lines far from the current view to bound memory on long scrolls.
    _trimCache(start, end) {
        const keepLo = start - 2000;
        const keepHi = end + 2000;
        for (const k of this.lineCache.keys()) {
            if (k < keepLo || k > keepHi) this.lineCache.delete(k);
        }
    }

    /* ------------------------------------------------------------------ */
    /* DOM                                                                */
    /* ------------------------------------------------------------------ */

    _buildDom() {
        this.container.innerHTML = '';
        this.container.style.position = 'relative';

        const root = document.createElement('div');
        root.className = 'lfv-root';
        root.tabIndex = 0;
        this.root = root;

        // --- banner -----------------------------------------------------
        const banner = document.createElement('div');
        banner.className = 'lfv-banner';

        const sizeMb = (this.byteSize / (1024 * 1024)).toFixed(1);
        const info = document.createElement('span');
        info.className = 'lfv-info';
        info.innerHTML = `🔒 Read-only (large file) · ${sizeMb} MB · ${this.lineCount.toLocaleString()} lines`;

        // go-to-line
        const lineInput = document.createElement('input');
        lineInput.type = 'number';
        lineInput.min = '1';
        lineInput.placeholder = t('Line');
        lineInput.className = 'lfv-line-input';
        lineInput.title = t('Go to line (Enter)');
        lineInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.goToLine(parseInt(lineInput.value, 10));
            }
        });

        // find
        const findInput = document.createElement('input');
        findInput.type = 'text';
        findInput.placeholder = t('Search…');
        findInput.className = 'lfv-find-input';
        findInput.title = t('Search (Enter = next, Shift+Enter = previous)');
        this.findInput = findInput;
        findInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.find(findInput.value, !e.shiftKey);
            }
        });

        const findStatus = document.createElement('span');
        findStatus.className = 'lfv-find-status';
        this.findStatus = findStatus;

        const editBtn = document.createElement('button');
        editBtn.className = 'lfv-edit-btn';
        editBtn.textContent = t('Open in edit mode (heavy)');
        editBtn.title = t('Opens this file in the normal editor. Large files may be slow.');
        editBtn.addEventListener('click', () => this._forceEditMode());

        banner.append(info, lineInput, findInput, findStatus, editBtn);

        // --- body (gutter + viewport) ----------------------------------
        const body = document.createElement('div');
        body.className = 'lfv-body';

        const gutter = document.createElement('div');
        gutter.className = 'lfv-gutter';
        const gutterInner = document.createElement('div');
        gutterInner.className = 'lfv-gutter-inner';
        gutter.appendChild(gutterInner);
        this.gutter = gutter;
        this.gutterInner = gutterInner;

        const viewport = document.createElement('div');
        viewport.className = 'lfv-viewport';
        viewport.tabIndex = 0;
        this.viewport = viewport;

        const sizer = document.createElement('div');
        sizer.className = 'lfv-sizer';
        this.sizer = sizer;

        const rows = document.createElement('div');
        rows.className = 'lfv-rows';
        this.rows = rows;

        viewport.append(sizer, rows);
        body.append(gutter, viewport);
        root.append(banner, body);
        this.container.appendChild(root);

        // Gutter width sized to the largest line number.
        const digits = String(this.lineCount).length;
        gutter.style.width = `calc(${digits}ch + 18px)`;
        viewport.style.left = `calc(${digits}ch + 18px)`;

        viewport.addEventListener('scroll', this._onScroll, { passive: true });
        viewport.addEventListener('wheel', this._onWheel, { passive: false });
        root.addEventListener('keydown', this._onKeyDown);
    }

    _measureLineHeight() {
        const probe = document.createElement('div');
        probe.className = 'lfv-line';
        probe.style.visibility = 'hidden';
        // A font-metric probe, not text anyone reads: 'M' and 'g' between them
        // span the ascender and the descender, which is what is being measured.
        probe.textContent = 'Mg';
        this.rows.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        this.rows.removeChild(probe);
        return Math.max(12, Math.round(h) || 20);
    }

    _computeScale() {
        const total = this.lineCount * this.lineHeight;
        if (total <= MAX_SAFE_SCROLL_HEIGHT) {
            this.scale = 1;
            this.scrollHeight = total;
        } else {
            this.scrollHeight = MAX_SAFE_SCROLL_HEIGHT;
            this.scale = total / MAX_SAFE_SCROLL_HEIGHT;
        }
        this.sizer.style.height = `${this.scrollHeight}px`;
    }

    /* ------------------------------------------------------------------ */
    /* Virtual rendering                                                  */
    /* ------------------------------------------------------------------ */

    _onScroll() {
        if (this._rafPending) return;
        this._rafPending = true;
        requestAnimationFrame(() => {
            this._rafPending = false;
            this._renderViewport();
        });
    }

    // When the scrollbar is compressed (scale > 1) a single wheel notch would
    // jump many lines. Translate wheel deltas into a fixed number of lines so
    // scrolling stays line-precise on giant files.
    _onWheel(e) {
        if (this.scale === 1) return; // native scrolling is fine
        e.preventDefault();
        const linesPerNotch = 3;
        const dir = e.deltaY > 0 ? 1 : -1;
        const factor = e.deltaMode === 1 ? 1 : (e.deltaMode === 2 ? 10 : (Math.abs(e.deltaY) > 50 ? 3 : 1));
        this.viewport.scrollTop += (dir * linesPerNotch * factor * this.lineHeight) / this.scale;
    }

    _onKeyDown(e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            if (this.findInput) this.findInput.focus();
        }
    }

    _renderViewport() {
        if (!this.viewport) return;
        const clientH = this.viewport.clientHeight;
        const scrollTop = this.viewport.scrollTop;
        const virtualTop = scrollTop * this.scale;

        let start = Math.floor(virtualTop / this.lineHeight) - BUFFER_ROWS;
        if (start < 0) start = 0;
        const visible = Math.ceil(clientH / this.lineHeight) + BUFFER_ROWS * 2;
        let end = Math.min(this.lineCount - 1, start + visible);

        // See header comment in code review: on-screen y of line k must equal
        // k*lineHeight - virtualTop for both panes.
        const rowsTransform = start * this.lineHeight - scrollTop * (this.scale - 1);
        const gutterTransform = start * this.lineHeight - virtualTop;

        // Build rows
        let rowsHtml = '';
        const match = this._activeMatch;
        let hasMissing = false;
        for (let i = start; i <= end; i++) {
            const text = this._getLineText(i);
            if (text === null) {
                // Backend line not yet fetched — show a placeholder for now.
                hasMissing = true;
                rowsHtml += `<div class="lfv-line lfv-line-loading">&nbsp;</div>`;
                continue;
            }
            if (match && match.line === i) {
                const before = escapeHtml(text.slice(0, match.col));
                const hit = escapeHtml(text.slice(match.col, match.col + match.length));
                const after = escapeHtml(text.slice(match.col + match.length));
                rowsHtml += `<div class="lfv-line lfv-line-active">${before}<mark>${hit}</mark>${after}</div>`;
            } else {
                rowsHtml += `<div class="lfv-line">${escapeHtml(text) || '&nbsp;'}</div>`;
            }
        }
        this.rows.innerHTML = rowsHtml;
        this.rows.style.transform = `translateY(${rowsTransform}px)`;

        if (hasMissing && this.mode === 'backend') {
            this._ensureRange(start, end);
        }

        // Build gutter
        let gutterHtml = '';
        for (let i = start; i <= end; i++) {
            const cls = match && match.line === i ? 'lfv-num lfv-num-active' : 'lfv-num';
            gutterHtml += `<div class="${cls}">${i + 1}</div>`;
        }
        this.gutterInner.innerHTML = gutterHtml;
        this.gutterInner.style.transform = `translateY(${gutterTransform}px)`;
    }

    /* ------------------------------------------------------------------ */
    /* Navigation                                                         */
    /* ------------------------------------------------------------------ */

    goToLine(lineNumber) {
        if (!Number.isFinite(lineNumber)) return;
        const idx = Math.min(this.lineCount, Math.max(1, lineNumber)) - 1;
        const targetTop = (idx * this.lineHeight) / this.scale;
        // Center the line if possible.
        this.viewport.scrollTop = Math.max(0, targetTop - this.viewport.clientHeight / 2);
        this._renderViewport();
    }

    find(term, forward = true) {
        if (this.mode === 'backend') {
            this._findBackend(term, forward);
            return;
        }
        if (!term) {
            this._activeMatch = null;
            if (this.findStatus) this.findStatus.textContent = '';
            this._renderViewport();
            return;
        }
        const re = new RegExp(escapeRegExp(term), 'gi');

        let foundIndex = -1;
        let foundLen = 0;
        if (forward) {
            re.lastIndex = this._lastFindIndex + 1;
            let m = re.exec(this.content);
            if (!m) { re.lastIndex = 0; m = re.exec(this.content); } // wrap
            if (m) { foundIndex = m.index; foundLen = m[0].length; }
        } else {
            // Backward: scan from the start collecting the last match before the cursor.
            const ceiling = this._lastFindIndex >= 0 ? this._lastFindIndex : this.content.length;
            let m;
            let prev = null;
            while ((m = re.exec(this.content)) !== null) {
                if (m.index < ceiling) prev = { index: m.index, len: m[0].length };
                else break;
                if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-length loop
            }
            if (!prev) {
                // wrap to last match in the file
                re.lastIndex = 0;
                while ((m = re.exec(this.content)) !== null) {
                    prev = { index: m.index, len: m[0].length };
                    if (m.index === re.lastIndex) re.lastIndex++;
                }
            }
            if (prev) { foundIndex = prev.index; foundLen = prev.len; }
        }

        if (foundIndex < 0) {
            this._activeMatch = null;
            if (this.findStatus) this.findStatus.textContent = t('Not found');
            this._renderViewport();
            return;
        }

        this._lastFindIndex = foundIndex;
        const line = this._lineAtOffset(foundIndex);
        const col = foundIndex - this.lineStarts[line];
        this._activeMatch = { line, col, length: foundLen };
        if (this.findStatus) this.findStatus.textContent = `Line ${line + 1}`;
        this.goToLine(line + 1);
    }

    async _findBackend(term, forward) {
        if (!term) {
            this._activeMatch = null;
            if (this.findStatus) this.findStatus.textContent = '';
            this._renderViewport();
            return;
        }
        const m = this._activeMatch;
        const fromLine = m ? m.line : (forward ? 0 : Math.max(0, this.lineCount - 1));
        const fromCol = m ? m.col : (forward ? -1 : Number.MAX_SAFE_INTEGER);
        try {
            const hit = await invoke('large_file_search', {
                id: this.backendId,
                query: term,
                fromLine,
                fromCol,
                forward,
                caseSensitive: false,
            });
            if (!hit) {
                this._activeMatch = null;
                if (this.findStatus) this.findStatus.textContent = t('Not found');
                this._renderViewport();
                return;
            }
            this._activeMatch = { line: hit.line, col: hit.col, length: hit.length };
            if (this.findStatus) this.findStatus.textContent = `Line ${hit.line + 1}`;
            this.goToLine(hit.line + 1);
        } catch (e) {
            console.error('large_file_search failed', e);
        }
    }

    async _forceEditMode() {
        if (this.mode === 'backend') {
            // Huge disk file → open a Rust rope edit session (Phase 2) rather
            // than loading 100MB into a <textarea>, which would freeze.
            const avgLine = this.byteSize / Math.max(1, this.lineCount);
            if (avgLine > 2 * 1024 * 1024) {
                if (window.showToast) {
                    window.showToast('A single line is too long to edit — this file stays read-only.');
                }
                return;
            }
            try {
                const meta = await invoke('editable_open', { path: this.file.path });
                this.file.editId = meta.id;
                this.file.isEditing = true;
                this.file.isLarge = false; // no longer the read-only mmap view
                this.file.lineCount = meta.line_count;
                this.file.encoding = meta.encoding || this.file.encoding;
                this.file.eol = meta.eol || this.file.eol;
            } catch (e) {
                console.error('editable_open failed', e);
                if (window.showToast) window.showToast('Could not open edit mode.');
                return;
            }
        } else {
            // In-memory file: content is already in JS, the normal editor is fine.
            if (this.file) this.file.forceFullEdit = true;
        }
        if (typeof this.options.renderEditor === 'function') {
            this.options.renderEditor();
        }
    }
}
