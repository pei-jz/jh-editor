/**
 * FolderJumpPanel.js — the folder search itself, used in two places: as an
 * overlay inside the editor (Ctrl+Alt+J) and filling the window the global
 * hotkey brings up (src/folder-jump.js).
 *
 * Enter shows the folder in Explorer, Ctrl+Enter opens it as a workspace,
 * Alt+Enter opens a terminal there. What opening a workspace means differs
 * between the two hosts, so the host passes that in; the rest is the same.
 *
 * Marks itself `data-shortcut-keys="own"` so ShortcutManager leaves its keys alone.
 */
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { t } from '../utils/I18n.js';
import { icon as svgIcon, iconEl } from './Icons.js';
import { splitRelRanges } from '../utils/FileSearchRank.js';
import {
    forgetFolder, folderName, getPinned, isPinned, knownFolders, looksLikePath, pin,
    prepareFolderIndex, recordJump, searchFolders, unpin,
} from '../utils/FolderJump.js';

/** How long a walk's result is used without starting another behind it. */
const INDEX_TTL_MS = 5 * 60 * 1000;

let index = { key: '', entries: [], partial: false, at: 0, pending: null };

/**
 * Walk the pinned folders, unless a recent walk of the same list is still good.
 * The old result stays searchable meanwhile: a slow share should make the list
 * a little stale, not make the search box wait.
 *
 * @returns {Promise<void>|null} the walk in flight, or null when none is needed
 */
function refreshIndex(roots, force = false) {
    const key = JSON.stringify(roots);
    if (index.pending && index.pending.key === key) return index.pending;
    if (!force && index.key === key && Date.now() - index.at < INDEX_TTL_MS) return null;
    if (!roots.length) {
        index = { key, entries: [], partial: false, at: Date.now(), pending: null };
        return null;
    }
    const pending = invoke('list_subfolders', { roots }).then((result) => {
        if (index.pending !== pending) return; // the list changed while walking
        index = {
            key,
            entries: prepareFolderIndex(result.folders),
            partial: result.partial,
            at: Date.now(),
            pending: null,
        };
    }, (err) => {
        if (index.pending === pending) index.pending = null;
        throw err;
    });
    pending.key = key;
    index.pending = pending;
    return pending;
}

function injectStyles() {
    if (document.getElementById('folder-jump-styles')) return;
    const style = document.createElement('style');
    style.id = 'folder-jump-styles';
    style.textContent = `
    .fj-panel {
        display: flex; flex-direction: column; min-height: 0; height: 100%;
        background: var(--bg-color); color: var(--text-color); font-size: 13px;
    }
    .fj-search { position: relative; display: flex; align-items: center; flex: 0 0 auto; }
    .fj-search-icon { position: absolute; left: 12px; display: inline-flex; opacity: .5; }
    .fj-input {
        width: 100%; height: 44px; padding: 0 12px 0 35px; box-sizing: border-box;
        border: none; border-bottom: 1px solid var(--border-color); outline: none;
        background: transparent; color: inherit; font-size: 15px; font-family: inherit;
    }
    .fj-status {
        flex: 0 0 auto; display: flex; align-items: center; gap: 6px; min-height: 20px;
        padding: 2px 12px; font-size: 11px; opacity: .65;
    }
    .fj-status.error { color: var(--error-color, #c62828); opacity: 1; }
    .fj-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
    .fj-row {
        display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 12px; cursor: pointer;
    }
    .fj-row.selected { background: var(--hover-color); }
    .fj-row-icon { flex: 0 0 auto; display: inline-flex; opacity: .8; }
    .fj-row-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
    .fj-row-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fj-row-path { font-size: 11px; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fj-hit { background: rgba(var(--primary-rgb, 0, 122, 204), 0.4); border-radius: 2px; }
    .fj-btn {
        flex: 0 0 auto; width: 24px; height: 24px; padding: 0; border: none; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
        background: transparent; color: inherit; cursor: pointer; opacity: 0;
    }
    .fj-row:hover .fj-btn, .fj-row.selected .fj-btn, .fj-btn.on { opacity: .6; }
    .fj-btn.on { color: var(--primary-color); }
    .fj-btn:hover { opacity: 1 !important; background: var(--bg-active, var(--border-color)); }
    .fj-empty { padding: 16px 12px; opacity: .65; line-height: 1.6; }
    .fj-foot {
        flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
        padding: 6px 12px; border-top: 1px solid var(--border-color); font-size: 11px;
    }
    .fj-hint { opacity: .7; white-space: nowrap; }
    .fj-hint kbd { font: inherit; font-weight: 600; }
    .fj-add {
        margin-left: auto; padding: 2px 8px; border: 1px solid var(--border-color); border-radius: 4px;
        background: transparent; color: inherit; cursor: pointer; font: inherit;
    }
    .fj-overlay {
        position: fixed; inset: 0; z-index: 3000; display: flex; justify-content: center;
        align-items: flex-start; padding-top: 12vh; background: rgba(0, 0, 0, .25);
    }
    .fj-overlay-box {
        width: min(640px, 92vw); height: min(460px, 76vh); overflow: hidden;
        border: 1px solid var(--border-color); border-radius: 8px;
        box-shadow: var(--shadow-md, 0 4px 14px rgba(0,0,0,0.18));
    }
    `;
    document.head.appendChild(style);
}

