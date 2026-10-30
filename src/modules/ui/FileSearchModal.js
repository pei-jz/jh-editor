import { State } from '../core/Store.js';
import { t } from '../utils/I18n.js';
import { icon as svgIcon, iconEl, iconForFile } from './Icons.js';
import { openFile } from '../core/Editor.js';
import * as FS from '../utils/FileSystem.js';
import { escapeHtml } from '../utils/SanitizeHtml.js';
import { RecentFiles } from '../utils/RecentFiles.js';
import { prepareEntries, rankFiles, splitRelRanges } from '../utils/FileSearchRank.js';

// Persistent file index (survives modal close/reopen).
//
// Past FILE_CACHE_LIMIT the list is cut, but the cut list is still kept: it
// used to be thrown away, so on a big tree every keystroke walked the whole
// workspace again. The status line says the index is partial; F5 (refresh
// explorer) or switching workspace builds a fresh one.
const FILE_CACHE_LIMIT = 50000; // Max files to index (paths only; a few MB)
let _fileCache = null;          // prepareEntries() output
let _fileCacheDir = null;
let _fileCacheTotal = 0;        // files the walk found, before the cut
let _fileCachePromise = null;   // the walk in flight, shared by preload and search

const HIGHLIGHT_STYLE = 'background: rgba(var(--primary-rgb, 0, 122, 204), 0.4); color: inherit; border-radius: 2px;';

/** Build (or reuse) the index for `dir`. Resolves to the prepared entries. */
function loadIndex(dir) {
    if (_fileCache && _fileCacheDir === dir) return Promise.resolve(_fileCache);
    if (_fileCachePromise && _fileCachePromise.dir === dir) return _fileCachePromise;

    const t0 = performance.now();
    const promise = FS.listAllFiles(dir).then((files) => {
        if (_fileCachePromise !== promise) return prepareEntries(files, dir); // superseded
        _fileCacheTotal = files.length;
        const kept = files.length > FILE_CACHE_LIMIT ? files.slice(0, FILE_CACHE_LIMIT) : files;
        _fileCache = prepareEntries(kept, dir);
        _fileCacheDir = dir;
        _fileCachePromise = null;
        promise.elapsed = Math.round(performance.now() - t0);
        return _fileCache;
    }, (err) => {
        if (_fileCachePromise === promise) _fileCachePromise = null;
        throw err;
    });
    promise.dir = dir;
    _fileCachePromise = promise;
    return promise;
}

/** Status line for the current index; `elapsed` only right after a walk. */
function indexStatus(statusBar, elapsed) {
    const timing = elapsed != null ? `, ${elapsed}ms` : '';
    if (_fileCacheTotal > FILE_CACHE_LIMIT) {
        statusBar.classList.add('jh-icon-row');
        statusBar.replaceChildren(iconEl('warning', { size: 11 }), document.createTextNode(
            `${FILE_CACHE_LIMIT.toLocaleString()}/${_fileCacheTotal.toLocaleString()} files (limit applied${timing}) — open a subfolder to search all of it`));
    } else {
        statusBar.classList.remove('jh-icon-row');
        statusBar.textContent = elapsed != null
            ? `${_fileCache.length.toLocaleString()} files indexed (${elapsed}ms)`
            : `${_fileCache.length.toLocaleString()} files (cached)`;
    }
}

/**
 * Append `text` to `parent`, with the [start, end) `ranges` wrapped in a
 * highlight span. Built from text nodes, so a file name is never parsed as
 * markup.
 */
function appendHighlighted(parent, text, ranges) {
    let at = 0;
    for (const [start, end] of ranges) {
        if (start > at) parent.appendChild(document.createTextNode(text.slice(at, start)));
        const mark = document.createElement('span');
        mark.className = 'file-search-hit';
        mark.style.cssText = HIGHLIGHT_STYLE;
        mark.textContent = text.slice(start, end);
        parent.appendChild(mark);
        at = end;
    }
    if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
}

