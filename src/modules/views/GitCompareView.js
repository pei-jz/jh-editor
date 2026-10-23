import { invoke } from '@tauri-apps/api/core';
import { MergeEditor } from '../editors/MergeEditor.js';
import { makeSide, mergeDirty } from '../utils/MergeSides.js';
import {
    buildFileTree, sortTree, countFiles, fileOrder, filterFiles, summarizeFiles, stepFile, looksBinary,
} from '../utils/GitCompare.js';
import { showDialog } from '../ui/Dialog.js';
import { iconEl } from '../ui/Icons.js';
import { t } from '../utils/I18n.js';
import { listChangedFiles } from '../utils/GitDiffFiles.js';

// Re-exported for the callers that know it from here.
export { listChangedFiles };

/**
 * GitCompareView — a Git comparison in an editor tab: the changed files on the
 * left, the selected file's diff on the right.
 *
 * Comparisons used to land in the strip under the history, a few rows high
 * and as wide as the sidebar, and each file opened a tab of its own. Here the
 * whole comparison is one tab: the list is as tall as the editor, the diff sits
 * beside it, and Ctrl+Up / Ctrl+Down walk the files without leaving the diff.
 *
 * The tab's `file.gitCompare` holds the comparison:
 *   root        repository the revisions belong to
 *   from / to   { rev, label } — rev '' is the working tree, which is the one
 *               side that can be edited and saved
 *   files       [{ status, path, old_path? }]
 *   title, note what the header says
 *   reload      { fromRev, toRev } to list the files again, when that applies
 *   selected    the file showing; kept on the tab so a redraw keeps it
 *
 * The selected file's two sides are `file.merge`, exactly as in any other
 * comparison tab, so saving and the unsaved-changes checks work unchanged.
 */
export class GitCompareView {
    /**
     * @param {HTMLElement} container
     * @param {object} file     the tab
     * @param {object} options  onDirtyChange(), onSave() — as for MergeEditor
     */
    constructor(container, file, options = {}) {
        this.container = container;
        this.file = file;
        this.gc = file.gitCompare;
        this.options = options;
        this.editor = null;
        this._token = 0;
        this._destroyed = false;
        if (!Array.isArray(this.gc.collapsed)) this.gc.collapsed = [];
        if (typeof this.gc.filter !== 'string') this.gc.filter = '';

        this._build();
        this._renderList();

        // Back to the file that was showing, with whatever was typed into it.
        const current = this.file.merge && this.file.merge.path;
        if (this.gc.selected && current === this.gc.selected) this._mountEditor();
        else if (this.gc.selected && this._entry(this.gc.selected)) this.select(this.gc.selected);
        else {
            const first = this._order()[0];
            if (first) this.select(first);
            else this._placeholder(this.gc.files.length ? t('No file matches the filter.') : t('No differences.'));
        }
    }

    // ── Layout ───────────────────────────────────────────────────────────────