/** `text` into `parent` with the [start, end) ranges marked; never parsed as markup. */
function appendHighlighted(parent, text, ranges) {
    let at = 0;
    for (const [start, end] of ranges) {
        if (start > at) parent.appendChild(document.createTextNode(text.slice(at, start)));
        const mark = document.createElement('span');
        mark.className = 'fj-hit';
        mark.textContent = text.slice(start, end);
        parent.appendChild(mark);
        at = end;
    }
    if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
}

/**
 * @param {{ openWorkspace: (path: string) => any,
 *           openInNewWindow?: (path: string) => any,
 *           pickFolder?: () => Promise<string|null>,
 *           close: () => any }} host
 *        `pickFolder`: only where a system dialog can open without the panel
 *        losing focus and closing, which rules out the jump window.
 * @returns {{ element: HTMLElement, reset: () => void }}
 */
export function createFolderJumpPanel(host) {
    injectStyles();

    const panel = document.createElement('div');
    panel.className = 'fj-panel';
    panel.dataset.shortcutKeys = 'own';

    const search = document.createElement('div');
    search.className = 'fj-search';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'fj-search-icon';
    searchIcon.appendChild(iconEl('search', { size: 14 }));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fj-input';
    input.placeholder = t('Folder name or path…');
    input.spellcheck = false;
    search.append(searchIcon, input);

    const status = document.createElement('div');
    status.className = 'fj-status';
    const list = document.createElement('ul');
    list.className = 'fj-list';

    const foot = document.createElement('div');
    foot.className = 'fj-foot';
    const hints = [
        ['Enter', t('Explorer')],
        ['Ctrl+Enter', t('Workspace')],
        ...(host.openInNewWindow ? [['Shift+Enter', t('New Window')]] : []),
        ['Alt+Enter', t('Terminal')],
        ['Ctrl+C', t('Copy path')],
        ['Ctrl+D', t('Pin')],
    ];
    for (const [key, label] of hints) {
        const hint = document.createElement('span');
        hint.className = 'fj-hint';
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        hint.append(kbd, ` ${label}`);
        foot.appendChild(hint);
    }
    if (host.pickFolder) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'fj-add';
        add.textContent = `${t('Add Folder')}…`;
        add.onclick = async () => {
            const folder = await host.pickFolder();
            if (folder) pin(folder);
            input.focus();
            refreshAndRender();
        };
        foot.appendChild(add);
    }
    panel.append(search, status, list, foot);

    let results = [];
    let selected = 0;
    let known = [];
    let directHit = null;   // a typed path that turned out to be a real folder
    let renderSeq = 0;

    const showStatus = (text, isError = false) => {
        status.classList.toggle('error', isError);
        status.textContent = text;
    };

    const showIndexStatus = () => {
        if (index.pending) showStatus(t('Searching registered folders…'));
        else if (index.partial) showStatus(t('Only part of the registered folders could be searched (too many folders).'));
        else showStatus(index.entries.length ? t('{n} folders', { n: index.entries.length.toLocaleString() }) : '');
    };

    const select = (i) => {
        if (!results.length) return;
        selected = (i + results.length) % results.length;
        [...list.children].forEach((row, k) => {
            row.classList.toggle('selected', k === selected);
            if (k === selected && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
        });
    };

    const renderList = () => {
        list.innerHTML = '';
        if (!results.length) {
            const empty = document.createElement('li');
            empty.className = 'fj-empty';
            empty.textContent = input.value.trim()
                ? t('No matching folders.')
                : t('Open a folder once, or pin one with Ctrl+D, and it appears here. The folders below a pinned folder are searched too.');
            list.appendChild(empty);
            return;
        }
        results.forEach((hit, i) => {
            const path = hit.item.path;
            const row = document.createElement('li');
            row.className = 'fj-row' + (i === selected ? ' selected' : '');
            row.title = path;

            const rowIcon = document.createElement('span');
            rowIcon.className = 'fj-row-icon';
            rowIcon.innerHTML = svgIcon('folder', { size: 16 });

            const text = document.createElement('span');
            text.className = 'fj-row-text';
            const name = document.createElement('span');
            name.className = 'fj-row-name';
            const sub = document.createElement('span');
            sub.className = 'fj-row-path';
            const split = splitRelRanges(hit.relRanges, hit.rel, hit.name);
            appendHighlighted(name, hit.name, hit.nameRanges.length ? hit.nameRanges : split.nameRanges);
            // The folder it lives in: the name is already on the line above.
            const parent = hit.rel.length > hit.name.length ? hit.rel.slice(0, hit.rel.length - hit.name.length - 1) : hit.rel;
            appendHighlighted(sub, parent, split.dirRanges);
            text.append(name, sub);

            const pinned = isPinned(path);
            const pinBtn = document.createElement('button');
            pinBtn.type = 'button';
            pinBtn.className = 'fj-btn' + (pinned ? ' on' : '');
            pinBtn.title = pinned ? t('Unpin') : t('Pin');
            pinBtn.tabIndex = -1;
            pinBtn.innerHTML = svgIcon('pin', { size: 13 });
            pinBtn.onclick = (e) => { e.stopPropagation(); togglePin(path); };
            row.append(rowIcon, text, pinBtn);

            if (hit.item.source === 'recent') {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'fj-btn';
                del.title = t('Remove from history');
                del.tabIndex = -1;
                del.innerHTML = svgIcon('close', { size: 13 });
                del.onclick = (e) => { e.stopPropagation(); forget(path); };
                row.appendChild(del);
            }

            row.onclick = (e) => run(hit.item.path, e);
            row.onmousemove = () => { if (selected !== i) select(i); };
            list.appendChild(row);
        });
    };

    const rerank = () => {
        results = searchFolders(input.value, known, index.entries);
        if (directHit) {
            const key = directHit.replace(/\\/g, '/').toLowerCase();
            const rest = results.filter((r) => r.rel.toLowerCase() !== key);
            results = [{
                item: { path: directHit, name: folderName(directHit), source: 'index' },
                name: folderName(directHit),
                rel: directHit.replace(/\\/g, '/'),
                nameRanges: [],
                relRanges: [],
            }, ...rest];
        }
        selected = Math.min(selected, Math.max(0, results.length - 1));
        renderList();
    };

    /** A typed full path counts as a result if the folder exists. */
    const checkTypedPath = async () => {
        const seq = ++renderSeq;
        const query = input.value.trim();
        directHit = null;
        if (!looksLikePath(query)) return;
        try {
            const path = await invoke('expand_env_path', { path: query });
            const isDir = await invoke('path_is_dir', { path });
            if (seq !== renderSeq) return; // typed on
            if (isDir) {
                directHit = path;
                selected = 0;
                rerank();
            }
        } catch (_) { /* then it is only a search term */ }
    };

    const refreshAndRender = () => {
        known = knownFolders();
        rerank();
        const walk = refreshIndex(getPinned());
        showIndexStatus();
        if (walk) {
            walk.then(() => {
                if (!panel.isConnected) return;
                rerank();
                showIndexStatus();
            }, (err) => {
                console.error('Folder index failed:', err);
                showStatus(t('Could not search the registered folders.'), true);
            });
        }
    };

    const togglePin = (path) => {
        if (isPinned(path)) unpin(path);
        else pin(path);
        refreshAndRender();
    };

    const forget = (path) => {
        forgetFolder(path);
        refreshAndRender();
    };

    /** Keep the panel open and say why when the folder cannot be opened. */
    const attempt = async (path, action) => {
        try {
            await action();
            recordJump(path);
            host.close();
        } catch (err) {
            console.error('Folder Jump:', err);
            showStatus(t('Could not open this folder: {path}', { path }), true);
        }
    };

    const run = (path, e) => {
        if (e.ctrlKey || e.metaKey) return attempt(path, () => host.openWorkspace(path));
        if (e.shiftKey && host.openInNewWindow) return attempt(path, () => host.openInNewWindow(path));
        if (e.altKey) return attempt(path, () => invoke('open_terminal_at', { path }));
        return attempt(path, () => invoke('open_folder_in_explorer', { path }));
    };

    input.addEventListener('input', () => {
        selected = 0;
        checkTypedPath();
        rerank();
    });

    panel.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        e.stopPropagation();
        const current = results[selected]?.item.path;
        const noSelection = input.selectionStart === input.selectionEnd;

        if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
            e.preventDefault();
            select(selected + 1);
        } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
            e.preventDefault();
            select(selected - 1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (current) run(current, e);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            host.close();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
            e.preventDefault();
            if (current) togglePin(current);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && noSelection && current) {
            // Text selected in the box is copied the ordinary way.
            e.preventDefault();
            writeText(current.replace(/\//g, '\\')).then(() => {
                recordJump(current);
                showStatus(t('Copied: {path}', { path: current }));
            }, () => showStatus(t('Could not copy the path.'), true));
        } else if (e.key === 'Delete' && !input.value && results[selected]?.item.source === 'recent') {
            e.preventDefault();
            forget(current);
        }
    });

    const reset = () => {
        input.value = '';
        directHit = null;
        selected = 0;
        refreshAndRender();
        input.focus();
    };

    return { element: panel, reset };
}

