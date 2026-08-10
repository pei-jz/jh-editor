import { State } from '../core/Store.js';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

// Ctrl+G: workspace grep. Pick a folder + subfolder toggle + options, run the
// search, and show the results in a tab (see window.app.openSearchResults).
function _injectStyles() {
    if (document.getElementById('grep-modal-styles')) return;
    const style = document.createElement('style');
    style.id = 'grep-modal-styles';
    style.textContent = `
    #grep-overlay .grep-btn {
        padding: 5px 12px; font-size: 12px; cursor: pointer; line-height: 1;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 6px;
        transition: background .12s, border-color .12s, color .12s;
    }
    #grep-overlay .grep-btn:hover { background: var(--hover-color); border-color: var(--primary-color); }
    #grep-overlay .grep-btn:active { transform: translateY(1px); }
    #grep-overlay .grep-btn-primary {
        background: var(--primary-color); color: #fff; border-color: var(--primary-color);
        padding: 6px 18px; font-weight: 600;
    }
    #grep-overlay .grep-btn-primary:hover { filter: brightness(1.08); background: var(--primary-color); }
    #grep-overlay .grep-btn:disabled { opacity: .55; cursor: default; transform: none; }
    `;
    document.head.appendChild(style);
}

/** The file in the active editor pane (may be unsaved / in-memory). */
function _getActiveFile() {
    try {
        // Only trust 'right' while a split actually exists.
        if (State.splitMode && State.activePane === 'right') {
            return State.rightOpenFiles[State.rightActiveTabIndex] || null;
        }
        return State.openFiles[State.activeTabIndex] || null;
    } catch (_) { return null; }
}

function _fileDisplayName(file) {
    return (file && (file.name || file.path)) || '(untitled)';
}

/** Grep a file's in-memory content in JS; returns grep-match-shaped rows. */
function _searchInMemory(file, query, opts) {
    const content = (file && typeof file.content === 'string') ? file.content : '';
    if (!content) return [];
    let re;
    try {
        let src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (opts.wholeWord) src = `\\b(?:${src})\\b`;
        re = new RegExp(src, opts.caseSensitive ? '' : 'i');
    } catch (_) { return []; }

    const path = file.path || file.name || '(untitled)';
    const out = [];
    const lines = content.split(/\r?\n/);
    const MAX = 5000; // safety cap
    for (let i = 0; i < lines.length && out.length < MAX; i++) {
        if (re.test(lines[i])) {
            const text = lines[i].length > 1000 ? lines[i].slice(0, 1000) : lines[i];
            out.push({ path, line: i + 1, text });
        }
    }
    return out;
}

