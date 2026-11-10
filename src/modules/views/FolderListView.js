/**
 * FolderListView — one folder's contents as a file manager lists them, in an
 * editor tab: name, size, date and type, sortable by any of them.
 *
 * The tree in the sidebar is for finding where things are; it is too narrow to
 * compare sizes or dates. There is one such tab (Editor.js showFolderList), and
 * the folder it shows lives on the tab as `file.folder`, so a redraw — switching
 * tabs, splitting the editor — comes back to the same place.
 */
import { invoke } from '@tauri-apps/api/core';
import { State } from '../core/Store.js';
import { t } from '../utils/I18n.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { iconEl, iconForFile } from '../ui/Icons.js';
import { formatSize } from '../ui/LoadingOverlay.js';
import { formatModified, typeAheadIndex } from '../utils/ExplorerTree.js';
import { externalKind } from '../utils/ExternalFiles.js';
import { nativeDragAvailable, startNativeDrag } from '../utils/NativeDrag.js';

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

/** One level up from `dir`, but never above `root` (the workspace). */
export function upFrom(dir, root) {
    const parent = parentFolder(dir);
    if (!parent || !root) return parent;
    const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const top = norm(root);
    const up = norm(parent);
    return up === top || up.startsWith(`${top}/`) ? parent : null;
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
        this.selected = null;
        this.sort = readSort();
        this._token = 0;
        this._build();
        this.load();
    }

    // ── Layout ───────────────────────────────────────────────────────────────

    _build() {
        const c = this.container;
        c.innerHTML = '';
        c.classList.add('folder-list-mode');

        this.root = document.createElement('div');
        this.root.className = 'flv';
        this.widths = readWidths();
        for (const key of COLUMNS) {
            if (this.widths[key]) this.root.style.setProperty(`--flv-${key}`, `${this.widths[key]}px`);
        }

        const bar = document.createElement('div');
        bar.className = 'flv-bar';
        this.upBtn = this._button('arrow-up', t('Up one folder'), () => this.goUp());
        this.pathEl = document.createElement('span');
        this.pathEl.className = 'flv-path';
        this.countEl = document.createElement('span');
        this.countEl.className = 'flv-count';
        bar.append(this.upBtn, this.pathEl, this.countEl,
            this._button('refresh', t('Refresh'), () => this.load()));

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

    // ── Data ─────────────────────────────────────────────────────────────────

    async load() {
        const dir = this.file.folder;
        const token = ++this._token;
        this.pathEl.textContent = String(dir).replace(/\\/g, '/');
        this.pathEl.title = dir;
        this.upBtn.disabled = !upFrom(dir, State.currentDir);
        let entries;
        try {
            entries = await invoke('read_dir_details', { path: dir });
        } catch (e) {
            if (token !== this._token) return;
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
        if (this.file.select) {
            this.selected = this.file.select;
            this.file.select = null;
        }
        this._render();
    }

    _render(message = '') {
        this.sorted = sortEntries(this.entries, this.sort.key, this.sort.descending);
        if (this.selected && !this.sorted.some((x) => x.path === this.selected)) this.selected = null;
        this.countEl.textContent = message ? '' : t('{n} items', { n: this.sorted.length });
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
        this._scrollToSelected();
    }

    _row(entry) {
        const row = document.createElement('div');
        row.className = 'flv-row';
        row.dataset.path = entry.path;
        if (entry.path === this.selected) row.classList.add('selected');
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

        row.addEventListener('click', () => this.select(entry.path));
        row.addEventListener('dblclick', () => this.open(entry));
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.select(entry.path);
            this._showMenu(e, entry);
        });
        row.draggable = nativeDragAvailable();
        row.addEventListener('dragstart', (e) => {
            // Out of the app only: the OS drag carries the file as Explorer would.
            e.preventDefault();
            startNativeDrag([entry.path]).catch((err) => console.error('start_file_drag failed', err));
        });
        return row;
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    select(path) {
        this.selected = path;
        for (const row of this.list.querySelectorAll('.flv-row')) {
            row.classList.toggle('selected', row.dataset.path === path);
        }
        this._scrollToSelected();
        this.list.focus({ preventScroll: true });
    }

    _scrollToSelected() {
        if (!this.selected) return;
        const row = [...this.list.querySelectorAll('.flv-row')].find((r) => r.dataset.path === this.selected);
        if (row) row.scrollIntoView({ block: 'nearest' });
    }

    sortBy(key) {
        this.sort = this.sort.key === key
            ? { key, descending: !this.sort.descending }
            : { key, descending: key === 'size' || key === 'modified' };
        try { localStorage.setItem(SORT_KEY, JSON.stringify(this.sort)); } catch (_) { /* ignore */ }
        this._drawHead();
        this._render();
    }

    navigate(dir, select = null) {
        this.file.folder = dir;
        this.file.name = baseName(dir);
        this.selected = select;
        this.list.scrollTop = 0;
        if (this.options.onNavigate) this.options.onNavigate();
        this.load();
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

    _showMenu(e, entry) {
        const target = entry ? entry.path : this.file.folder;
        const items = [];
        if (entry) items.push({ icon: 'file', label: t('Open'), action: () => this.open(entry) }, { type: 'separator' });
        if (this.options.showInTree) items.push({ icon: 'folder', label: t('Show in Tree'), action: () => this.options.showInTree(target) });
        items.push(
            { icon: 'link', label: t('Copy Path'), action: () => navigator.clipboard.writeText(target) },
            { icon: 'folder-open', label: t('Reveal in File Manager'), action: () => invoke('reveal_in_file_manager', { path: target }).catch((err) => console.error(err)) },
            { type: 'separator' },
            { icon: 'refresh', label: t('Refresh'), action: () => this.load() },
        );
        ContextMenu.show(e, items);
    }

    onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) {
            if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); this.goUp(); }
            return;
        }
        if (e.key === 'Backspace') { e.preventDefault(); this.goUp(); return; }
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
            this.select(paths[moves[e.key]]);
        } else if (e.key === 'Enter' && at >= 0) {
            e.preventDefault();
            this.open(this.sorted[at]);
        } else if (e.key.length === 1 && !e.isComposing) {
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
        this.container.classList.remove('folder-list-mode');
        this.container.innerHTML = '';
    }
}
