/**
 * NotesPanel.js — always-available quick notes (Markdown).
 *
 * Phase 1 quick notes are persisted to localStorage (a dedicated key, separate
 * from drafts) so they are available instantly from anywhere, without touching
 * the workspace files. Notes are small Markdown documents: a title + body, with
 * a live preview powered by the global `marked`.
 *
 * `newNote()` creates a note and opens the panel (bound to Ctrl+Alt+M).
 */

const STORAGE_KEY = 'jh_notes_v1';
const MAX_NOTE_BYTES = 512 * 1024; // one very large note must not blow the quota
let _saveTimer = null;
let _panel = null;
let _activeId = null;

function readAll() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((n) => n && n.id && typeof n.content === 'string');
    } catch (_) {
        return [];
    }
}

function writeAll(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) {
        console.warn('[Notes] persist failed (quota?):', e && e.message);
    }
}

function generateId() {
    return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function firstLine(content) {
    const line = String(content || '').split('\n').find((l) => l.trim()) || 'Untitled note';
    return line.replace(/^#+\s*/, '').slice(0, 60) || 'Untitled note';
}

function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString();
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(md) {
    try {
        if (typeof marked !== 'undefined' && marked.parse) return marked.parse(md || '');
    } catch (_) { /* fall through */ }
    return `<pre style="white-space:pre-wrap;margin:0;">${escapeHtml(md || '')}</pre>`;
}

export const NotesPanel = {
    get all() { return readAll(); },

    /** Create a fresh note, save it, return it. */
    create(content = '', { pinned = false } = {}) {
        const now = Date.now();
        const note = { id: generateId(), content, pinned, createdAt: now, updatedAt: now };
        const list = readAll();
        list.unshift(note);
        writeAll(list);
        return note;
    },

    update(id, patch) {
        const list = readAll();
        const note = list.find((n) => n.id === id);
        if (!note) return null;
        Object.assign(note, patch, { updatedAt: Date.now() });
        // Trim oversized notes defensively (still keep the front of the text).
        if (note.content && note.content.length > MAX_NOTE_BYTES) note.content = note.content.slice(0, MAX_NOTE_BYTES);
        writeAll(list);
        return note;
    },

    remove(id) {
        const list = readAll();
        const next = list.filter((n) => n.id !== id);
        if (next.length === list.length) return false;
        writeAll(next);
        if (_activeId === id) _activeId = null;
        return true;
    },

    togglePin(id) {
        const note = readAll().find((n) => n.id === id);
        if (!note) return null;
        return this.update(id, { pinned: !note.pinned });
    },

    getById(id) {
        return readAll().find((n) => n.id === id) || null;
    },

    /** Open the panel, optionally creating + selecting a new note first. */
    open({ create = false } = {}) {
        if (create) {
            const note = this.create();
            _activeId = note.id;
        }
        showPanel();
    },

    close() {
        if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
        if (_panel) { _panel.remove(); _panel = null; }
    },
};

function showPanel() {
    if (_panel) _panel.remove();

    const overlay = document.createElement('div');
    overlay.className = 'notes-overlay';
    const panel = document.createElement('div');
    panel.className = 'notes-panel';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    _panel = overlay;

    // Header
    const header = document.createElement('div');
    header.className = 'notes-header';
    const title = document.createElement('span');
    title.className = 'notes-header-title';
    title.textContent = '📝 Quick Notes';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close (Esc)';
    closeBtn.onclick = () => NotesPanel.close();
    header.append(title, closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'notes-body';
    panel.appendChild(body);

    // Sidebar (list + search + new)
    const sidebar = document.createElement('div');
    sidebar.className = 'notes-sidebar';
    const searchWrap = document.createElement('div');
    searchWrap.className = 'notes-search';
    const searchInput = document.createElement('input');
    searchInput.placeholder = 'Filter notes…';
    searchInput.autocomplete = 'off';
    searchWrap.appendChild(searchInput);
    sidebar.appendChild(searchWrap);
    const list = document.createElement('div');
    list.className = 'notes-list';
    sidebar.appendChild(list);
    const footer = document.createElement('div');
    footer.className = 'notes-sidebar-footer';
    const newBtn = document.createElement('button');
    newBtn.className = 'notes-new-btn';
    newBtn.textContent = '+ New Note';
    newBtn.onclick = () => {
        const note = NotesPanel.create();
        _activeId = note.id;
        renderList();
        renderEditor(note);
    };
    footer.appendChild(newBtn);
    sidebar.appendChild(footer);
    body.appendChild(sidebar);

    // Editor
    const editor = document.createElement('div');
    editor.className = 'notes-editor';
    body.appendChild(editor);

    const tools = document.createElement('div');
    tools.className = 'notes-editor-tools';
    const titleInput = document.createElement('input');
    titleInput.className = 'notes-title-input';
    titleInput.placeholder = 'Note title…';
    tools.appendChild(titleInput);
    const pinBtn = document.createElement('button');
    pinBtn.className = 'notes-tool-btn';
    pinBtn.textContent = '📌';
    pinBtn.title = 'Pin note';
    const previewBtn = document.createElement('button');
    previewBtn.className = 'notes-tool-btn';
    previewBtn.textContent = 'Preview';
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'notes-tool-btn';
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Delete note';
    tools.append(pinBtn, previewBtn, deleteBtn);
    editor.appendChild(tools);

    const input = document.createElement('textarea');
    input.className = 'notes-body-input';
    input.placeholder = '# Write in Markdown…';
    input.spellcheck = false;
    editor.appendChild(input);
    const preview = document.createElement('div');
    preview.className = 'notes-preview';
    preview.style.display = 'none';
    editor.appendChild(preview);
    const empty = document.createElement('div');
    empty.className = 'notes-empty';
    empty.textContent = 'Select or create a note';
    editor.appendChild(empty);

    let currentNote = null;
    let previewOn = false;

    const setPreview = (on) => {
        previewOn = on;
        previewBtn.textContent = on ? 'Edit' : 'Preview';
        previewBtn.classList.toggle('active', on);
        input.style.display = on ? 'none' : 'block';
        preview.style.display = on ? 'block' : 'none';
        if (on && currentNote) preview.innerHTML = renderMarkdown(currentNote.content);
    };

    const persist = () => {
        if (!currentNote) return;
        const next = { ...currentNote, content: input.value, updatedAt: Date.now() };
        currentNote = next;
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            NotesPanel.update(currentNote.id, { content: input.value });
            renderList();
        }, 400);
    };

    const renderEditor = (note) => {
        currentNote = note;
        _activeId = note.id;
        titleInput.value = note.pinned ? '📌 ' + firstLine(note.content) : firstLine(note.content);
        input.value = note.content || '';
        pinBtn.textContent = note.pinned ? '📌' : '📍';
        pinBtn.title = note.pinned ? 'Unpin note' : 'Pin note';
        empty.style.display = 'none';
        input.style.display = previewOn ? 'none' : 'block';
        preview.style.display = previewOn ? 'block' : 'none';
        if (previewOn) preview.innerHTML = renderMarkdown(note.content);
        input.focus();
        renderList();
    };

    const renderList = () => {
        const q = searchInput.value.trim().toLowerCase();
        const notes = readAll().filter((n) =>
            !q || n.content.toLowerCase().includes(q));
        notes.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
        list.innerHTML = '';
        if (notes.length === 0) {
            const el = document.createElement('div');
            el.className = 'notes-empty';
            el.textContent = q ? 'No matching notes' : 'No notes yet';
            list.appendChild(el);
            return;
        }
        notes.forEach((n) => {
            const item = document.createElement('div');
            item.className = 'notes-item' + (n.id === _activeId ? ' active' : '');
            const name = document.createElement('span');
            name.className = 'notes-item-title';
            name.textContent = firstLine(n.content);
            const pin = document.createElement('span');
            pin.className = 'notes-item-pin';
            pin.textContent = n.pinned ? '📌' : '';
            const time = document.createElement('span');
            time.className = 'notes-item-time';
            time.textContent = fmtTime(n.updatedAt);
            item.append(pin, name, time);
            item.onclick = () => renderEditor(n);
            list.appendChild(item);
        });
    };

    // Events
    input.oninput = persist;
    titleInput.oninput = () => {
        if (!currentNote) return;
        const t = titleInput.value.replace(/^📌\s*/, '');
        const body = currentNote.content || '';
        const m = body.match(/^#+\s*[^\n]*/);
        let next = body;
        if (m) next = body.replace(m[0], `# ${t}`);
        else next = `# ${t}\n${body}`;
        input.value = next;
        persist();
    };
    pinBtn.onclick = () => {
        if (!currentNote) return;
        const updated = NotesPanel.togglePin(currentNote.id);
        if (updated) { currentNote = updated; pinBtn.textContent = updated.pinned ? '📌' : '📍'; renderList(); }
    };
    previewBtn.onclick = () => { if (currentNote) setPreview(!previewOn); };
    deleteBtn.onclick = () => {
        if (!currentNote) return;
        NotesPanel.remove(currentNote.id);
        currentNote = null;
        _activeId = null;
        titleInput.value = '';
        input.value = '';
        empty.style.display = 'flex';
        input.style.display = 'none';
        preview.style.display = 'none';
        renderList();
    };

    // Keyboard
    const onKey = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            NotesPanel.close();
        }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) NotesPanel.close();
    });
    // Remember to remove the capture listener when the panel closes.
    const origClose = NotesPanel.close;
    NotesPanel.close = () => {
        document.removeEventListener('keydown', onKey, true);
        origClose.call(NotesPanel);
    };

    // Initial render
    renderList();
    if (_activeId) {
        const note = NotesPanel.getById(_activeId);
        if (note) renderEditor(note);
        else { empty.style.display = 'flex'; input.style.display = 'none'; }
    } else {
        empty.style.display = 'flex';
        input.style.display = 'none';
    }
    searchInput.focus();
}