export const GrepModal = {
    show(presetFolder) {
        _injectStyles();
        const existing = document.getElementById('grep-overlay');
        if (existing) existing.remove();

        // No workspace (and no preset folder) → fall back to searching the file
        // currently being edited, using its in-memory content (so unsaved edits
        // are included).
        const hasWorkspace = !!(presetFolder || State.currentDir);
        const currentFile = hasWorkspace ? null : _getActiveFile();
        if (!hasWorkspace && !currentFile) {
            console.warn('GrepModal: no workspace and no active file');
            return;
        }

        let folder = presetFolder || State.currentDir || null;
        let running = false;

        const overlay = document.createElement('div');
        overlay.id = 'grep-overlay';
        overlay.className = 'tab-search-overlay';

        const box = document.createElement('div');
        box.className = 'tab-search-container';
        box.style.cssText = 'width: 620px; max-width: 90vw; align-self: flex-start; height: auto; max-height: none; display: flex; flex-direction: column; gap: 10px; padding: 14px;';

        // Search term
        const term = document.createElement('input');
        term.type = 'text';
        term.placeholder = hasWorkspace ? 'Search the workspace… (Enter)' : 'Search the current file… (Enter)';
        term.style.cssText = 'width:100%; padding:8px 10px; font-size:14px; background:var(--bg-color-secondary,var(--bg-color)); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;';

        // Folder row
        const folderRow = document.createElement('div');
        folderRow.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:12px;';
        const folderLabel = document.createElement('span');
        folderLabel.style.cssText = 'opacity:0.7; white-space:nowrap;';
        folderLabel.textContent = 'In:';
        const folderPath = document.createElement('span');
        folderPath.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--primary-color);';
        folderPath.textContent = folder || '';
        folderPath.title = folder || '';
        const folderBtn = document.createElement('button');
        folderBtn.textContent = '📁 Choose Folder';
        folderBtn.className = 'grep-btn';
        folderBtn.onclick = async () => {
            try {
                const picked = await open({ directory: true, multiple: false, defaultPath: folder, title: 'Folder to search' });
                if (picked) { folder = picked; folderPath.textContent = folder; folderPath.title = folder; }
            } catch (_) {}
        };
        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'WS Root';
        resetBtn.title = 'Back to the workspace root';
        resetBtn.className = 'grep-btn';
        resetBtn.onclick = () => { folder = State.currentDir; folderPath.textContent = folder; folderPath.title = folder; };
        folderRow.append(folderLabel, folderPath, folderBtn, resetBtn);

        // File filter (glob) row
        const globRow = document.createElement('div');
        globRow.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:12px;';
        const globLabel = document.createElement('span');
        globLabel.style.cssText = 'opacity:0.7; white-space:nowrap;';
        globLabel.textContent = 'Files:';
        const glob = document.createElement('input');
        glob.type = 'text';
        glob.placeholder = '*.java, *.xml   (empty = all / prefix ! to exclude)';
        glob.title = 'Filter by filename glob. Separate several with commas or spaces.\ne.g. *.java   |   *.java, *.xml   |   !*test*   |   src/**/*.ts';
        glob.style.cssText = 'flex:1; padding:6px 10px; font-size:12px; background:var(--bg-color-secondary,var(--bg-color)); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;';
        globRow.append(globLabel, glob);

        // Options row
        const opts = document.createElement('div');
        opts.style.cssText = 'display:flex; flex-wrap:wrap; gap:14px; font-size:12px; user-select:none;';
        const mkCheck = (label, checked, title) => {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:inline-flex; align-items:center; gap:5px; cursor:pointer;';
            if (title) wrap.title = title;
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = checked;
            wrap.append(cb, document.createTextNode(label));
            wrap._cb = cb;
            return wrap;
        };
        const cSub = mkCheck('Include subfolders', true, 'Search the folder recursively');
        const cCase = mkCheck('Match case', false);
        const cRegex = mkCheck('Regular expression', false);
        const cWord = mkCheck('Whole word', false, 'Match on word boundaries');
        opts.append(cSub, cCase, cRegex, cWord);

        // Footer
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex; align-items:center; gap:10px;';
        const status = document.createElement('span');
        status.style.cssText = 'flex:1; font-size:12px; opacity:0.75;';
        const searchBtn = document.createElement('button');
        searchBtn.textContent = '🔍 Search';
        searchBtn.className = 'grep-btn grep-btn-primary';
        footer.append(status, searchBtn);

        box.append(term, folderRow, globRow, opts, footer);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // Current-file mode: hide the workspace-only controls (folder / glob /
        // subdirs) and show which file is being searched.
        if (currentFile) {
            folderRow.style.display = 'none';
            globRow.style.display = 'none';
            cSub.style.display = 'none';
            const info = document.createElement('div');
            info.style.cssText = 'font-size:12px; opacity:0.75; display:flex; gap:6px; align-items:center;';
            info.innerHTML = `<span style="opacity:0.7;">Target file:</span><span style="color:var(--primary-color);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_fileDisplayName(currentFile)}</span>`;
            info.title = currentFile.path || currentFile.name || '';
            box.insertBefore(info, opts);
        }

        setTimeout(() => term.focus(), 0);

        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };

        const run = async () => {
            const q = term.value;
            if (!q || running) return;
            const opts = { regex: cRegex._cb.checked, caseSensitive: cCase._cb.checked, wholeWord: cWord._cb.checked };
            // Validate a regex pattern up-front so we don't open an empty tab.
            if (opts.regex) {
                try { new RegExp(q); } catch (e) { status.textContent = 'Invalid regular expression: ' + e.message; return; }
            }
            const searchId = Date.now() + Math.random();

            // No workspace → search the current file's in-memory content in JS.
            if (currentFile) {
                const matches = _searchInMemory(currentFile, q, opts);
                window.app.openSearchResults({
                    query: q, matches, options: opts, searchId,
                    streaming: false, singleFile: true,
                });
                close();
                return;
            }

            running = true;
            searchBtn.disabled = true;
            // Open the results tab FIRST (registers streaming listeners), then kick
            // off the async search. Results stream in live; the editor stays usable.
            window.app.openSearchResults({ query: q, matches: [], options: opts, searchId, streaming: true });
            try {
                await invoke('start_grep', {
                    dir: folder, term: q,
                    regex: opts.regex, caseSensitive: opts.caseSensitive,
                    wholeWord: opts.wholeWord, includeSubdirs: cSub._cb.checked,
                    globs: glob.value.trim() || null,
                    searchId,
                });
                close();
            } catch (e) {
                status.textContent = 'Error: ' + (e && e.message ? e.message : e);
                running = false;
                searchBtn.disabled = false;
            }
        };

        searchBtn.onclick = run;
        const onKey = (e) => {
            if (e.key === 'Enter' && (document.activeElement === term || document.activeElement === glob)) { e.preventDefault(); run(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        };
        document.addEventListener('keydown', onKey, true);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    }
};
