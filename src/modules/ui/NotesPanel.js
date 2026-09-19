/**
 * NotesPanel.js — the way in to your notes.
 *
 * This used to be the notes themselves: a modal with a list down one side and
 * its own textarea and preview on the other, over notes kept in localStorage.
 * That made the modal the ONLY place a note could be edited — no syntax
 * highlighting, no block view, no outline, no split, no search, no save to
 * disk. Notes are Markdown documents and the app already has a Markdown editor.
 *
 * So the notes are files now (see utils/Notes.js) and this is a browser over
 * them: pick one and it opens as an ordinary tab, where everything works. A
 * modal is the right shape for choosing something and the wrong shape for
 * working in it.
 */

import { iconEl } from './Icons.js';
import { t } from '../utils/I18n.js';
import { showConfirm, showPrompt, showAlert } from './Dialog.js';
import { invoke } from '@tauri-apps/api/core';
import { listDaily, listQuick, createQuick, renameNote, migrateQuickNotes } from '../utils/Notes.js';
import { retargetOpenFile } from '../core/Editor.js';
import { DailyNotes } from '../utils/DailyNotes.js';

let _panel = null;

function fmtWhen(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString();
}

/** Open `path` as a normal editor tab and get out of the way. */
async function openNote(path) {
    NotesPanel.close();
    if (window.app?.openFile) await window.app.openFile(path);
}

/**
 * Ask for a name and make a quick note with it.
 *
 * Cancelling the prompt cancels the note — someone who backs out of naming a
 * thing did not ask for the thing. Leaving it EMPTY is different: that is "I
 * don't care", and it gets the timestamp the notes used to be stuck with.
 */
async function newQuickNote() {
    const name = await showPrompt(t('What is this note about?'), {
        title: t('New Quick Note'),
        placeholder: t('Leave blank to name it by the time'),
        okLabel: t('Create'),
    });
    if (name === null) return null;       // cancelled
    const trimmed = String(name).trim();
    // The name is the title too, so the file opens with its heading already on.
    return createQuick(trimmed ? `# ${trimmed}\n\n` : '', trimmed);
}

export const NotesPanel = {
    /** Open the browser. `create` makes a new quick note and opens it instead. */
    async open({ create = false } = {}) {
        // Ctrl+Alt+M goes straight to a new note; the browser is not in the way
        // of it, and backing out of the name prompt backs out of the whole
        // thing rather than dumping you in a list you did not ask for.
        if (create) {
            const path = await newQuickNote();
            if (path && window.app?.openFile) await window.app.openFile(path);
            return;
        }
        // Anything still in localStorage from the modal days comes across the
        // first time the browser is opened, so it is not simply missing.
        const moved = await migrateQuickNotes();
        if (moved > 0 && window.showToast) {
            window.showToast(t('Moved {n} note(s) into files', { n: moved }));
        }
        showPanel();
    },

    close() {
        if (_panel) { _panel.remove(); _panel = null; }
    },
};

