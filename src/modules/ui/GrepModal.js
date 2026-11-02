import { State } from '../core/Store.js';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { icon as svgIcon } from './Icons.js';
import { t } from '../utils/I18n.js';
import { escapeHtml } from '../utils/SanitizeHtml.js';
import { getParentDir } from '../utils/FileSystem.js';
import { getGrepMaxMatches } from '../utils/GrepSetting.js';

// Ctrl+G: grep. Pick a scope (a folder or the open file) + options, run the
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
    #grep-overlay .grep-row { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
    #grep-overlay .grep-row-label { flex: 0 0 56px; opacity: .7; white-space: nowrap; }
    #grep-overlay .grep-path {
        flex: 1; min-width: 0; color: var(--primary-color);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #grep-overlay .grep-seg {
        display: inline-flex; flex-shrink: 0; overflow: hidden;
        border: 1px solid var(--border-color); border-radius: 6px;
    }
    #grep-overlay .grep-seg-btn {
        padding: 5px 10px; font-size: 12px; line-height: 1; white-space: nowrap; cursor: pointer;
        background: var(--bg-color); color: var(--text-color);
        border: 0; border-right: 1px solid var(--border-color);
    }
    #grep-overlay .grep-seg-btn:last-child { border-right: 0; }
    #grep-overlay .grep-seg-btn:hover:not(:disabled) { background: var(--hover-color); }
    #grep-overlay .grep-seg-btn:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
    #grep-overlay .grep-seg-btn[aria-pressed="true"],
    #grep-overlay .grep-seg-btn[aria-pressed="true"]:hover:not(:disabled) {
        background: color-mix(in srgb, var(--primary-color) 18%, var(--bg-color));
        color: var(--primary-color); font-weight: 600;
    }
    #grep-overlay .grep-seg-btn:disabled { opacity: .5; cursor: default; }
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

function _segButton(label, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'grep-seg-btn';
    button.textContent = label;
    button.title = title;
    return button;
}

function _setPressed(button, pressed) {
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}

/** Forward or back slashes, and either case on the drive letter, are one folder. */
function _samePath(a, b) {
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return !!a && !!b && norm(a) === norm(b);
}

function _fileDisplayName(file) {
    return (file && (file.name || file.path)) || '(untitled)';
}

/** The current-file scope stays as it was left for the rest of the session. */
let currentFileOnly = false;