export const FileSearchModal = {
    /** Invalidate cache (call when files change, e.g. after save, create, delete) */
    invalidateCache() {
        _fileCache = null;
        _fileCacheDir = null;
        _fileCacheTotal = 0;
        _fileCachePromise = null;
    },

    show() {
        if (!State.currentDir) {
            console.warn('No active workspace for file search');
            return;
        }

        // Remove existing if any
        const existing = document.getElementById('file-search-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'file-search-overlay';
        overlay.className = 'tab-search-overlay';

        const container = document.createElement('div');
        container.className = 'tab-search-container file-search-container';
        container.style.width = '600px';

        const inputWrapper = document.createElement('div');
        inputWrapper.style.position = 'relative';
        inputWrapper.style.display = 'flex';
        inputWrapper.style.alignItems = 'center';

        const searchIcon = document.createElement('span');
        searchIcon.appendChild(iconEl('search', { size: 14 }));
        searchIcon.style.display = 'inline-flex';
        searchIcon.style.position = 'absolute';
        searchIcon.style.left = '12px';
        searchIcon.style.opacity = '0.5';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tab-search-input';
        input.placeholder = 'Search files... (glob: *.txt, src/*.js)';
        input.style.paddingLeft = '35px';
        input.style.fontSize = '16px';
        input.style.height = '48px';

        inputWrapper.appendChild(searchIcon);
        inputWrapper.appendChild(input);

        // Status bar
        const statusBar = document.createElement('div');
        statusBar.style.cssText = 'padding: 4px 12px; font-size: 11px; opacity: 0.5; border-bottom: 1px solid var(--border-color);';
        statusBar.textContent = t('Loading files...');

        const list = document.createElement('ul');
        list.className = 'tab-search-list';
        list.style.maxHeight = '400px';

        let selectedIndex = 0;
        let searchResults = [];
        let debounceTimer = null;

        const updateSelection = () => {
            const items = list.querySelectorAll('.tab-search-item');
            items.forEach((li, i) => {
                if (i === selectedIndex) {
                    li.classList.add('selected');
                    li.scrollIntoView({ block: 'nearest' });
                } else {
                    li.classList.remove('selected');
                }
            });
        };

        const renderList = () => {
            list.innerHTML = '';

            if (searchResults.length === 0 && input.value.trim().length > 0) {
                const emptyMsg = document.createElement('li');
                emptyMsg.className = 'tab-search-item';
                emptyMsg.style.justifyContent = 'center';
                emptyMsg.style.opacity = '0.5';
                emptyMsg.textContent = t('No matching files found');
                list.appendChild(emptyMsg);
                return;
            }

            searchResults.forEach((hit, i) => {
                const li = document.createElement('li');
                li.className = 'tab-search-item';
                if (i === selectedIndex) li.classList.add('selected');

                // One shared extension→icon table (Icons.iconForFile), so the
                // explorer and this list cannot disagree about what a .rs file
                // looks like — they used different sets before.
                const icon = svgIcon(iconForFile(hit.name, hit.item.type === 'DIRECTORY'), { size: 14 });

                // Highlight what matched — in the name, the folder, or both
                // (a path or fuzzy-path match can span the two).
                const split = splitRelRanges(hit.relRanges, hit.rel, hit.name);
                const nameRanges = hit.nameRanges.length ? hit.nameRanges : split.nameRanges;
                // Folder relative to the workspace (rel = "dir/name", or "name")
                const displayDir = hit.rel.length > hit.name.length
                    ? hit.rel.substring(0, hit.rel.length - hit.name.length - 1)
                    : '';

                li.innerHTML = `
                    <span class="name" style="display: flex; align-items: center; gap: 8px;">
                        <span style="opacity: 0.8; display: inline-flex;">${icon}</span>
                        <span class="file-search-name" style="flex-shrink: 0;"></span>
                    </span>
                    <span class="dir" title="${escapeHtml(hit.item.dir)}"></span>
                `;
                appendHighlighted(li.querySelector('.file-search-name'), hit.name, nameRanges);
                appendHighlighted(li.querySelector('.dir'), displayDir, split.dirRanges);
                li.onclick = () => selectAndClose(hit);
                list.appendChild(li);
            });
            updateSelection();
        };

        const selectAndClose = (hit) => {
            const item = hit.item;
            if (item.type === 'DIRECTORY') return; // Do not open directories
            overlay.remove();

            // Construct full path
            let fullPath = item.path;
            const normalizedCurrentDir = State.currentDir.replace(/\\/g, '/');
            if (!fullPath.startsWith(normalizedCurrentDir) && !fullPath.match(/^[a-zA-Z]:\//)) {
                fullPath = FS.joinPath(State.currentDir, item.path);
            }
            openFile(fullPath);
        };

        // Ranking lives in utils/FileSearchRank.js: exact name > name prefix >
        // name substring > path substring > fuzzy, ties to recently opened,
        // then shorter paths.
        const performSearch = async () => {
            const rawQuery = input.value.trim();
            if (!rawQuery) {
                searchResults = [];
                renderList();
                return;
            }

            try {
                const dir = State.currentDir;
                const pending = (_fileCache && _fileCacheDir === dir) ? null : loadIndex(dir);
                const entries = pending ? await pending : _fileCache;
                if (!overlay.isConnected || input.value.trim() !== rawQuery) return; // typed on
                indexStatus(statusBar, pending ? pending.elapsed : null);

                searchResults = rankFiles(rawQuery, entries, {
                    limit: 100,
                    recent: RecentFiles.getFiles(),
                });

                selectedIndex = 0;
                renderList();
            } catch (err) {
                console.error('File search failed:', err);
                statusBar.textContent = t('Error loading files');
            }
        };

        input.addEventListener('input', () => {
            clearTimeout(debounceTimer);

            // Immediate UI feedback for empty
            if (!input.value.trim()) {
                searchResults = [];
                renderList();
                return;
            }

            // If cache is already loaded, search almost instantly
            if (_fileCache && _fileCacheDir === State.currentDir) {
                debounceTimer = setTimeout(() => {
                    performSearch();
                }, 50); // Very short debounce for cached search
            } else {
                list.innerHTML = '<li class="tab-search-item" style="justify-content: center; opacity: 0.5;">Loading file index...</li>';
                debounceTimer = setTimeout(() => {
                    performSearch();
                }, 150);
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.isComposing) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                if (searchResults.length > 0) {
                    selectedIndex = (selectedIndex + 1) % searchResults.length;
                    updateSelection();
                }
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                if (searchResults.length > 0) {
                    selectedIndex = (selectedIndex - 1 + searchResults.length) % searchResults.length;
                    updateSelection();
                }
                return;
            } else if (e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                if (searchResults.length > 0) {
                    if (e.shiftKey) {
                        selectedIndex = (selectedIndex - 1 + searchResults.length) % searchResults.length;
                    } else {
                        selectedIndex = (selectedIndex + 1) % searchResults.length;
                    }
                    updateSelection();
                }
                return;
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (searchResults[selectedIndex]) {
                    selectAndClose(searchResults[selectedIndex]);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                overlay.remove();
            }
        });

        // Close on click outside
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        container.appendChild(inputWrapper);
        container.appendChild(statusBar);
        container.appendChild(list);
        overlay.appendChild(container);
        document.body.appendChild(overlay);

        // Pre-load cache in background (the search shares the same walk)
        if (!_fileCache || _fileCacheDir !== State.currentDir) {
            statusBar.textContent = t('Indexing files...');
            const pending = loadIndex(State.currentDir);
            pending.then(() => {
                if (overlay.isConnected) indexStatus(statusBar, pending.elapsed);
            }).catch(err => {
                statusBar.textContent = t('Failed to index files');
                console.error('File indexing failed:', err);
            });
        } else {
            indexStatus(statusBar, null);
        }

        // Initial empty render
        renderList();
        input.focus();
    }
};