function showPanel() {
    if (_panel) _panel.remove();

    // Quick notes are what "my notes" means, and the panel opens on them every
    // time — not on whichever tab was left showing last. A daily note is a
    // particular day's page and you reach it by saying so: the Daily tab, the
    // Today's Note button, or Ctrl+Click / right-click on the notes icon.
    //
    // These live here rather than at module scope so the panel cannot open
    // remembering a filter, a cursor row or a tab from an hour ago.
    let tab = 'quick';
    let rows = [];
    let focused = 0;

    const overlay = document.createElement('div');
    overlay.className = 'notes-overlay';
    const panel = document.createElement('div');
    panel.className = 'notes-panel notes-browser';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    _panel = overlay;

    // Clicking the backdrop (not the panel) closes, like the other overlays.
    overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) NotesPanel.close();
    });

    // ── Header ──────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'notes-header';
    const title = document.createElement('span');
    title.className = 'notes-header-title jh-icon-row';
    title.replaceChildren(iconEl('note', { size: 14 }), document.createTextNode(t('Notes')));

    const tabs = document.createElement('div');
    tabs.className = 'notes-tabs';
    const mkTab = (id, label) => {
        const b = document.createElement('button');
        b.className = 'notes-tab' + (tab === id ? ' active' : '');
        b.dataset.tab = id;
        b.textContent = label;
        b.onclick = () => { tab = id; refresh(); };
        return b;
    };
    // Quick first, because it is the one that opens.
    tabs.append(mkTab('quick', t('Quick Notes')), mkTab('daily', t('Daily')));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.replaceChildren(iconEl('close', { size: 13 }));
    closeBtn.title = t('Close (Esc)');
    closeBtn.onclick = () => NotesPanel.close();
    header.append(title, tabs, closeBtn);
    panel.appendChild(header);

    // ── Filter ──────────────────────────────────────────────────────────────
    const searchWrap = document.createElement('div');
    searchWrap.className = 'notes-search';
    const searchInput = document.createElement('input');
    searchInput.placeholder = t('Filter notes…');
    searchInput.autocomplete = 'off';
    searchInput.oninput = () => draw();
    searchWrap.appendChild(searchInput);
    panel.appendChild(searchWrap);

    // ── List ────────────────────────────────────────────────────────────────
    const list = document.createElement('div');
    list.className = 'notes-list notes-browser-list';
    panel.appendChild(list);

    // ── Footer ──────────────────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.className = 'notes-browser-footer';
    const todayBtn = document.createElement('button');
    todayBtn.className = 'notes-tool-btn jh-icon-row';
    todayBtn.replaceChildren(iconEl('clock', { size: 12 }), document.createTextNode(t("Today's Note")));
    todayBtn.onclick = async () => { NotesPanel.close(); await DailyNotes.openToday(); };
    const newBtn = document.createElement('button');
    newBtn.className = 'notes-new-btn jh-icon-row';
    newBtn.replaceChildren(iconEl('plus', { size: 12 }), document.createTextNode(t('New Quick Note')));
    newBtn.onclick = async () => {
        const path = await newQuickNote();
        if (path) await openNote(path);
    };
    footer.append(todayBtn, newBtn);
    panel.appendChild(footer);

    /** Re-read the current folder from disk, then redraw. */
    async function refresh() {
        // Matched on the id, not on the button's own words: two tabs that ever
        // shared a label would both light up, and a translation could make them.
        for (const b of tabs.querySelectorAll('.notes-tab')) {
            b.classList.toggle('active', b.dataset.tab === tab);
        }
        list.replaceChildren(loadingRow());
        rows = tab === 'daily' ? await listDaily() : await listQuick();
        focused = 0;
        draw();
    }

    function loadingRow() {
        const el = document.createElement('div');
        el.className = 'notes-empty';
        el.textContent = t('Loading…');
        return el;
    }

    /** Ask for a new name and move the file (and any tab showing it). */
    async function doRename(row) {
        const current = row.name.replace(/\.md$/i, '');
        const name = await showPrompt(t('Rename this note'), {
            title: t('Rename'), value: current, okLabel: t('Rename'),
        });
        if (name === null) return;
        const result = await renameNote(row.path, name);
        if (!result) return;                       // nothing usable typed
        if (result.error === 'exists') {
            await showAlert(t('A note called {name} already exists.', { name }),
                { title: t('Rename'), kind: 'warning' });
            return;
        }
        if (result.error) {
            await showAlert(t('Could not rename {name}.', { name: row.name }),
                { title: t('Rename'), kind: 'error' });
            return;
        }
        // A tab still showing it would otherwise keep the old address, and its
        // next save would write the note back under the name just left behind.
        retargetOpenFile(row.path, result);
        await refresh();
    }

    /** The rows matching the filter box. */
    function visible() {
        const q = searchInput.value.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter((r) => `${r.title} ${r.name}`.toLowerCase().includes(q));
    }

    function draw() {
        const shown = visible();
        list.replaceChildren();
        if (!shown.length) {
            const empty = document.createElement('div');
            empty.className = 'notes-empty';
            empty.textContent = searchInput.value.trim()
                ? t('No notes match that.')
                : (tab === 'daily' ? t('No daily notes yet.') : t('No quick notes yet.'));
            list.appendChild(empty);
            return;
        }
        if (focused >= shown.length) focused = shown.length - 1;

        shown.forEach((row, i) => {
            const item = document.createElement('div');
            item.className = 'notes-item' + (i === focused ? ' active' : '');
            item.onclick = () => openNote(row.path);

            const main = document.createElement('div');
            main.className = 'notes-item-main';
            const name = document.createElement('div');
            name.className = 'notes-item-name';
            // A daily note's name IS its date, which is the thing you are
            // looking for; a quick note's is a timestamp nobody reads, so its
            // first line leads instead.
            const lead = tab === 'daily' ? row.name.replace(/\.md$/i, '') : (row.title || row.name);
            const sub = tab === 'daily' ? row.title : row.name.replace(/\.md$/i, '');
            name.textContent = lead;
            main.appendChild(name);
            if (sub) {
                const subEl = document.createElement('div');
                subEl.className = 'notes-item-sub';
                subEl.textContent = sub;
                main.appendChild(subEl);
            }

            const when = document.createElement('span');
            when.className = 'notes-item-time';
            when.textContent = fmtWhen(row.mtime);

            // Renaming is only offered for quick notes. A daily note's name
            // IS its date — the thing that decides which day it is and which
            // file "today" resolves to — so renaming one would quietly detach
            // it from the calendar it belongs to.
            const tools = document.createElement('div');
            tools.className = 'notes-item-tools';
            if (tab === 'quick') {
                const ren = document.createElement('button');
                ren.className = 'notes-item-tool';
                ren.title = t('Rename this note');
                ren.replaceChildren(iconEl('pencil', { size: 12 }));
                ren.onclick = (e) => { e.stopPropagation(); doRename(row); };
                tools.appendChild(ren);
            }

            const del = document.createElement('button');
            del.className = 'notes-item-tool notes-item-del';
            del.title = t('Delete this note');
            del.replaceChildren(iconEl('trash', { size: 12 }));
            del.onclick = async (e) => {
                e.stopPropagation();
                const ok = await showConfirm(
                    t('Delete {name}? This cannot be undone.', { name: row.name }),
                    { title: t('Delete Note'), kind: 'warning', okLabel: t('Delete') },
                );
                if (!ok) return;
                try {
                    await invoke('remove_file', { path: row.path });
                } catch (err) {
                    console.warn('[Notes] delete failed', err);
                    if (window.showToast) window.showToast(t('Could not delete {path}', { path: row.path }));
                    return;
                }
                await refresh();
            };

            tools.appendChild(del);
            item.append(main, when, tools);
            list.appendChild(item);
        });
    }

    // Keyboard: the list is a picker, so ↑↓ and Enter, and Esc to leave.
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); NotesPanel.close(); return; }
        const shown = visible();
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focused = Math.min(shown.length - 1, focused + 1);
            draw();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focused = Math.max(0, focused - 1);
            draw();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (shown[focused]) openNote(shown[focused].path);
        }
    });

    refresh();
    setTimeout(() => searchInput.focus(), 0);
}
