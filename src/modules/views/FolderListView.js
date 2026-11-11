/**
 * FolderListView — one folder's contents as a file manager lists them, in an
 * editor tab: name, size, date and type, sortable by any of them.
 *
 * The tree in the sidebar is for finding where things are; it is too narrow to
 * compare sizes or dates. There is one such tab (Editor.js showFolderList), and
 * the folder it shows lives on the tab as `file.folder`, so a redraw — switching
 * tabs, splitting the editor — comes back to the same place.
 *
 * Files are copied, moved, renamed and deleted through the tree's own
 * operations (Explorer.js fileOps): one clipboard for both, and a row dragged
 * from one onto the other is moved, as between two Explorer windows.
 */
import { invoke } from '@tauri-apps/api/core';
import { State } from '../core/Store.js';
import { fileOps } from '../core/Explorer.js';
import { t } from '../utils/I18n.js';
import * as FS from '../utils/FileSystem.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { iconEl, iconForFile } from '../ui/Icons.js';
import { formatSize } from '../ui/LoadingOverlay.js';
import { formatModified, typeAheadIndex } from '../utils/ExplorerTree.js';
import { externalKind } from '../utils/ExternalFiles.js';

const SORT_KEY = 'folder_list_sort';
const COLUMNS = ['name', 'size', 'modified', 'type'];

/** What the Type column says: the extension, which is what people sort by. */
export function fileType(name, isDirectory) {
    if (isDirectory) return t('Folder');
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
}

/** Folders first whatever the column, then by the column, then by name. */
export function sortEntries(entries, key = 'name', descending = false) {
    const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const sign = descending ? -1 : 1;
    const value = (e) => (key === 'type' ? fileType(e.name, e.is_directory) : (e[key] || 0));
    return [...entries].sort((a, b) => {
        if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
        let order;
        if (key === 'name') order = byName.compare(a.name, b.name);
        else if (key === 'type') order = byName.compare(value(a), value(b));
        else order = value(a) - value(b);
        return (order * sign) || byName.compare(a.name, b.name);
    });
}

function readSort() {
    try {
        const saved = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
        if (saved && COLUMNS.includes(saved.key)) return { key: saved.key, descending: !!saved.descending };
    } catch (_) { /* ignore */ }
    return { key: 'name', descending: false };
}

/**
 * The folder above `path`, or null at the top. A drive keeps its slash: on
 * Windows "C:" alone means the current folder of drive C, not its root.
 */
export function parentFolder(path) {
    const p = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
    const slash = p.lastIndexOf('/');
    if (slash < 0) return null;
    const parent = p.slice(0, slash);
    if (/^[A-Za-z]:$/.test(parent)) return `${parent}/`;
    return parent || '/';
}

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** `path` is `root` or somewhere beneath it. */
function isWithin(path, root) {
    const top = norm(root);
    const p = norm(path);
    return p === top || p.startsWith(`${top}/`);
}

/** One level up from `dir`, but never above `root` (the workspace). */
export function upFrom(dir, root) {
    const parent = parentFolder(dir);
    if (!parent || !root) return parent;
    return isWithin(parent, root) ? parent : null;
}

/**
 * The address bar's pieces: every folder from the drive down to `dir`, each
 * with the path it stands for. `inside` says whether it is in the workspace,
 * which is the only place a piece can take you.
 */
export function breadcrumbs(dir, root) {
    const parts = String(dir).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    const out = [];
    let acc = '';
    parts.forEach((part, i) => {
        acc = i === 0 ? part : `${acc}/${part}`;
        if (i > 0 && !part) return;
        const path = /^[A-Za-z]:$/.test(acc) ? `${acc}/` : (acc || '/');
        out.push({ label: part || '/', path, inside: !!root && isWithin(path, root) });
    });
    return out;
}

const WIDTH_KEY = 'folder_list_columns';
const MIN_WIDTH = { name: 120, size: 50, modified: 80, type: 50 };

function readWidths() {
    try {
        const saved = JSON.parse(localStorage.getItem(WIDTH_KEY) || 'null');
        return saved && typeof saved === 'object' ? saved : {};
    } catch (_) {
        return {};
    }
}

