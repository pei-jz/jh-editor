import { State } from '../core/Store.js';
import { icon as svgIcon, iconEl, iconForFile } from './Icons.js';
import { openFile } from '../core/Editor.js';
import * as FS from '../utils/FileSystem.js';

// Persistent file cache (survives modal close/reopen)
const FILE_CACHE_LIMIT = 50000; // Max files to cache (paths only; a few MB)
let _fileCache = null;
let _fileCacheDir = null;

export const FileSearchModal = {
    /** Invalidate cache (call when files change, e.g. after save, create, delete) */
    invalidateCache() {
        _fileCache = null;
        _fileCacheDir = null;
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
        statusBar.textContent = 'Loading files...';

        const list = document.createElement('ul');
        list.className = 'tab-search-list';
        list.style.maxHeight = '400px';

        let selectedIndex = 0;
        let searchResults = [];
        let debounceTimer = null;
        let currentRegex = null;

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
                emptyMsg.textContent = 'No matching files found';
                list.appendChild(emptyMsg);
                return;
            }

            searchResults.forEach((item, i) => {
                const li = document.createElement('li');
                li.className = 'tab-search-item';
                if (i === selectedIndex) li.classList.add('selected');

                // One shared extension→icon table (Icons.iconForFile), so the
                // explorer and this list cannot disagree about what a .rs file
                // looks like — they used different sets before.
                const icon = svgIcon(iconForFile(item.entry, item.type === 'DIRECTORY'), { size: 14 });

                // Highlight match
                const rawQuery = input.value.trim();
                const query = rawQuery.toLowerCase();
                let nameHtml = item.entry;
                if (currentRegex && currentRegex.test(item.entry)) {
                    nameHtml = `<span style="background: rgba(var(--primary-rgb, 0, 122, 204), 0.4); color: inherit; border-radius: 2px;">${item.entry}</span>`;
                } else if (query && !currentRegex) {
                    const matchIndex = item.entry.toLowerCase().indexOf(query);
                    if (matchIndex >= 0) {
                        nameHtml = item.entry.substring(0, matchIndex) + 
                                   `<span style="background: rgba(var(--primary-rgb, 0, 122, 204), 0.4); color: inherit; border-radius: 2px;">${item.entry.substring(matchIndex, matchIndex + query.length)}</span>` + 
                                   item.entry.substring(matchIndex + query.length);
                    }
                }

                // Show relative dir path (relative to workspace)
                let displayDir = item.dir || '';
                const normalizedWorkspace = State.currentDir.replace(/\\/g, '/');
                if (displayDir.startsWith(normalizedWorkspace)) {
                    displayDir = displayDir.substring(normalizedWorkspace.length);
                    if (displayDir.startsWith('/')) displayDir = displayDir.substring(1);
                }

                li.innerHTML = `
                    <span class="name" style="display: flex; align-items: center; gap: 8px;">
                        <span style="opacity: 0.8; display: inline-flex;">${icon}</span>
                        <span style="flex-shrink: 0;">${nameHtml}</span>
                    </span>
                    <span class="dir" title="${item.dir}">${displayDir}</span>
                `;
                
                li.onclick = () => selectAndClose(item);
                list.appendChild(li);
            });
            updateSelection();
        };

        const selectAndClose = (item) => {
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

        // Convert glob pattern to regex
        const globToRegex = (pattern) => {
            // Check if pattern contains path separators -> path glob
            const hasPath = pattern.includes('/');
            
            // Escape regex special chars except * and ?
            const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
            // Convert glob wildcards
            const converted = escaped
                .replace(/\*\*/g, '§§')        // ** -> placeholder
                .replace(/\*/g, '[^/]*')        // * -> match within segment
                .replace(/§§/g, '.*')           // ** -> match across segments
                .replace(/\?/g, '.');            // ? -> single char
            
            if (hasPath) {
                // Path-based glob: match against relative path
                return { regex: new RegExp(`${converted}$`, 'i'), matchPath: true };
            } else {
                // Filename-only glob: match against filename
                return { regex: new RegExp(`^${converted}$`, 'i'), matchPath: false };
            }
        };

        const performSearch = async () => {
            const rawQuery = input.value.trim();
            const query = rawQuery.toLowerCase();
            if (!query) {
                searchResults = [];
                currentRegex = null;
                renderList();
                return;
            }

            try {
                // Load file cache if needed
                if (!_fileCache || _fileCacheDir !== State.currentDir) {
                    const t0 = performance.now();
                    let allFiles = await FS.listAllFiles(State.currentDir);
                    const elapsed = Math.round(performance.now() - t0);
                    const totalCount = allFiles.length;
                    
                    if (totalCount > FILE_CACHE_LIMIT) {
                        // Over limit: truncate and don't persist cache
                        allFiles = allFiles.slice(0, FILE_CACHE_LIMIT);
                        _fileCache = allFiles;
                        _fileCacheDir = null; // Don't persist - re-fetch next time
                        statusBar.classList.add('jh-icon-row');
                statusBar.replaceChildren(iconEl('warning', { size: 11 }), document.createTextNode(
                    `${FILE_CACHE_LIMIT.toLocaleString()}/${totalCount.toLocaleString()} files (limit applied, ${elapsed}ms)`));
                    } else {
                        _fileCache = allFiles;
                        _fileCacheDir = State.currentDir;
                        statusBar.textContent = `${totalCount.toLocaleString()} files indexed (${elapsed}ms)`;
                    }
                } else {
                    statusBar.textContent = `${_fileCache.length.toLocaleString()} files (cached)`;
                }
                
                const isGlob = rawQuery.includes('*') || rawQuery.includes('?');
                currentRegex = null;
                let matchPath = false;

                if (isGlob) {
                    try {
                        const result = globToRegex(rawQuery);
                        currentRegex = result.regex;
                        matchPath = result.matchPath;
                    } catch (e) {
                        currentRegex = null;
                    }
                }
                
                searchResults = _fileCache.filter(item => {
                    const entryName = item.entry || item.name || item.path.split(/[/\\]/).pop();
                    if (currentRegex) {
                        if (matchPath) {
                            // Match against relative path
                            const normalizedWorkspace = State.currentDir.replace(/\\/g, '/');
                            let relPath = item.path;
                            if (relPath.startsWith(normalizedWorkspace)) {
                                relPath = relPath.substring(normalizedWorkspace.length);
                                if (relPath.startsWith('/')) relPath = relPath.substring(1);
                            }
                            return currentRegex.test(relPath);
                        }
                        return currentRegex.test(entryName);
                    }
                    return entryName.toLowerCase().includes(query);
                }).slice(0, 100);

                selectedIndex = 0;
                renderList();
            } catch (err) {
                console.error('File search failed:', err);
                statusBar.textContent = 'Error loading files';
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

        // Pre-load cache in background
        if (!_fileCache || _fileCacheDir !== State.currentDir) {
            statusBar.textContent = 'Indexing files...';
            FS.listAllFiles(State.currentDir).then(files => {
                const totalCount = files.length;
                if (totalCount > FILE_CACHE_LIMIT) {
                    _fileCache = files.slice(0, FILE_CACHE_LIMIT);
                    _fileCacheDir = null; // Don't persist
                    statusBar.classList.add('jh-icon-row');
            statusBar.replaceChildren(iconEl('warning', { size: 11 }), document.createTextNode(
                `${FILE_CACHE_LIMIT.toLocaleString()}/${totalCount.toLocaleString()} files (limit applied)`));
                } else {
                    _fileCache = files;
                    _fileCacheDir = State.currentDir;
                    statusBar.textContent = `${totalCount.toLocaleString()} files indexed`;
                }
            }).catch(err => {
                statusBar.textContent = 'Failed to index files';
                console.error('File indexing failed:', err);
            });
        } else {
            statusBar.textContent = `${_fileCache.length.toLocaleString()} files (cached)`;
        }

        // Initial empty render
        renderList();
        input.focus();
    }
};