/** A tab that is a file on disk, not a results list or a diff (search://…). */
function _isOnDisk(file) {
    return !!(file && file.path && !/^[a-z][a-z0-9+.-]+:\/\//i.test(file.path));
}

/**
 * Can this tab's text be searched in memory? A preview holds no text, and a
 * large file only ever has a window of itself loaded: searching what happens
 * to be there would report "no results" for text the file does contain.
 */
export function canSearchInMemory(file) {
    return !!file && typeof file.content === 'string'
        && !file.isLarge && file.editId == null
        && !['office', 'search-results', 'dir-diff'].includes(file.type);
}

/** Where a search starts by default: beside the open file, else the workspace. */
export function defaultSearchFolder(file) {
    return _isOnDisk(file) ? getParentDir(file.path) : (State.currentDir || null);
}

/**
 * A line as a results row shows it: from the start, or, when the hit is further
 * along than a row has room for, from just before the hit (shown_line in
 * commands/search.rs does the same for the backend's results).
 */
export function clipAroundHit(line, index) {
    const VISIBLE_CHARS = 100;
    const LEAD_CHARS = 40;
    const MAX_CHARS = 1000;
    if (index < VISIBLE_CHARS) return line.slice(0, MAX_CHARS);
    return `…${line.slice(index - LEAD_CHARS, index - LEAD_CHARS + MAX_CHARS)}`;
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
    const MAX = getGrepMaxMatches();
    for (let i = 0; i < lines.length && out.length < MAX; i++) {
        const hit = re.exec(lines[i]);
        if (hit) out.push({ path, line: i + 1, text: clipAroundHit(lines[i], hit.index) });
    }
    return out;
}

export const GrepModal = {
    show(presetFolder) {
        _injectStyles();
        const existing = document.getElementById('grep-overlay');
        if (existing) existing.remove();

        // The file being edited can be searched on its own, from its in-memory
        // content (so unsaved edits are included). With no folder to search at
        // all — an untitled tab and no workspace — that is the only choice.
        const activeFile = _getActiveFile();
        // A large file is never in memory, but is read-only here, so what is on
        // disk is what is on screen: the backend can search that one file.
        const onDiskOnly = activeFile && activeFile.isLarge && _isOnDisk(activeFile) ? activeFile : null;
        const currentFile = canSearchInMemory(activeFile) ? activeFile : onDiskOnly;
        let folder = presetFolder || defaultSearchFolder(activeFile);
        if (!folder && !currentFile) {
            console.warn('GrepModal: no folder and no searchable file');
            return;
        }
        const fileOnlyForced = !folder;
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
        term.style.cssText = 'width:100%; padding:8px 10px; font-size:14px; background:var(--bg-color-secondary,var(--bg-color)); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;';

        const mkRow = (label) => {
            const row = document.createElement('div');
            row.className = 'grep-row';
            const name = document.createElement('span');
            name.className = 'grep-row-label';
            name.textContent = label;
            row.appendChild(name);
            return row;
        };

        // What to search. A choice of where, not a condition on what: the rows
        // under it change with it, and the conditions further down do not.
        let fileOnly = fileOnlyForced || (!!currentFile && !presetFolder && currentFileOnly);
        const scopeRow = mkRow(t('Scope'));
        const scopeSeg = document.createElement('div');
        scopeSeg.className = 'grep-seg';
        const scopeFolder = _segButton(t('Folder'), t('Search the folder recursively'));
        const scopeFile = _segButton(t('Current file'), t('Search only the file being edited, including unsaved changes'));
        scopeFolder.disabled = fileOnlyForced;
        // Kept in view when it cannot be used, so that it is not a feature that
        // comes and goes with the tab; the tooltip says why.
        scopeFile.disabled = !currentFile;
        if (!currentFile) scopeFile.title = t('This tab cannot be searched on its own');
        scopeSeg.append(scopeFolder, scopeFile);
        scopeRow.appendChild(scopeSeg);

        // Which folder. The segment lit up says where the path came from.
        const openFileFolder = _isOnDisk(activeFile) ? getParentDir(activeFile.path) : null;
        const folderRow = mkRow(t('Location'));
        const folderPath = document.createElement('span');
        folderPath.className = 'grep-path';
        const locSeg = document.createElement('div');
        locSeg.className = 'grep-seg';
        const locCurrent = _segButton(t('Current'), t('The folder of the open file'));
        const locRoot = _segButton(t('WS Root'), t('Back to the workspace root'));
        const locPick = _segButton(t('Choose…'), t('Choose Folder'));
        const syncFolder = () => {
            folderPath.textContent = folder || '';
            folderPath.title = folder || '';
            const fromFile = _samePath(folder, openFileFolder);
            const fromRoot = !fromFile && _samePath(folder, State.currentDir);
            _setPressed(locCurrent, fromFile);
            _setPressed(locRoot, fromRoot);
            _setPressed(locPick, !fromFile && !fromRoot);
        };
        locCurrent.onclick = () => { folder = openFileFolder; syncFolder(); term.focus(); };
        locRoot.onclick = () => { folder = State.currentDir; syncFolder(); term.focus(); };
        locPick.onclick = async () => {
            try {
                const picked = await open({ directory: true, multiple: false, defaultPath: folder, title: t('Choose Folder') });
                if (picked) { folder = picked; syncFolder(); }
            } catch (_) {}
            term.focus();
        };
        // Nothing to go to: the tab is not a file, or no workspace is open.
        if (!openFileFolder) locCurrent.style.display = 'none';
        if (!State.currentDir) locRoot.style.display = 'none';
        locSeg.append(locCurrent, locRoot, locPick);
        folderRow.append(folderPath, locSeg);
        syncFolder();

        const mkCheck = (label, checked, title) => {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:inline-flex; align-items:center; gap:5px; cursor:pointer; white-space:nowrap; user-select:none;';
            if (title) wrap.title = title;
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = checked;
            wrap.append(cb, document.createTextNode(label));
            wrap._cb = cb;
            return wrap;
        };

        // File filter (glob) row. Subfolders belong here: like the filter, they
        // only mean something when searching a folder.
        const globRow = mkRow(t('Files'));
        const glob = document.createElement('input');
        glob.type = 'text';
        glob.placeholder = t('*.java, *.xml  (empty = all, ! to exclude)');
        glob.title = 'Filter by filename glob. Separate several with commas or spaces.\ne.g. *.java   |   *.java, *.xml   |   !*test*   |   src/**/*.ts';
        glob.style.cssText = 'flex:1; min-width:0; padding:6px 10px; font-size:12px; background:var(--bg-color-secondary,var(--bg-color)); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;';
        const cSub = mkCheck(t('Include subfolders'), true);
        globRow.append(glob, cSub);

        // Which file, in current-file mode.
        const infoRow = mkRow(t('Target'));
        if (currentFile) {
            const info = document.createElement('span');
            info.className = 'grep-path';
            info.innerHTML = `${escapeHtml(_fileDisplayName(currentFile))}`;
            info.title = currentFile.path || currentFile.name || '';
            infoRow.appendChild(info);
        }

        // Conditions: how the text has to match, wherever it is being searched.
        const rule = document.createElement('div');
        rule.style.cssText = 'border-top:1px solid var(--border-color);';
        const condRow = mkRow(t('Conditions'));
        condRow.style.flexWrap = 'wrap';
        condRow.style.columnGap = '14px';
        const cCase = mkCheck(t('Match case'), false);
        const cRegex = mkCheck(t('Regular expression'), false);
        const cWord = mkCheck(t('Whole word'), false, t('Match on word boundaries'));
        condRow.append(cCase, cRegex, cWord);

        // Footer
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex; align-items:center; gap:10px;';
        const status = document.createElement('span');
        status.style.cssText = 'flex:1; font-size:12px; opacity:0.75;';
        const searchBtn = document.createElement('button');
        searchBtn.innerHTML = svgIcon('search', { size: 13 }) + `<span>${t('Search')}</span>`;
        searchBtn.className = 'grep-btn grep-btn-primary';
        footer.append(status, searchBtn);

        box.append(term, scopeRow, folderRow, globRow, infoRow, rule, condRow, footer);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const syncScope = () => {
            _setPressed(scopeFolder, !fileOnly);
            _setPressed(scopeFile, fileOnly);
            folderRow.style.display = fileOnly ? 'none' : 'flex';
            globRow.style.display = fileOnly ? 'none' : 'flex';
            infoRow.style.display = fileOnly ? 'flex' : 'none';
            term.placeholder = fileOnly ? t('Search the current file… (Enter)') : t('Search the folder… (Enter)');
        };
        const setScope = (only) => {
            fileOnly = only;
            currentFileOnly = only;
            syncScope();
            term.focus();
        };
        scopeFolder.onclick = () => setScope(false);
        scopeFile.onclick = () => setScope(true);
        syncScope();

        setTimeout(() => term.focus(), 0);

        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };

        const run = async () => {
            const q = term.value;
            if (!q || running) return;
            const opts = { regex: cRegex._cb.checked, caseSensitive: cCase._cb.checked, wholeWord: cWord._cb.checked };
            // Validate a regex pattern up-front so we don't open an empty tab.
            if (opts.regex) {
                try { new RegExp(q); } catch (e) { status.textContent = t('Invalid regular expression: ') + e.message; return; }
            }
            const searchId = Date.now() + Math.random();

            // Search the current file's in-memory content in JS.
            if (fileOnly && !onDiskOnly) {
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
            // ...and wait for them to be registered: a search that finishes
            // first has nobody to tell, and the tab never leaves "Searching…".
            await window.app.openSearchResults({ query: q, matches: [], options: opts, searchId, streaming: true, singleFile: fileOnly });
            try {
                await invoke('start_grep', {
                    dir: fileOnly ? onDiskOnly.path : folder, term: q,
                    regex: opts.regex, caseSensitive: opts.caseSensitive,
                    wholeWord: opts.wholeWord, includeSubdirs: cSub._cb.checked,
                    globs: fileOnly ? null : (glob.value.trim() || null),
                    maxMatches: getGrepMaxMatches(),
                    searchId,
                });
                close();
            } catch (e) {
                status.textContent = t('Error: ') + (e && e.message ? e.message : e);
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