let overlay = null;

export function closeFolderJumpOverlay() {
    if (!overlay) return;
    overlay.element.remove();
    const back = overlay.returnFocus;
    overlay = null;
    if (back && back.isConnected) back.focus();
}

/**
 * The search as an overlay in this window; pressing its key again closes it.
 *
 * @param {{ openWorkspace: (path: string) => any,
 *           openInNewWindow?: (path: string) => any,
 *           pickFolder?: () => Promise<string|null> }} handlers
 */
export function toggleFolderJumpOverlay(handlers) {
    if (overlay) { closeFolderJumpOverlay(); return; }

    const element = document.createElement('div');
    element.className = 'fj-overlay';
    const box = document.createElement('div');
    box.className = 'fj-overlay-box';
    const panel = createFolderJumpPanel({ ...handlers, close: closeFolderJumpOverlay });
    box.appendChild(panel.element);
    element.appendChild(box);
    element.addEventListener('mousedown', (e) => {
        if (e.target === element) closeFolderJumpOverlay();
    });
    // Its own key closes it. ShortcutManager stays out of the panel's keys, so
    // the toggle has to be answered here.
    element.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === 'KeyJ') {
            e.preventDefault();
            e.stopPropagation();
            closeFolderJumpOverlay();
        }
    }, true);

    overlay = { element, returnFocus: document.activeElement };
    document.body.appendChild(element);
    panel.reset();
}