    _build() {
        const c = this.container;
        c.innerHTML = '';
        c.classList.add('git-compare-view');
        c.style.padding = '0';
        c.style.overflow = 'hidden';

        this.root = document.createElement('div');
        this.root.className = 'gcv';

        this.listPane = document.createElement('div');
        this.listPane.className = 'gcv-list-pane';
        const saved = parseInt(localStorage.getItem('git_compare_list_width'), 10);
        if (saved >= 160) this.listPane.style.width = `${saved}px`;

        this.headEl = document.createElement('div');
        this.headEl.className = 'gcv-head';

        this.filterEl = document.createElement('input');
        this.filterEl.type = 'text';
        this.filterEl.className = 'gcv-filter';
        this.filterEl.placeholder = t('Filter files…');
        this.filterEl.spellcheck = false;
        this.filterEl.value = this.gc.filter;
        this.filterEl.addEventListener('input', () => {
            this.gc.filter = this.filterEl.value;
            this._renderList();
        });
        this.filterEl.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' && !e.ctrlKey) {
                e.preventDefault();
                this.treeEl.focus();
            } else if (e.key === 'Escape' && this.filterEl.value) {
                e.preventDefault();
                e.stopPropagation();
                this.filterEl.value = '';
                this.gc.filter = '';
                this._renderList();
            }
        });

        this.treeEl = document.createElement('div');
        this.treeEl.className = 'gcv-tree';
        this.treeEl.tabIndex = 0;
        this.treeEl.setAttribute('role', 'tree');
        this.treeEl.addEventListener('keydown', (e) => this._onTreeKey(e));

        this.listPane.append(this.headEl, this.filterEl, this.treeEl);

        this.resizer = document.createElement('div');
        this.resizer.className = 'gcv-resizer';
        this._bindResizer();

        this.diffPane = document.createElement('div');
        this.diffPane.className = 'gcv-diff-pane';

        this.root.append(this.listPane, this.resizer, this.diffPane);
        c.appendChild(this.root);

        // Ctrl+Up / Ctrl+Down while the list (or its filter) has the keyboard.
        // Inside the diff the comparison's own handler answers them.
        this.listPane.addEventListener('keydown', (e) => {
            const mod = e.ctrlKey || e.metaKey;
            if (!mod || e.shiftKey || e.altKey) return;
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            e.stopPropagation();
            this.step(e.key === 'ArrowDown' ? 1 : -1, { focusDiff: false });
        });

        this._renderHead();
    }

    _bindResizer() {
        let startX = 0;
        let startW = 0;
        const move = (e) => {
            const w = Math.round(Math.min(Math.max(startW + e.clientX - startX, 160),
                Math.max(200, this.root.clientWidth * 0.7)));
            this.listPane.style.width = `${w}px`;
        };
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            this.resizer.classList.remove('resizing');
            document.body.style.cursor = '';
            try { localStorage.setItem('git_compare_list_width', String(this.listPane.offsetWidth)); } catch (_) { /* private mode */ }
        };
        this.resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startW = this.listPane.offsetWidth;
            this.resizer.classList.add('resizing');
            document.body.style.cursor = 'col-resize';
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
    }

    _renderHead() {
        const h = this.headEl;
        h.innerHTML = '';

        const sides = document.createElement('div');
        sides.className = 'gcv-sides';
        const from = document.createElement('span');
        from.className = 'gcv-rev';
        from.textContent = this.gc.from.label;
        from.title = this.gc.from.rev || this.gc.from.label;
        const arrow = document.createElement('span');
        arrow.className = 'gcv-arrow';
        arrow.textContent = '→';
        const to = document.createElement('span');
        to.className = `gcv-rev${this.gc.to.rev === '' ? ' is-worktree' : ''}`;
        to.textContent = this.gc.to.label;
        to.title = this.gc.to.rev || this.gc.to.label;
        sides.append(from, arrow, to);

        const tools = document.createElement('div');
        tools.className = 'gcv-tools';
        if (this.gc.reload) {
            const refresh = document.createElement('button');
            refresh.className = 'gcv-tool';
            refresh.title = t('Compare again');
            refresh.setAttribute('aria-label', t('Compare again'));
            refresh.appendChild(iconEl('refresh', { size: 13 }));
            refresh.onclick = () => this.reload();
            tools.appendChild(refresh);
        }
        const toggle = document.createElement('button');
        toggle.className = 'gcv-tool';
        toggle.title = t('Collapse all folders');
        toggle.setAttribute('aria-label', t('Collapse all folders'));
        toggle.appendChild(iconEl('caret-right', { size: 13 }));
        toggle.onclick = () => this._toggleAllFolders();
        tools.appendChild(toggle);

        const top = document.createElement('div');
        top.className = 'gcv-head-top';
        top.append(sides, tools);
        h.appendChild(top);

        const sum = summarizeFiles(this.gc.files);
        const stats = document.createElement('div');
        stats.className = 'gcv-stats';
        const stat = (cls, text, title) => {
            const s = document.createElement('span');
            s.className = cls;
            s.textContent = text;
            s.title = title;
            return s;
        };
        stats.append(
            stat('gcv-count', t('{n} files', { n: this.gc.files.length }), ''),
            stat('gcv-st-A', `+${sum.A}`, t('Added')),
            stat('gcv-st-M', `~${sum.M}`, t('Modified')),
            stat('gcv-st-D', `−${sum.D}`, t('Deleted')),
        );
        if (sum.R) stats.appendChild(stat('gcv-st-R', `→${sum.R}`, t('Renamed')));
        h.appendChild(stats);

        if (this.gc.note) {
            const note = document.createElement('div');
            note.className = 'gcv-note';
            note.textContent = this.gc.note;
            h.appendChild(note);
        }
    }

    // ── The file list ────────────────────────────────────────────────────────

    _visibleFiles() {
        return filterFiles(this.gc.files, this.gc.filter);
    }

    _tree() {
        return sortTree(buildFileTree(this._visibleFiles()));
    }

    /** Files in the order they are drawn, folded folders included. */
    _order() {
        return fileOrder(this._tree());
    }

    _entry(path) {
        return this.gc.files.find((f) => f.path === path) || null;
    }

    _renderList() {
        const tree = this._tree();
        this.treeEl.innerHTML = '';
        if (!this.gc.files.length) {
            this.treeEl.appendChild(this._emptyRow(t('No differences.')));
            return;
        }
        if (!tree.dirs.length && !tree.files.length) {
            this.treeEl.appendChild(this._emptyRow(t('No file matches the filter.')));
            return;
        }
        const frag = document.createDocumentFragment();
        this._renderNode(frag, tree, 0);
        this.treeEl.appendChild(frag);
        this._markSelected();
    }

    _emptyRow(text) {
        const d = document.createElement('div');
        d.className = 'gcv-empty';
        d.textContent = text;
        return d;
    }

    _renderNode(host, node, depth) {
        const pad = (d) => 8 + d * 14;
        // While filtering, every folder is open: the point is to see the hits.
        const filtering = !!this.gc.filter.trim();

        for (const dir of node.dirs) {
            const closed = !filtering && this.gc.collapsed.includes(dir.path);
            const row = document.createElement('div');
            row.className = 'gcv-dir';
            row.style.paddingLeft = `${pad(depth)}px`;
            row.dataset.dir = dir.path;
            const caret = document.createElement('span');
            caret.className = 'gcv-caret';
            caret.appendChild(iconEl(closed ? 'caret-right' : 'caret-down', { size: 12 }));
            const name = document.createElement('span');
            name.className = 'gcv-dir-name';
            name.textContent = dir.name;
            name.title = dir.path;
            const count = document.createElement('span');
            count.className = 'gcv-dir-count';
            count.textContent = String(countFiles(dir));
            row.append(caret, name, count);
            row.onclick = () => this._toggleFolder(dir.path);
            host.appendChild(row);
            if (!closed) this._renderNode(host, dir, depth + 1);
        }

        for (const f of node.files) {
            const row = document.createElement('div');
            row.className = 'gcv-file';
            row.setAttribute('role', 'treeitem');
            row.style.paddingLeft = `${pad(depth) + 14}px`;
            row.dataset.path = f.path;
            row.title = f.old_path ? `${f.old_path} → ${f.path}` : f.path;
            const status = document.createElement('span');
            status.className = `gcv-status gcv-st-${f.status}`;
            status.textContent = f.status;
            const name = document.createElement('span');
            name.className = 'gcv-file-name';
            name.textContent = f.name;
            row.append(status, name);
            if (f.old_path) {
                const from = document.createElement('span');
                from.className = 'gcv-file-from';
                from.textContent = `← ${f.old_path.split('/').pop()}`;
                row.appendChild(from);
            }
            row.onclick = () => this.select(f.path, { focusDiff: false });
            host.appendChild(row);
        }
    }

    _toggleFolder(path) {
        const i = this.gc.collapsed.indexOf(path);
        if (i === -1) this.gc.collapsed.push(path);
        else this.gc.collapsed.splice(i, 1);
        this._renderList();
    }

    _toggleAllFolders() {
        const dirs = [];
        const walk = (n) => n.dirs.forEach((d) => { dirs.push(d.path); walk(d); });
        walk(this._tree());
        // Anything open: fold everything. All folded already: open everything.
        const anyOpen = dirs.some((d) => !this.gc.collapsed.includes(d));
        this.gc.collapsed = anyOpen ? dirs : [];
        this._renderList();
    }

    /** Open every folder above `path`, so the selected row can be seen. */
    _reveal(path) {
        const before = this.gc.collapsed.length;
        this.gc.collapsed = this.gc.collapsed.filter((d) => !path.startsWith(`${d}/`));
        if (this.gc.collapsed.length !== before) this._renderList();
    }

    _markSelected() {
        let current = null;
        for (const row of this.treeEl.querySelectorAll('.gcv-file')) {
            const on = row.dataset.path === this.gc.selected;
            row.classList.toggle('is-selected', on);
            row.setAttribute('aria-selected', String(on));
            if (on) current = row;
        }
        if (current && typeof current.scrollIntoView === 'function') {
            current.scrollIntoView({ block: 'nearest' });
        }
    }

    _onTreeKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const order = this._order();
        switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
            e.preventDefault();
            this.step(e.key === 'ArrowDown' ? 1 : -1, { focusDiff: false });
            return;
        case 'Home':
            e.preventDefault();
            if (order.length) this.select(order[0], { focusDiff: false });
            return;
        case 'End':
            e.preventDefault();
            if (order.length) this.select(order[order.length - 1], { focusDiff: false });
            return;
        case 'Enter':
            // Into the diff, to read or edit it.
            e.preventDefault();
            if (this.editor) this.editor.focus();
            return;
        default:
        }
    }

    // ── The diff ─────────────────────────────────────────────────────────────

    /**
     * Move to the next (1) or previous (-1) file of the list. At either end
     * nothing happens: wrapping around would hide that the end was reached.
     */
    step(direction, { focusDiff = true } = {}) {
        const next = stepFile(this._order(), this.gc.selected, direction);
        if (next) return this.select(next, { focusDiff });
        return Promise.resolve(false);
    }

    /**
     * Show `path`'s diff. Edits to the file showing are not dropped on the
     * way: they are saved, discarded or the move is cancelled, as the user
     * says. Resolves true when `path` is showing afterwards.
     */
    async select(path, { focusDiff = false } = {}) {
        const entry = this._entry(path);
        if (!entry) return false;
        if (this.gc.selected === path && this.editor) {
            this._markSelected();
            if (focusDiff) this.editor.focus();
            return true;
        }
        if (mergeDirty(this.file.merge)) {
            const go = await this._settleUnsaved();
            if (!go || this._destroyed) return false;
        }

        const token = ++this._token;
        this.gc.selected = path;
        this._reveal(path);
        this._markSelected();
        this._placeholder(t('Loading…'));

        const [left, right] = await Promise.all([
            this._readSide(this.gc.from, entry.old_path || entry.path, entry),
            this._readSide(this.gc.to, entry.path, entry),
        ]);
        if (token !== this._token || this._destroyed) return false;

        // One unreadable side is ordinary (added / deleted). Binary on either
        // side means the text diff would be noise.
        if (left.binary || right.binary) {
            left.text = right.text = t('(binary file — not shown)');
            left.writable = right.writable = false;
            left.target = right.target = null;
        }

        this.file.merge = {
            title: entry.path,
            path: entry.path,
            nav: this._nav(),
            left: makeSide(left),
            right: makeSide(right),
        };
        this.file.isDirty = false;
        this._mountEditor();
        if (focusDiff && this.editor) this.editor.focus();
        if (this.options.onDirtyChange) this.options.onDirtyChange();
        return true;
    }

    /** What `nav` the comparison is given: next / previous file, and where we are. */
    _nav() {
        const order = this._order();
        return {
            onNextFile: () => this.step(1),
            onPrevFile: () => this.step(-1),
            index: order.indexOf(this.gc.selected),
            count: order.length,
        };
    }

    /**
     * One side of the selected file. The working tree is read from disk and
     * can be saved back, with the encoding and line endings it was read with;
     * a revision comes from git and is history, so it stays read-only.
     */
    async _readSide(side, path, entry) {
        const label = `${path} (${side.label})`;
        const root = this.gc.root;
        if (side.rev === '') {
            const full = `${root}/${path}`.replace(/\\/g, '/');
            try {
                const data = await invoke('read_file_auto_detect', { path: full });
                const text = (data && data.content) || '';
                return {
                    label, text, binary: looksBinary(text),
                    writable: true,
                    target: {
                        kind: 'path', path: full,
                        encoding: (data && data.encoding) || 'UTF-8',
                        eol: (data && data.eol) || (/\r\n/.test(text) ? '\r\n' : '\n'),
                    },
                };
            } catch (_) {
                // Deleted from the working tree: nothing on disk to edit.
                return { label: `${label} — ${t('deleted')}`, text: '' };
            }
        }
        // Absent at this revision: the file was added (or deleted) in between.
        const absent = (entry.status === 'A' && side === this.gc.from)
            || (entry.status === 'D' && side === this.gc.to);
        if (absent) return { label: `${label} — ${t('not present')}`, text: '' };
        try {
            const text = await invoke('git_show', { path: root, revision: side.rev, file: path });
            return { label, text: text || '', binary: looksBinary(text) };
        } catch (_) {
            return { label: `${label} — ${t('not present')}`, text: '' };
        }
    }

    _mountEditor() {
        if (this.editor) {
            this.editor.destroy();
            this.editor = null;
        }
        this.diffPane.innerHTML = '';
        if (!this.file.merge) return;
        // The position may have moved since (filter, reload): say it afresh.
        this.file.merge.nav = this._nav();
        const host = document.createElement('div');
        host.className = 'gcv-diff-host';
        this.diffPane.appendChild(host);
        this.editor = new MergeEditor(host, this.file, {
            onDirtyChange: () => { if (this.options.onDirtyChange) this.options.onDirtyChange(); },
            onSave: () => this.options.onSave && this.options.onSave(),
        });
    }

    _placeholder(text) {
        if (this.editor) {
            this.editor.destroy();
            this.editor = null;
        }
        this.diffPane.innerHTML = '';
        const p = document.createElement('div');
        p.className = 'gcv-placeholder';
        p.textContent = text;
        this.diffPane.appendChild(p);
    }

    /**
     * The file showing has unsaved edits and another one is about to replace
     * it. Resolves true when it is fine to go on.
     */
    async _settleUnsaved() {
        const name = (this.file.merge && this.file.merge.path) || '';
        const choice = await showDialog({
            title: t('Unsaved Changes'),
            kind: 'warning',
            message: t('{name} has unsaved changes. Save them before moving to another file?', { name }),
            buttons: [
                { label: t('Cancel'), value: 'cancel', cancel: true },
                { label: t('Discard'), value: 'discard' },
                { label: t('Save'), value: 'save', primary: true },
            ],
        });
        if (choice === 'save') {
            const ok = this.options.onSave ? await this.options.onSave() : false;
            return ok !== false && !mergeDirty(this.file.merge);
        }
        if (choice === 'discard') {
            for (const key of ['left', 'right']) {
                const side = this.file.merge[key];
                if (side) side.text = side.savedText;
            }
            this.file.isDirty = false;
            return true;
        }
        return false;
    }

    /** List the files again — after saving into the working tree, say. */
    async reload() {
        const r = this.gc.reload;
        if (!r) return;
        try {
            const files = await listChangedFiles(this.gc.root, r.fromRev, r.toRev);
            if (this._destroyed) return;
            this.gc.files = files;
            this._renderHead();
            this._renderList();
            if (this.gc.selected && !this._entry(this.gc.selected) && !mergeDirty(this.file.merge)) {
                const first = this._order()[0];
                if (first) this.select(first);
                else this._placeholder(t('No differences.'));
            } else if (this.file.merge) {
                this.file.merge.nav = this._nav();
            }
        } catch (err) {
            console.error('GitCompareView: reload failed', err);
        }
    }

    // ── What the editor asks of a view ───────────────────────────────────────

    refreshState() { if (this.editor) this.editor.refreshState(); }
    getSelectedText() { return this.editor ? this.editor.getSelectedText() : ''; }
    copy() { return this.editor && this.editor.copy(); }
    cut() { return this.editor && this.editor.cut(); }
    paste() { return this.editor && this.editor.paste(); }
    undo() { if (this.editor) this.editor.undo(); }
    redo() { if (this.editor) this.editor.redo(); }
    focus() {
        if (this.editor) this.editor.focus();
        else this.treeEl.focus();
    }
    getDiagnostics() { return []; }

    destroy() {
        this._destroyed = true;
        if (this.editor) {
            this.editor.destroy();
            this.editor = null;
        }
        this.container.classList.remove('git-compare-view');
        this.container.innerHTML = '';
    }
}