function baseName(path) {
    return String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path);
}

/**
 * Two rows that can be compared, upper one on the left: two files the editor
 * can read as text, or two folders. Anything else, null.
 */
export function compareTarget(entries) {
    if (entries.length !== 2) return null;
    const [left, right] = entries;
    if (left.is_directory && right.is_directory) return { left, right, folders: true };
    if (left.is_directory || right.is_directory) return null;
    if (externalKind(left.name) || externalKind(right.name)) return null;
    return { left, right, folders: false };
}

/** F2 as WebView2 sometimes reports it ('Unidentified', see ShortcutManager). */
function isF2(e) {
    return e.key === 'F2' || e.code === 'F2' || e.keyCode === 113;
}

export class FolderListView {
    /**
     * @param {HTMLElement} container
     * @param {object} file      the tab; `file.folder` is the folder shown
     * @param {object} options   openFile(path), showInTree(path), onNavigate()
     */
    constructor(container, file, options = {}) {
        this.container = container;
        this.file = file;
        this.options = options;
        this.entries = [];
        this.sorted = [];
        // The cursor (one row) and the selection (any number of rows), as in
        // the tree: Ctrl+click adds, Shift+click takes a range from the anchor.
        this.selected = null;
        this.selection = new Set();
        this.anchor = null;
        this.sort = readSort();
        this._token = 0;
        this._build();
        // The tree, a paste, a drop or F5 changed files: show them now.
        this._onFilesChanged = () => this.load();
        window.addEventListener('workspace-files-changed', this._onFilesChanged);
        // Back from another application, which may have changed the folder.
        this._onWindowFocus = () => { if (this.container.isConnected) this.load(); };
        window.addEventListener('focus', this._onWindowFocus);
        this.load();
    }

    // ── Layout ───────────────────────────────────────────────────────────────

