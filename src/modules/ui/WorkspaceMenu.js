/**
 * WorkspaceMenu.js — the explorer's folder button as a workspace switcher.
 *
 * The button used to go straight to the folder picker, so moving between two
 * projects meant navigating the file system every time, while the list of
 * recent workspaces sat on the Welcome screen where nobody sees it once a
 * project is open. Now the button drops down that list: one click to switch,
 * and "Open Folder…" at the bottom for anything else.
 *
 * Each row: the folder's name, its path underneath (two folders called `src`
 * are common), ⧉ to open it in a new window, × to drop it from the history.
 * The current workspace is marked rather than hidden, so the list reads the
 * same every time it opens.
 *
 * Keys: ↑ ↓ move, Enter opens, Delete removes, Escape closes. The menu marks
 * itself `data-shortcut-keys="own"` so ShortcutManager leaves those keys to it.
 */
import { t } from '../utils/I18n.js';
import { RecentFiles, sameWorkspace } from '../utils/RecentFiles.js';
import { State } from '../core/Store.js';

let openMenu = null;

/** The last path segment, whichever slash the path uses. */
function folderName(path) {
    const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

function injectStyles() {
    if (document.getElementById('ws-menu-styles')) return;
    const style = document.createElement('style');
    style.id = 'ws-menu-styles';
    style.textContent = `
    .ws-menu {
        position: fixed; z-index: 3000; min-width: 260px; max-width: min(420px, 90vw);
        max-height: 70vh; overflow-y: auto; padding: 4px 0;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 6px;
        box-shadow: var(--shadow-md, 0 4px 14px rgba(0,0,0,0.18));
        font-size: 12px; user-select: none;
    }
    .ws-menu-title {
        padding: 4px 12px 6px; font-size: 11px; font-weight: 600;
        color: var(--text-secondary, inherit); opacity: .8;
    }
    .ws-menu-item {
        display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 12px;
        cursor: pointer; outline: none;
    }
    .ws-menu-item:hover, .ws-menu-item.focused { background: var(--hover-color); }
    .ws-menu-item.current { cursor: default; }
    .ws-menu-mark { flex: 0 0 12px; color: var(--primary-color); font-weight: 700; }
    .ws-menu-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
    .ws-menu-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ws-menu-path {
        font-size: 10.5px; opacity: .65; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; direction: rtl; text-align: left;
    }
    .ws-menu-btn {
        flex: 0 0 auto; width: 22px; height: 22px; padding: 0; border: none; border-radius: 4px;
        background: transparent; color: inherit; cursor: pointer; opacity: 0;
        font-size: 13px; line-height: 1;
    }
    .ws-menu-item:hover .ws-menu-btn, .ws-menu-item.focused .ws-menu-btn { opacity: .6; }
    .ws-menu-btn:hover { opacity: 1 !important; background: var(--bg-active, var(--border-color)); }
    .ws-menu-empty { padding: 6px 12px; opacity: .6; font-style: italic; }
    .ws-menu-sep { border-top: 1px solid var(--border-color); margin: 4px 0; }
    `;
    document.head.appendChild(style);
}

export function closeWorkspaceMenu() {
    if (openMenu) openMenu.close();
}

/**
 * Drop the menu down from `anchor`. Clicking the button again closes it.
 *
 * @param {HTMLElement} anchor
 * @param {{ onSwitch: (path: string) => any,
 *           onOpenFolder: () => any,
 *           onOpenInNewWindow?: (path: string) => any }} handlers
 */
export function toggleWorkspaceMenu(anchor, handlers) {
    if (openMenu && openMenu.anchor === anchor) { closeWorkspaceMenu(); return; }
    closeWorkspaceMenu();
    injectStyles();

    const menu = document.createElement('div');
    menu.className = 'ws-menu';
    menu.setAttribute('role', 'menu');
    menu.dataset.shortcutKeys = 'own';
    menu.tabIndex = -1;

    let rows = [];      // focusable rows, in order
    let focusIndex = -1;

    const close = () => {
        window.removeEventListener('mousedown', onOutside, true);
        window.removeEventListener('blur', close);
        window.removeEventListener('resize', close);
        menu.remove();
        if (openMenu && openMenu.menu === menu) openMenu = null;
    };

    const setFocus = (i) => {
        if (!rows.length) return;
        focusIndex = (i + rows.length) % rows.length;
        rows.forEach((r, k) => r.classList.toggle('focused', k === focusIndex));
        rows[focusIndex].focus({ preventScroll: true });
        if (typeof rows[focusIndex].scrollIntoView === 'function') {
            rows[focusIndex].scrollIntoView({ block: 'nearest' });
        }
    };

    const render = () => {
        menu.innerHTML = '';
        rows = [];

        const title = document.createElement('div');
        title.className = 'ws-menu-title';
        title.textContent = t('Recent Workspaces');
        menu.appendChild(title);

        const recents = RecentFiles.getWorkspaces();
        if (!recents.length) {
            const empty = document.createElement('div');
            empty.className = 'ws-menu-empty';
            empty.textContent = t('No recent workspaces');
            menu.appendChild(empty);
        }

        for (const path of recents) {
            const isCurrent = sameWorkspace(path, State.currentDir);
            const row = document.createElement('div');
            row.className = 'ws-menu-item' + (isCurrent ? ' current' : '');
            row.setAttribute('role', 'menuitem');
            row.tabIndex = -1;
            row.title = isCurrent ? `${path}\n${t('Current workspace')}` : path;
            row._path = path;
            row._current = isCurrent;

            const mark = document.createElement('span');
            mark.className = 'ws-menu-mark';
            mark.textContent = isCurrent ? '✓' : '';

            const text = document.createElement('span');
            text.className = 'ws-menu-text';
            const name = document.createElement('span');
            name.className = 'ws-menu-name';
            name.textContent = folderName(path);
            const sub = document.createElement('span');
            sub.className = 'ws-menu-path';
            // rtl keeps the END of a long path (the part that differs) in view;
            // the bidi isolate stops it reordering the slashes.
            sub.textContent = `⁦${path}⁩`;
            text.append(name, sub);

            row.append(mark, text);

            if (handlers.onOpenInNewWindow) {
                const win = document.createElement('button');
                win.type = 'button';
                win.className = 'ws-menu-btn';
                win.textContent = '⧉';
                win.title = t('Open in a new window');
                win.tabIndex = -1;
                win.onclick = (e) => {
                    e.stopPropagation();
                    close();
                    handlers.onOpenInNewWindow(path);
                };
                row.appendChild(win);
            }
            if (!isCurrent) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'ws-menu-btn';
                del.textContent = '×';
                del.title = t('Remove from history');
                del.tabIndex = -1;
                del.onclick = (e) => { e.stopPropagation(); remove(path); };
                row.appendChild(del);
            }

            row.onclick = () => activate(row);
            row.onmousemove = () => {
                const i = rows.indexOf(row);
                if (i !== focusIndex) setFocus(i);
            };
            menu.appendChild(row);
            rows.push(row);
        }

        const sep = document.createElement('div');
        sep.className = 'ws-menu-sep';
        menu.appendChild(sep);

        const openRow = document.createElement('div');
        openRow.className = 'ws-menu-item ws-menu-open';
        openRow.setAttribute('role', 'menuitem');
        openRow.tabIndex = -1;
        const openMark = document.createElement('span');
        openMark.className = 'ws-menu-mark';
        const openText = document.createElement('span');
        openText.className = 'ws-menu-text';
        openText.textContent = `${t('Open Folder')}…`;
        openRow.append(openMark, openText);
        openRow._open = true;
        openRow.onclick = () => activate(openRow);
        openRow.onmousemove = () => {
            const i = rows.indexOf(openRow);
            if (i !== focusIndex) setFocus(i);
        };
        menu.appendChild(openRow);
        rows.push(openRow);
    };

    const activate = (row) => {
        if (row._open) { close(); handlers.onOpenFolder(); return; }
        if (row._current) return;           // already here
        close();
        handlers.onSwitch(row._path);
    };

    const remove = (path) => {
        RecentFiles.forgetWorkspace(path);
        const keep = focusIndex;
        render();
        position();
        setFocus(Math.min(keep, rows.length - 1));
    };

    const position = () => {
        let r = anchor.getBoundingClientRect();
        // Opened from the keyboard with the explorer hidden: the button has no
        // box, so drop the menu from the top-left, under the title bar.
        if (!r.width && !r.height) {
            const bar = document.getElementById('custom-titlebar');
            const top = bar ? bar.getBoundingClientRect().bottom : 0;
            r = { left: 8, right: 8 + 300, top, bottom: top };
        }
        const m = menu.getBoundingClientRect();
        // Under the button, right edges aligned; kept on screen.
        let left = r.right - m.width;
        left = Math.max(4, Math.min(left, window.innerWidth - m.width - 4));
        let top = r.bottom + 4;
        if (top + m.height > window.innerHeight - 4) top = Math.max(4, r.top - m.height - 4);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    };

    menu.addEventListener('keydown', (e) => {
        const k = e.key;
        // Its own shortcut closes it again. ShortcutManager stays out of the
        // menu's keys, so the toggle has to be answered here.
        if ((e.ctrlKey || e.metaKey) && e.altKey && (e.code === 'KeyO' || String(k).toLowerCase() === 'o')) {
            e.preventDefault();
            e.stopPropagation();
            close();
            return;
        }
        if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
            e.preventDefault();
            if (k === 'ArrowDown') setFocus(focusIndex + 1);
            else if (k === 'ArrowUp') setFocus(focusIndex - 1);
            else if (k === 'Home') setFocus(0);
            else setFocus(rows.length - 1);
        } else if (k === 'Enter' || k === ' ') {
            e.preventDefault();
            if (rows[focusIndex]) activate(rows[focusIndex]);
        } else if (k === 'Delete') {
            const row = rows[focusIndex];
            if (row && row._path && !row._current) { e.preventDefault(); remove(row._path); }
        } else if (k === 'Escape' || k === 'Tab') {
            e.preventDefault();
            close();
            anchor.focus();
        }
        e.stopPropagation();
    });

    const onOutside = (e) => {
        if (menu.contains(e.target)) return;
        // The button's own click toggles; let it, rather than close-then-reopen.
        if (anchor.contains(e.target)) return;
        close();
    };

    render();
    document.body.appendChild(menu);
    position();
    window.addEventListener('mousedown', onOutside, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);

    // Start on the first workspace that is not this one — the likeliest pick.
    const first = rows.findIndex((r) => r._path && !r._current);
    setFocus(first >= 0 ? first : rows.length - 1);

    openMenu = { menu, anchor, close };
}
