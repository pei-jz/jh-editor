import { t } from '../utils/I18n.js';
import { iconEl, iconForFile } from './Icons.js';

/**
 * PathCrumbMenu.js — the drop-down under a folder in the title bar's path.
 *
 * The title bar already showed where the file lives as clickable crumbs, but a
 * click could only reveal that folder in the explorer. Now it lists what is
 * IN the folder: open a sibling file, or step into a subfolder (and back up
 * with the ".." row) without leaving the keyboard or the title bar. Revealing
 * the folder in the explorer is still the first row.
 *
 * Typing filters the list; ↑↓ and Enter work as in the palette.
 */

let popup = null;
let state = null;   // { dir, entries, filter, active, opts }

function sortEntries(entries) {
    return entries.slice().sort((a, b) =>
        (a.type === 'DIRECTORY' ? 0 : 1) - (b.type === 'DIRECTORY' ? 0 : 1)
        || a.entry.localeCompare(b.entry, undefined, { sensitivity: 'base', numeric: true }));
}

function parentOf(dir) {
    const d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const at = d.lastIndexOf('/');
    if (at <= 0) return null;
    const up = d.slice(0, at);
    // "C:" alone is a drive, not a folder that can be listed as written.
    return /^[a-zA-Z]:$/.test(up) ? up + '/' : up;
}

function baseName(dir) {
    const d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return d.slice(d.lastIndexOf('/') + 1) || d;
}

export function hide() {
    if (!popup) return;
    popup.remove();
    popup = null;
    state = null;
    window.removeEventListener('mousedown', onOutside, true);
}

function onOutside(e) {
    if (popup && !popup.contains(e.target)) hide();
}

function rowsNow() {
    const q = state.filter.toLowerCase();
    const list = state.entries.filter((e) => !q || e.entry.toLowerCase().includes(q));
    const rows = [];
    if (!q) {
        rows.push({ kind: 'reveal', label: t('Show in Explorer'), icon: 'folder-open' });
        const up = parentOf(state.dir);
        if (up) rows.push({ kind: 'up', label: '..', icon: 'arrow-up', path: up });
    }
    for (const e of list) {
        rows.push({
            kind: e.type === 'DIRECTORY' ? 'dir' : 'file',
            label: e.entry,
            icon: iconForFile(e.entry, e.type === 'DIRECTORY'),
            path: e.path,
        });
    }
    return rows;
}

function paint() {
    const listEl = popup.querySelector('.crumb-menu-list');
    const titleEl = popup.querySelector('.crumb-menu-title');
    titleEl.textContent = baseName(state.dir);
    titleEl.title = state.dir;
    const rows = rowsNow();
    state.rows = rows;
    state.active = Math.max(0, Math.min(state.active, rows.length - 1));
    listEl.replaceChildren();
    if (state.loading) {
        const p = document.createElement('div');
        p.className = 'crumb-menu-empty';
        p.textContent = t('Loading…');
        listEl.appendChild(p);
        return;
    }
    rows.forEach((r, i) => {
        const row = document.createElement('div');
        row.className = `crumb-menu-item crumb-menu-${r.kind}`;
        if (i === state.active) row.classList.add('is-active');
        const ico = iconEl(r.icon, { size: 13 });
        const label = document.createElement('span');
        label.className = 'crumb-menu-label';
        label.textContent = r.label;
        row.append(ico, label);
        if (r.kind === 'dir') row.appendChild(iconEl('chevron-right', { size: 11 }));
        if (r.kind === 'file' && state.opts.currentPath
            && String(r.path).replace(/\\/g, '/').toLowerCase() === state.opts.currentPath.toLowerCase()) {
            row.classList.add('is-current');
        }
        row.addEventListener('mousemove', () => {
            if (state.active === i) return;
            state.active = i;
            listEl.querySelectorAll('.crumb-menu-item').forEach((el, k) => el.classList.toggle('is-active', k === i));
        });
        row.addEventListener('click', () => choose(r));
        listEl.appendChild(row);
    });
    // "Show in Explorer" and ".." are always there, so say why nothing else is.
    if (!rows.some((r) => r.kind === 'dir' || r.kind === 'file')) {
        const p = document.createElement('div');
        p.className = 'crumb-menu-empty';
        p.textContent = state.error ? t('This folder could not be read')
            : state.filter ? t('No matching files found') : t('This folder is empty.');
        listEl.appendChild(p);
    }
    const active = listEl.querySelector('.is-active');
    if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' });
}

async function load(dir) {
    state.dir = dir;
    state.filter = '';
    state.active = 0;
    state.loading = true;
    state.error = false;
    const input = popup.querySelector('.crumb-menu-filter');
    input.value = '';
    paint();
    const asked = dir;
    try {
        const entries = await state.opts.list(dir);
        if (!state || state.dir !== asked) return;
        state.entries = sortEntries(entries || []);
    } catch (e) {
        if (!state || state.dir !== asked) return;
        state.entries = [];
        state.error = true;
    }
    state.loading = false;
    // Start on the file being edited, so ↑↓ steps to its neighbours.
    const cur = state.opts.currentPath;
    if (cur) {
        const at = rowsNow().findIndex((r) => r.kind === 'file' && String(r.path).replace(/\\/g, '/').toLowerCase() === cur.toLowerCase());
        if (at >= 0) state.active = at;
    }
    paint();
}

function choose(row) {
    if (!row) return;
    if (row.kind === 'dir' || row.kind === 'up') { load(row.path); return; }
    const { opts, dir } = state;
    hide();
    if (row.kind === 'reveal') opts.reveal(dir);
    else if (row.kind === 'file') opts.open(row.path);
}

function onKey(e) {
    if (!state || e.isComposing) return;
    const rows = state.rows || [];
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (!rows.length) return;
        state.active = (state.active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        paint();
        return;
    }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); choose(rows[state.active]); return; }
    if (e.key === 'Backspace' && !e.target.value) {
        // On an empty filter, Backspace goes up a folder, as in a file dialog.
        e.preventDefault();
        e.stopPropagation();
        const up = parentOf(state.dir);
        if (up) load(up);
        return;
    }
    // Everything else is typing; keep the app's shortcuts out of it.
    e.stopPropagation();
}

/**
 * Open the menu under `anchor` for `dir`.
 * opts: list(dir) → Promise<[{entry, type, path}]>, open(path), reveal(dir),
 * currentPath (the file being edited, to mark and start on).
 */
export function show(anchor, dir, opts) {
    hide();
    popup = document.createElement('div');
    popup.className = 'crumb-menu';
    popup.setAttribute('role', 'dialog');

    const head = document.createElement('div');
    head.className = 'crumb-menu-head';
    const title = document.createElement('span');
    title.className = 'crumb-menu-title';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'crumb-menu-filter';
    input.placeholder = t('Filter…');
    input.spellcheck = false;
    input.autocomplete = 'off';
    head.append(title, input);

    const list = document.createElement('div');
    list.className = 'crumb-menu-list';
    list.setAttribute('role', 'listbox');
    popup.append(head, list);
    document.body.appendChild(popup);

    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 300))}px`;
    popup.style.top = `${rect.bottom + 4}px`;

    state = { dir, entries: [], filter: '', active: 0, opts: { ...opts, currentPath: String(opts.currentPath || '').replace(/\\/g, '/') } };
    input.addEventListener('input', () => { state.filter = input.value; state.active = 0; paint(); });
    popup.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onOutside, true);
    input.focus();
    load(dir);
}

export function isOpen() {
    return !!popup;
}

export const PathCrumbMenu = { show, hide, isOpen };
export default PathCrumbMenu;