    _build() {
        const c = this.container;
        c.innerHTML = '';
        c.classList.add('folder-list-mode');

        this.root = document.createElement('div');
        this.root.className = 'flv';
        // Ctrl+C/X/V, Delete, F2 and Ctrl+N are this list's (ShortcutManager).
        this.root.dataset.shortcutKeys = 'files';
        this.widths = readWidths();
        for (const key of COLUMNS) {
            if (this.widths[key]) this.root.style.setProperty(`--flv-${key}`, `${this.widths[key]}px`);
        }

        const bar = document.createElement('div');
        bar.className = 'flv-bar';
        this.upBtn = this._button('arrow-up', t('Up one folder'), () => this.goUp());
        this.pathEl = document.createElement('div');
        this.pathEl.className = 'flv-path';
        this.countEl = document.createElement('span');
        this.countEl.className = 'flv-count';
        bar.append(this.upBtn, this.pathEl, this.countEl,
            this._button('folder-plus', t('New Folder'), () => this.newFolder()),
            this._button('refresh', t('Refresh'), () => this.refresh()));

        this.head = document.createElement('div');
        this.head.className = 'flv-row flv-head';
        const labels = { name: t('Name'), size: t('Size'), modified: t('Date modified'), type: t('Type') };
        this.headCells = {};
        for (const key of COLUMNS) {
            const cell = document.createElement('button');
            cell.className = `flv-cell flv-${key}`;
            cell.addEventListener('click', () => {
                // The end of a drag on the edge is not a click on the column.
                if (this._resized) { this._resized = false; return; }
                this.sortBy(key);
            });
            const text = document.createElement('span');
            text.className = 'flv-head-label';
            cell.appendChild(text);
            cell.appendChild(this._resizer(key, cell));
            this.headCells[key] = { cell: text, label: labels[key] };
            this.head.appendChild(cell);
        }

        this.list = document.createElement('div');
        this.list.className = 'flv-list';
        this.list.tabIndex = 0;
        this.list.addEventListener('keydown', (e) => this.onKey(e));
        this.list.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.flv-row')) return;
            e.preventDefault();
            this._showMenu(e, null);
        });
        // A click on the empty space below the rows clears the selection.
        this.list.addEventListener('click', (e) => {
            if (e.target.closest('.flv-row') || !this.selection.size) return;
            this.selection.clear();
            this._paintSelection();
        });
        this._bindDrop();

        this.root.append(bar, this.head, this.list);
        c.appendChild(this.root);
        this._drawHead();
    }

    /** The edge of a column heading: drag to resize, double-click for the default. */
    _resizer(key, cell) {
        const grip = document.createElement('span');
        grip.className = 'flv-resize';
        grip.addEventListener('click', (e) => e.stopPropagation());
        grip.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            delete this.widths[key];
            this.root.style.removeProperty(`--flv-${key}`);
            this._saveWidths();
        });
        grip.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            grip.setPointerCapture(e.pointerId);
            const startX = e.clientX;
            const startWidth = cell.getBoundingClientRect().width;
            const move = (ev) => {
                const width = Math.max(MIN_WIDTH[key], Math.round(startWidth + ev.clientX - startX));
                this.widths[key] = width;
                this.root.style.setProperty(`--flv-${key}`, `${width}px`);
            };
            const up = () => {
                grip.removeEventListener('pointermove', move);
                grip.removeEventListener('pointerup', up);
                this._resized = true;
                setTimeout(() => { this._resized = false; }, 0);
                this._saveWidths();
            };
            grip.addEventListener('pointermove', move);
            grip.addEventListener('pointerup', up);
        });
        return grip;
    }

    _saveWidths() {
        try { localStorage.setItem(WIDTH_KEY, JSON.stringify(this.widths)); } catch (_) { /* ignore */ }
    }

    _button(icon, label, onClick) {
        const btn = document.createElement('button');
        btn.className = 'flv-btn';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.appendChild(iconEl(icon, { size: 14 }));
        btn.addEventListener('click', onClick);
        return btn;
    }

    _drawHead() {
        for (const key of COLUMNS) {
            const { cell, label } = this.headCells[key];
            const mark = this.sort.key === key ? (this.sort.descending ? ' ▼' : ' ▲') : '';
            cell.textContent = label + mark;
        }
    }

    /**
     * The address: each folder in it is a link, up to the workspace. Above the
     * workspace the pieces are only text — the list does not go there.
     */
    _drawPath(dir) {
        const el = this.pathEl;
        el.innerHTML = '';
        el.title = String(dir).replace(/\\/g, '/');
        const crumbs = breadcrumbs(dir, State.currentDir);
        crumbs.forEach((crumb, i) => {
            const last = i === crumbs.length - 1;
            if (i > 0 && crumbs[i - 1].label !== '/') {
                const sep = document.createElement('span');
                sep.className = 'flv-crumb-sep';
                sep.textContent = '/';
                el.appendChild(sep);
            }
            let piece;
            if (crumb.inside && !last) {
                piece = document.createElement('button');
                piece.className = 'flv-crumb';
                piece.title = crumb.path;
                // Back up to here with the folder we came from under the cursor.
                const from = crumbs[i + 1].path;
                piece.addEventListener('click', () => this.navigate(crumb.path, from));
                this._bindCrumbDrop(piece, crumb.path);
            } else {
                piece = document.createElement('span');
                piece.className = last ? 'flv-crumb flv-crumb-current' : 'flv-crumb flv-crumb-outside';
            }
            piece.textContent = crumb.label;
            el.appendChild(piece);
        });
        // A deep folder: keep its own name in view, the drive can scroll off.
        el.scrollLeft = el.scrollWidth;
    }

    // ── Data ─────────────────────────────────────────────────────────────────

    /** Read the folder again. `select` puts the cursor on that path afterwards. */
    async load({ select = null } = {}) {
        if (this._renaming) return;
        const dir = this.file.folder;
        const token = ++this._token;
        this._drawPath(dir);
        this.upBtn.disabled = !upFrom(dir, State.currentDir);
        let entries;
        try {
            entries = await invoke('read_dir_details', { path: dir });
        } catch (e) {
            if (token !== this._token) return;
            // Deleted, moved or renamed from under the list: go to the nearest
            // folder that is still there rather than show an error.
            const up = upFrom(dir, State.currentDir);
            let gone = false;
            try { gone = !(await FS.exists(dir)); } catch (_) { /* keep the message */ }
            if (token !== this._token) return;
            if (gone && up) {
                this.navigate(up);
                return;
            }
            console.error('FolderListView: could not read', dir, e);
            this.entries = [];
            this._render(t('Could not read this folder.'));
            return;
        }
        if (token !== this._token) return;
        // The backend joins with the OS separator onto whatever it was given,
        // so "C:/work" comes back as "C:/work\a.txt". The tree writes paths with
        // forward slashes; so does this, or a path from it would never match.
        this.entries = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, '/') }));
        // Arriving from the tree with a file in mind (Show in Folder List).
        const wanted = select || this.file.select;
        this.file.select = null;
        if (wanted) this._selectOnly(String(wanted).replace(/\\/g, '/'));
        this._render('', { scroll: !!wanted });
    }

    /** F5 or the button: the list and the tree, both read again. */
    refresh() {
        fileOps.refreshTree();
        this.load();
    }

    _render(message = '', { scroll = true } = {}) {
        this.sorted = sortEntries(this.entries, this.sort.key, this.sort.descending);
        // What is no longer there cannot stay selected.
        const present = new Set(this.sorted.map((x) => x.path));
        for (const p of [...this.selection]) if (!present.has(p)) this.selection.delete(p);
        if (this.selected && !present.has(this.selected)) this.selected = null;
        this.countEl.textContent = message ? '' : t('{n} items', { n: this.sorted.length });
        const top = this.list.scrollTop;
        this.list.innerHTML = '';
        if (message || !this.sorted.length) {
            const empty = document.createElement('div');
            empty.className = 'flv-empty';
            empty.textContent = message || t('This folder is empty.');
            this.list.appendChild(empty);
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const entry of this.sorted) fragment.appendChild(this._row(entry));
        this.list.appendChild(fragment);
        this.list.scrollTop = top;
        if (scroll) this._scrollToSelected();
    }

    _row(entry) {
        const row = document.createElement('div');
        row.className = 'flv-row';
        row.dataset.path = entry.path;
        if (this.selection.has(entry.path)) row.classList.add('selected');
        if (entry.path === this.selected) row.classList.add('cursor');
        if (fileOps.isCut(entry.path)) row.classList.add('flv-cut');
        const external = entry.is_directory ? null : externalKind(entry.name);
        if (external) row.classList.add('flv-external');

        const name = document.createElement('span');
        name.className = 'flv-cell flv-name';
        name.appendChild(iconEl(iconForFile(entry.name, entry.is_directory, false), { size: 14 }));
        const label = document.createElement('span');
        label.className = 'flv-label';
        label.textContent = entry.name;
        name.appendChild(label);

        const size = document.createElement('span');
        size.className = 'flv-cell flv-size';
        size.textContent = entry.is_directory ? '' : formatSize(entry.size);
        const modified = document.createElement('span');
        modified.className = 'flv-cell flv-modified';
        modified.textContent = formatModified(entry.modified);
        const type = document.createElement('span');
        type.className = 'flv-cell flv-type';
        type.textContent = fileType(entry.name, entry.is_directory);
        row.append(name, size, modified, type);

        row.addEventListener('click', (e) => this.clickRow(entry.path, e));
        row.addEventListener('dblclick', () => this.open(entry));
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Inside the selection the menu acts on all of it; outside, on this row.
            if (!this.selection.has(entry.path)) this.select(entry.path);
            else this.selected = entry.path;
            this._showMenu(e, entry);
        });
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
            // Dragging an unselected row drags that row alone, as in Explorer.
            if (!this.selection.has(entry.path)) this.select(entry.path);
            // Into the tree, into a folder here, or out of the app.
            fileOps.beginDrag(e, this.selectionInOrder(), () => this._setDropTarget(null));
        });
        row.addEventListener('dragend', () => {
            fileOps.endDrag();
            this._setDropTarget(null);
        });
        return row;
    }

    // ── Selection ────────────────────────────────────────────────────────────

    /** The selected paths, top to bottom; the cursor's row when none is. */
    selectionInOrder() {
        const paths = this.sorted.filter((x) => this.selection.has(x.path)).map((x) => x.path);
        if (!paths.length && this.selected) return [this.selected];
        return paths;
    }

    _selectOnly(path) {
        this.selected = path;
        this.anchor = path;
        this.selection = new Set(path ? [path] : []);
    }

    /** Put the cursor on `path` and select it alone. */
    select(path) {
        this._selectOnly(path);
        this._paintSelection();
        this._scrollToSelected();
        this.list.focus({ preventScroll: true });
    }

    clickRow(path, e) {
        if (e.shiftKey) {
            this._selectRange(path, e.ctrlKey || e.metaKey);
        } else if (e.ctrlKey || e.metaKey) {
            if (this.selection.has(path)) this.selection.delete(path);
            else this.selection.add(path);
            this.selected = path;
            this.anchor = path;
        } else {
            this._selectOnly(path);
        }
        this._paintSelection();
        this.list.focus({ preventScroll: true });
    }

    /** Every row from the anchor to `path`; `additive` keeps what was selected. */
    _selectRange(path, additive = false) {
        const paths = this.sorted.map((x) => x.path);
        let from = paths.indexOf(this.anchor);
        const to = paths.indexOf(path);
        if (to < 0) return;
        if (from < 0) from = to;
        if (!additive) this.selection.clear();
        const [a, b] = from < to ? [from, to] : [to, from];
        for (let i = a; i <= b; i++) this.selection.add(paths[i]);
        this.selected = path;
    }

    _paintSelection() {
        for (const row of this.list.querySelectorAll('.flv-row')) {
            row.classList.toggle('selected', this.selection.has(row.dataset.path));
            row.classList.toggle('cursor', row.dataset.path === this.selected);
            row.classList.toggle('flv-cut', fileOps.isCut(row.dataset.path));
        }
    }

    _scrollToSelected() {
        if (!this.selected) return;
        const row = this._rowFor(this.selected);
        if (row) row.scrollIntoView({ block: 'nearest' });
    }

    _rowFor(path) {
        return [...this.list.querySelectorAll('.flv-row')].find((r) => r.dataset.path === path) || null;
    }

    // ── Drag and drop ────────────────────────────────────────────────────────

    /**
     * The list takes drops: on a folder row into that folder, anywhere else
     * into the folder shown. From the tree or from here it is a move (Ctrl:
     * copy); from outside the app, a copy.
     */
    _bindDrop() {
        const targetOf = (e) => {
            const row = e.target.closest && e.target.closest('.flv-row');
            const entry = row && this.sorted.find((x) => x.path === row.dataset.path);
            return entry && entry.is_directory ? { dir: entry.path, row } : { dir: this.file.folder, row: null };
        };
        this.list.addEventListener('dragover', (e) => {
            const { dir, row } = targetOf(e);
            e.preventDefault();
            if (!fileOps.acceptsDrop(e, dir)) {
                e.dataTransfer.dropEffect = 'none';
                this._setDropTarget(null);
                return;
            }
            e.dataTransfer.dropEffect = fileOps.dropEffect(e);
            this._setDropTarget(row || this.list, row ? { dir, e } : null);
        });
        this.list.addEventListener('dragleave', (e) => {
            if (!this.list.contains(e.relatedTarget)) this._setDropTarget(null);
        });
        this.list.addEventListener('drop', async (e) => {
            const { dir } = targetOf(e);
            e.preventDefault();
            this._setDropTarget(null);
            if (!fileOps.acceptsDrop(e, dir)) return;
            const done = await fileOps.drop(e, dir);
            this._afterChange(done);
        });
    }

    /** A folder in the address bar is a drop target too, as in Explorer. */
    _bindCrumbDrop(el, dir) {
        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const ok = fileOps.acceptsDrop(e, dir);
            e.dataTransfer.dropEffect = ok ? fileOps.dropEffect(e) : 'none';
            this._setDropTarget(ok ? el : null, ok ? { dir, e } : null);
        });
        el.addEventListener('dragleave', (e) => {
            if (!el.contains(e.relatedTarget)) this._setDropTarget(null);
        });
        el.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._setDropTarget(null);
            if (!fileOps.acceptsDrop(e, dir)) return;
            await fileOps.drop(e, dir);
        });
    }

    /**
     * Mark where a drop would land. With `hint`, also say so in words below
     * the target: the OS drag image is large and sits over the cursor, and a
     * folder name in the address bar is small enough to vanish under it.
     */
    _setDropTarget(el, hint = null) {
        if (this._dropEl !== el) {
            if (this._dropEl) this._dropEl.classList.remove('flv-drop');
            this._dropEl = el;
            if (el) el.classList.add('flv-drop');
        }
        this._showDropHint(el && hint ? el : null, hint);
    }

    _showDropHint(el, hint) {
        if (!el) {
            if (this._hintEl) this._hintEl.hidden = true;
            return;
        }
        if (!this._hintEl) {
            this._hintEl = document.createElement('div');
            this._hintEl.className = 'flv-drop-hint';
            this.root.appendChild(this._hintEl);
        }
        const name = baseName(hint.dir);
        const text = fileOps.dropMode(hint.e) === 'move'
            ? t('Move to {name}', { name })
            : t('Copy to {name}', { name });
        if (this._hintEl.textContent !== text) this._hintEl.textContent = text;
        // Below the target, to the right of the cursor's drag image.
        const box = el.getBoundingClientRect();
        const rootBox = this.root.getBoundingClientRect();
        const left = Math.max(0, Math.min(box.left - rootBox.left, rootBox.width - 240));
        this._hintEl.style.left = `${left}px`;
        this._hintEl.style.top = `${box.bottom - rootBox.top + 4}px`;
        this._hintEl.hidden = false;
    }

    /** After an operation: show the folder again, with what it made under the cursor. */
    _afterChange(created) {
        const here = (created || []).filter((p) => norm(parentFolder(p)) === norm(this.file.folder));
        this.load({ select: here.length ? here[here.length - 1] : null });
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    sortBy(key) {
        this.sort = this.sort.key === key
            ? { key, descending: !this.sort.descending }
            : { key, descending: key === 'size' || key === 'modified' };
        try { localStorage.setItem(SORT_KEY, JSON.stringify(this.sort)); } catch (_) { /* ignore */ }
        this._drawHead();
        this._render();
    }

    navigate(dir, select = null) {
        if (State.currentDir && !isWithin(dir, State.currentDir)) return;
        this.file.folder = dir;
        this.file.name = baseName(dir);
        this._selectOnly(select);
        this.list.scrollTop = 0;
        if (this.options.onNavigate) this.options.onNavigate();
        this.load({ select });
    }

    goUp() {
        const parent = upFrom(this.file.folder, State.currentDir);
        if (!parent) return;
        this.navigate(parent, this.file.folder);
    }

    async open(entry) {
        if (entry.is_directory) {
            this.navigate(entry.path);
            return;
        }
        const external = externalKind(entry.name);
        if (!external) {
            // Beside the list when the editor is split, so the list stays put.
            if (State.splitMode) State.activePane = State.activePane === 'right' ? 'left' : 'right';
            if (this.options.openFile) this.options.openFile(entry.path);
            return;
        }
        // A program is never started from the editor; show it in the file manager.
        const command = external === 'program' ? 'reveal_in_file_manager' : 'open_with_default_app';
        try {
            await invoke(command, { path: entry.path });
        } catch (e) {
            console.error(`${command} failed`, e);
            if (window.showToast) window.showToast(t('Could not open the file'));
        }
    }

    async newFolder() {
        const made = await fileOps.newFolder(this.file.folder);
        if (made) this._afterChange([made]);
    }

    async newFile() {
        // The new file opens in the editor; the list underneath still shows it.
        const made = await fileOps.newFile(this.file.folder);
        if (made) this._afterChange([made]);
    }

    async copy() {
        const paths = this.selectionInOrder();
        if (!paths.length) return;
        await fileOps.copy(paths);
        this._paintSelection();
    }

    async cut() {
        const paths = this.selectionInOrder();
        if (!paths.length) return;
        await fileOps.cut(paths);
        this._paintSelection();
    }

    async paste(dir = this.file.folder) {
        const done = await fileOps.paste(dir);
        this._afterChange(done);
    }

    async remove(permanent = false) {
        const paths = this.selectionInOrder();
        if (!paths.length) return;
        // Where the cursor goes afterwards: the next row that stays.
        const all = this.sorted.map((x) => x.path);
        const last = Math.max(...paths.map((p) => all.indexOf(p)));
        const next = all.slice(last + 1).find((p) => !paths.includes(p))
            || all.slice(0, last).reverse().find((p) => !paths.includes(p)) || null;
        await fileOps.delete(paths, { permanent });
        this.load({ select: next });
        this.list.focus({ preventScroll: true });
    }

    /** Rename in place: the name turns into a text field (Enter keeps, Escape drops). */
    startRename(path = this.selected) {
        const row = path && this._rowFor(path);
        const label = row && row.querySelector('.flv-label');
        if (!label) return;
        const entry = this.sorted.find((x) => x.path === path);
        this._renaming = true;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input flv-rename';
        input.value = entry.name;
        label.replaceWith(input);
        input.focus();
        // The name without its extension, as Explorer selects it.
        const dot = entry.is_directory ? -1 : entry.name.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);

        let finished = false;
        const finish = async (keep) => {
            if (finished) return;
            finished = true;
            this._renaming = false;
            const name = input.value.trim();
            input.replaceWith(label);
            this.list.focus({ preventScroll: true });
            const renamed = keep && name && name !== entry.name ? await fileOps.rename(path, name) : null;
            this.load({ select: renamed || path });
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('dblclick', (e) => e.stopPropagation());
    }

    _showMenu(e, entry) {
        const paths = entry ? this.selectionInOrder() : [];
        const many = paths.length > 1;
        const count = many ? ` (${paths.length})` : '';
        const target = entry ? entry.path : this.file.folder;
        const items = [];
        if (entry && !many) items.push({ icon: 'file', label: t('Open'), hint: 'Enter', action: () => this.open(entry) }, { type: 'separator' });
        const compare = entry && compareTarget(paths.map((p) => this.sorted.find((x) => x.path === p)).filter(Boolean));
        if (compare) {
            items.push({
                icon: 'compare',
                label: t('Compare: {name}', { name: `${compare.left.name} / ${compare.right.name}` }),
                action: () => (compare.folders
                    ? window.app.compareTwoFolders(compare.left.path, compare.right.path)
                    : window.app.compareTwoFiles(compare.left.path, compare.right.path)),
            }, { type: 'separator' });
        }
        items.push(
            { icon: 'file-plus', label: t('New File'), hint: 'Ctrl+N', action: () => this.newFile() },
            { icon: 'folder-plus', label: t('New Folder'), hint: 'Ctrl+Shift+N', action: () => this.newFolder() },
            { type: 'separator' },
        );
        if (entry) {
            items.push(
                { icon: 'scissors', label: t('Cut') + count, hint: 'Ctrl+X', action: () => this.cut() },
                { icon: 'copy', label: t('Copy') + count, hint: 'Ctrl+C', action: () => this.copy() },
            );
        }
        // On a folder, Paste puts the files into it, as in Explorer.
        const pasteInto = entry && entry.is_directory && !many ? entry.path : this.file.folder;
        items.push({ icon: 'clipboard', label: t('Paste'), hint: 'Ctrl+V', action: () => this.paste(pasteInto) });
        if (entry) {
            if (!many) items.push({ icon: 'pencil', label: t('Rename'), hint: 'F2', action: () => this.startRename(entry.path) });
            items.push({ icon: 'trash', label: t('Delete') + count, hint: 'Delete', action: () => this.remove() });
        }
        items.push(
            { type: 'separator' },
            { icon: 'link', label: t('Copy Path'), action: () => fileOps.copyPaths(entry ? paths : [target], false) },
            { icon: 'link', label: t('Copy Relative Path'), action: () => fileOps.copyPaths(entry ? paths : [target], true) },
        );
        if (this.options.showInTree) items.push({ icon: 'folder', label: t('Show in Tree'), action: () => this.options.showInTree(target) });
        items.push(
            { icon: 'folder-open', label: t('Reveal in File Manager'), action: () => invoke('reveal_in_file_manager', { path: target }).catch((err) => console.error(err)) },
            { icon: 'refresh', label: t('Refresh'), hint: 'F5', action: () => this.refresh() },
        );
        ContextMenu.show(e, items);
    }

    onKey(e) {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && !e.altKey) {
            const k = e.key.toLowerCase();
            const actions = {
                c: () => this.copy(),
                x: () => this.cut(),
                v: () => this.paste(),
                a: () => {
                    this.selection = new Set(this.sorted.map((x) => x.path));
                    this._paintSelection();
                },
                n: () => (e.shiftKey ? this.newFolder() : this.newFile()),
            };
            if (actions[k]) { e.preventDefault(); actions[k](); return; }
        }
        if (e.key === 'Delete' && !ctrl && !e.altKey) { e.preventDefault(); this.remove(e.shiftKey); return; }
        if (isF2(e) && !ctrl && !e.altKey) { e.preventDefault(); this.startRename(); return; }
        if (ctrl || e.metaKey || e.altKey) {
            if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); this.goUp(); }
            // Ctrl+arrows below move the cursor without changing the selection.
            if (!(ctrl && !e.altKey && /^Arrow(Up|Down)$/.test(e.key))) return;
        }
        if (e.key === 'Backspace') { e.preventDefault(); this.goUp(); return; }
        if (e.key === 'Escape' && this.selection.size > 1) {
            e.preventDefault();
            this._selectOnly(this.selected);
            this._paintSelection();
            return;
        }
        if (!this.sorted.length) return;
        const paths = this.sorted.map((x) => x.path);
        const at = paths.indexOf(this.selected);
        const page = Math.max(1, Math.floor(this.list.clientHeight / 24) - 1);
        const moves = {
            ArrowDown: Math.min(paths.length - 1, at + 1),
            ArrowUp: Math.max(0, at - 1),
            Home: 0,
            End: paths.length - 1,
            PageDown: Math.min(paths.length - 1, Math.max(0, at) + page),
            PageUp: Math.max(0, at - page),
        };
        if (e.key in moves) {
            e.preventDefault();
            const to = paths[moves[e.key]];
            if (e.shiftKey) {
                this._selectRange(to);
                this._paintSelection();
                this._scrollToSelected();
            } else if (ctrl) {
                this.selected = to;
                this._paintSelection();
                this._scrollToSelected();
            } else {
                this.select(to);
            }
        } else if (e.key === ' ' && ctrl && at >= 0) {
            e.preventDefault();
            this.clickRow(paths[at], { ctrlKey: true });
        } else if (e.key === 'Enter' && at >= 0) {
            e.preventDefault();
            this.open(this.sorted[at]);
        } else if (e.key.length === 1 && !e.isComposing && !ctrl) {
            const now = Date.now();
            const typed = now - (this._typedAt || 0) < 800 ? (this._typed || '') : '';
            if (e.key === ' ' && !typed) return;
            e.preventDefault();
            this._typed = typed + e.key;
            this._typedAt = now;
            const index = typeAheadIndex(this.sorted.map((x) => x.name), this._typed, at);
            if (index >= 0) this.select(paths[index]);
        }
    }

    // ── What the editor asks of every view ──────────────────────────────────

    focus() { this.list.focus({ preventScroll: true }); }
    getDiagnostics() { return []; }

    destroy() {
        this._token++;
        window.removeEventListener('workspace-files-changed', this._onFilesChanged);
        window.removeEventListener('focus', this._onWindowFocus);
        this.container.classList.remove('folder-list-mode');
        this.container.innerHTML = '';
    }
}
