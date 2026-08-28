import { EL } from './Constants.js';
import { State } from './Store.js';
import { iconEl, iconForFile } from '../ui/Icons.js';
import * as FS from '../utils/FileSystem.js';
import { VirtualScroll } from '../utils/VirtualScroll.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { GrepModal } from '../ui/GrepModal.js';
import { showCustomInput, showCustomConfirm, showNewFileModal } from '../ui/Modal.js';
import { shortcuts } from './ShortcutManager.js';
import { SHORTCUTS } from './ShortcutDefinitions.js';
import { save } from '@tauri-apps/plugin-dialog';
import { showAlert } from '../ui/Dialog.js';
import { invoke } from '@tauri-apps/api/core';

let openFileCallback = null;
let clipboardAction = null;

// Virtual Explorer Instance
let vExplorer = null;

class VirtualExplorer {
    constructor(container) {
        this.container = container;
        this.flatItems = [];
        this.dirCache = new Map(); // path -> entries[]
        this.selectedPaths = new Set();
        this.lastClickedIndex = -1;
        this.rowHeight = 26; // px
        this.gitStatus = { staged: new Set(), modified: new Set(), untracked: new Set() };

        this._onGitStatus = (e) => {
            if (!State.currentDir) return; // Guard against null currentDir when workspace is not open
            const status = e.detail;
            // git reports an untracked directory with a trailing slash ("docs/");
            // strip it so the directory's own tree item matches by path.
            const norm = (f) => {
                let p = FS.joinPath(State.currentDir, f);
                if (p.endsWith('/')) p = p.slice(0, -1);
                return p;
            };
            this.gitStatus.staged = new Set((status.staged || []).map(norm));
            this.gitStatus.modified = new Set((status.modified || []).map(norm));
            this.gitStatus.untracked = new Set((status.untracked || []).map(norm));

            // Propagate CHANGES (staged/modified) up to parent folders so a
            // collapsed folder shows it contains edits.
            const addParents = (fileSet, folderSet) => {
                fileSet.forEach(filePath => {
                    let p = FS.getParentDir(filePath);
                    while (p && p.length >= State.currentDir.length) {
                        folderSet.add(p);
                        p = FS.getParentDir(p);
                    }
                });
            };

            this.gitStatus.folderStaged = new Set();
            this.gitStatus.folderModified = new Set();
            // Untracked is intentionally NOT propagated to parents: a tracked
            // folder must not look "new" (green U) just because it holds a
            // nested untracked file. Only a folder git itself reports as
            // untracked is coloured (matched directly via the untracked set).
            this.gitStatus.folderUntracked = new Set();

            addParents(this.gitStatus.staged, this.gitStatus.folderStaged);
            addParents(this.gitStatus.modified, this.gitStatus.folderModified);

            this.scroller.onScroll(); // Force re-render
        };
        window.addEventListener('git-status-updated', this._onGitStatus);

        this.focusedIndex = -1;

        // Ensure container is scrollable and relative
        this.container.style.position = 'relative';
        this.container.style.overflowY = 'auto'; // VirtualScroll handles this scroll
        this.container.style.overflowX = 'hidden';
        this.container.tabIndex = 0; // Make container focusable
        this.container.style.outline = 'none';

        // Content Host (Height Spacer)
        this.contentHost = document.createElement('div');
        this.contentHost.className = 'virtual-explorer-host';
        this.contentHost.style.position = 'relative';
        this.contentHost.style.minHeight = '100%';
        this.container.innerHTML = '';
        this.container.appendChild(this.contentHost);

        this.scroller = new VirtualScroll(this.container, 0, this.rowHeight, this.render.bind(this));

        // Key Navigation
        this._onKeyDown = this.handleKeyDown.bind(this);
        this.container.addEventListener('keydown', this._onKeyDown);

        // Focus Logic
        this.container.addEventListener('focus', () => {
            const header = document.getElementById('explorer-header');
            if (header) header.classList.add('active');
            // Clear Editor Headers
            document.querySelectorAll('#editor-container .pane-header').forEach(h => h.classList.remove('active'));
        });
        this.container.addEventListener('blur', () => {
            const header = document.getElementById('explorer-header');
            if (header) header.classList.remove('active');
        });
    }

    /** Tear down listeners so a re-init can't leave ghost handlers behind. */
    destroy() {
        if (this.scroller) this.scroller.destroy();
        if (this._onGitStatus) window.removeEventListener('git-status-updated', this._onGitStatus);
        if (this._onKeyDown) this.container.removeEventListener('keydown', this._onKeyDown);
        this.container.innerHTML = '';
    }

    handleKeyDown(e) {
        // Stamp the event so the markdown views' window-level CAPTURE handlers
        // (which run AFTER ShortcutManager dispatched us, on the SAME window
        // node) can detect "the explorer already owns this key". Their old
        // e.target-based guard is unreliable here: setFocus() →
        // scroller.onScroll() → render() synchronously wipes
        // contentHost.innerHTML, detaching the focused row before the later
        // handlers run — so e.target.closest('#explorer') is null and
        // document.activeElement has already dropped to <body>.
        e.__explorerKeyDown = true;
        if (this.flatItems.length === 0) return;
        // While an inline rename is active the input owns all keys
        // (Enter commits, Escape cancels, arrows type). Never navigate,
        // open or delete from here during a rename.
        if (this._renaming) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.setFocus(Math.min(this.flatItems.length - 1, this.focusedIndex + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.setFocus(Math.max(0, this.focusedIndex - 1));
        } else if (e.key === 'ArrowRight') {
            // Expand
            e.preventDefault();
            const item = this.flatItems[this.focusedIndex];
            if (item) {
                if (item.type === 'DIRECTORY') {
                    if (!item.expanded) {
                        this.toggle(item);
                    } else {
                        // If expanded, go to first child
                        if (this.focusedIndex + 1 < this.flatItems.length) {
                            const next = this.flatItems[this.focusedIndex + 1];
                            if (next.level > item.level) {
                                this.setFocus(this.focusedIndex + 1);
                            }
                        }
                    }
                }
            }
        } else if (e.key === 'ArrowLeft') {
            // Collapse or Go Parent
            e.preventDefault();
            const item = this.flatItems[this.focusedIndex];
            if (item) {
                if (item.type === 'DIRECTORY' && item.expanded) {
                    this.toggle(item);
                } else if (item.parent) {
                    // Find parent index
                    const parentIndex = this.flatItems.findIndex(x => x.path === item.parent);
                    if (parentIndex >= 0) this.setFocus(parentIndex);
                }
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const item = this.flatItems[this.focusedIndex];
            if (item) {
                if (item.type === 'DIRECTORY') this.toggle(item);
                else if (openFileCallback) openFileCallback(item.path);
            }
        } else if (e.key === 'Delete') {
            e.preventDefault();
            const item = this.flatItems[this.focusedIndex];
            if (item) handleDelete(item.path);
        } else if (e.ctrlKey) {
            const item = this.flatItems[this.focusedIndex];
            if (e.key === 'c' || e.key === 'C') {
                if (item) handleCopy(item.path);
            } else if (e.key === 'x' || e.key === 'X') {
                if (item) handleCut(item.path);
            } else if (e.key === 'v' || e.key === 'V') {
                // Paste into current dir (if dir) or parent (if file)
                if (item) {
                    const target = item.type === 'DIRECTORY' ? item.path : FS.getParentDir(item.path);
                    handlePaste(target);
                } else if (this.rootPath) {
                    handlePaste(this.rootPath);
                }
            } else if (e.key === 'n' || e.key === 'N') {
                // New File in current focus dir or root
                e.preventDefault();
                const dir = (item && item.type === 'DIRECTORY') ? item.path : (item ? FS.getParentDir(item.path) : State.currentDir);
                handleNewFile(dir);
            }
        } else if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) {
                // Explorer (Shift+Tab) -> Right Editor (Source) or Main
                const sourceEdit = document.querySelector('.source-layer-edit'); // The textarea I added
                if (sourceEdit) {
                    sourceEdit.focus();
                } else {
                    // Try plain editor
                    const editor = document.querySelector('.plain-text-editor, textarea.csv-text-editor, .cm-content');
                    if (editor) editor.focus();
                }
            } else {
                // Explorer (Tab) -> Left Editor (Tree) or Main
                const structureEditor = document.querySelector('.structure-editor');
                if (structureEditor) {
                    structureEditor.focus();
                } else {
                    const editor = document.querySelector('.plain-text-editor, textarea.csv-text-editor, .cm-content');
                    if (editor) editor.focus();
                }
            }
        }
    }


    setFocus(index) {
        if (index < 0 || index >= this.flatItems.length) return;
        this.focusedIndex = index;

        // Ensure visible
        // VirtualScroll usually assumes uniform height? 
        // "scrollTo" isn't strictly on my VirtualScroll implementation unless I added it?
        // Let's check VirtualScroll implementation or just set scrollTop.
        const top = index * this.rowHeight;
        const bottom = top + this.rowHeight;

        if (top < this.container.scrollTop) {
            this.container.scrollTop = top;
        } else if (bottom > this.container.scrollTop + this.container.clientHeight) {
            this.container.scrollTop = bottom - this.container.clientHeight;
        }

        // Trigger render update for class
        this.scroller.onScroll();

        // Force focus on DOM element if visible
        setTimeout(() => {
            // Don't steal focus while an inline rename is active.
            if (this._renaming) return;
            const row = this.container.querySelector(`[data-index="${index}"]`);
            if (row) row.focus();
        }, 0);
    }

    async setRoot(rootPath) {
        this.rootPath = rootPath;
        await this.refresh();
    }

    setData(flatItems) {
        // Invalidate any in-flight buildFlatList so it cannot append to the
        // freshly assigned list (e.g. search results replacing the tree while
        // a folder-toggle refresh is still awaiting a directory read).
        this._refreshGen = (this._refreshGen || 0) + 1;
        this.flatItems = flatItems;
        this.focusedIndex = -1; // Reset focus when data completely changes (e.g. search)
        this.scroller.update(this.flatItems.length);
    }

    async refresh() {
        // Generation guard. refresh() is async (it awaits directory reads), so
        // two overlapping refreshes — quick expand/collapse, git status
        // updates, multi-select clicks — used to INTERLEAVE their
        // buildFlatList pushes into the same flatItems array, doubling rows.
        // A stale build must stop as soon as a newer refresh takes over.
        const gen = (this._refreshGen || 0) + 1;
        this._refreshGen = gen;

        // Capture Focus
        let focusedPath = null;
        if (this.focusedIndex >= 0 && this.flatItems[this.focusedIndex]) {
            focusedPath = this.flatItems[this.focusedIndex].path;
        }

        // Rebuild flat items based on Root + Expanded State
        this.flatItems = [];
        if (this.rootPath) {
            await this.buildFlatList(this.rootPath, 0, gen);
        }

        // A newer refresh superseded us — leave the UI to it.
        if (gen !== this._refreshGen) return;

        this.scroller.update(this.flatItems.length);

        // Restore Focus
        if (focusedPath) {
            const newIndex = this.flatItems.findIndex(x => x.path === focusedPath);
            if (newIndex >= 0) {
                // Determine if we should scroll? 
                // If it was visible, keep it visible. 
                // setFocus handles visibility check.
                this.setFocus(newIndex);
            } else {
                this.focusedIndex = -1; // Lost
            }
        }
    }

    async buildFlatList(dirPath, level, gen) {
        // Abort as soon as a newer refresh superseded this build.
        if (gen !== this._refreshGen) return false;
        let entries = this.dirCache.get(dirPath);
        if (!entries) {
            try {
                entries = await FS.readDirectory(dirPath);
                entries = this.sortEntries(entries);
                this.dirCache.set(dirPath, entries);
            } catch (e) {
                console.error('Explorer: readDirectory failed', dirPath, e);
                return false;
            }
        }

        for (const entry of entries) {
            if (entry.entry === '.' || entry.entry === '..') continue;

            // Abort mid-loop once a newer refresh has taken over.
            if (gen !== this._refreshGen) return false;

            const fullPath = FS.joinPath(dirPath, entry.entry);
            const isDir = entry.type === 'DIRECTORY';
            const isExpanded = State.expandedFolders.has(fullPath);

            this.flatItems.push({
                path: fullPath,
                name: entry.entry,
                type: entry.type,
                level: level,
                expanded: isExpanded,
                parent: dirPath
            });

            if (isDir && isExpanded) {
                const ok = await this.buildFlatList(fullPath, level + 1, gen);
                if (!ok) return false;
            }
        }
        return true;
    }

    sortEntries(entries) {
        // Pre-compute lowercase names for O(1) comparison in sort loop
        for (let i = 0; i < entries.length; i++) {
            entries[i]._low = entries[i].entry.toLowerCase();
        }
        
        entries.sort((a, b) => {
            if (a.type === b.type) {
                if (a._low < b._low) return -1;
                if (a._low > b._low) return 1;
                return 0;
            }
            return a.type === 'DIRECTORY' ? -1 : 1;
        });
        
        // Clean up memory
        for (let i = 0; i < entries.length; i++) {
            delete entries[i]._low;
        }
        return entries;
    }

    render({ startIndex, endIndex, offsetY, totalHeight }) {
        this.contentHost.style.height = totalHeight + 'px';
        this.contentHost.innerHTML = '';

        // The contentHost is attached exactly once in the constructor and must
        // NEVER be re-appended here: a stale VirtualScroll from a superseded
        // VirtualExplorer instance re-attaches its own (still-dangling) host on
        // every scroll, leaving TWO hosts inside #file-list and making the tree
        // appear duplicated.

        // Chunk Container
        const chunk = document.createElement('div');
        chunk.style.position = 'absolute';
        chunk.style.top = offsetY + 'px';
        chunk.style.left = '0';
        chunk.style.width = '100%';

        const slice = this.flatItems.slice(startIndex, endIndex + 1);
        slice.forEach((item, i) => {
            const row = this.createRow(item, startIndex + i);
            chunk.appendChild(row);
        });

        this.contentHost.appendChild(chunk);
    }

    showMessage(text) {
        this.contentHost.style.opacity = '0.3';
        const parent = this.container.parentElement || this.container;
        let msg = parent.querySelector('.explorer-message');
        if (!msg) {
            msg = document.createElement('div');
            msg.className = 'explorer-message';
            msg.style.position = 'absolute';
            msg.style.bottom = '0';
            msg.style.left = '0';
            msg.style.right = '0';
            msg.style.background = 'var(--bg-active)';
            msg.style.padding = '8px 12px';
            msg.style.fontSize = '12px';
            msg.style.borderTop = '1px solid var(--border-color)';
            msg.style.zIndex = '9999';
            parent.appendChild(msg);
        }
        msg.textContent = text;
        msg.style.display = 'block';
    }

    showProgress(scanned, total, found, currentPath, percent) {
        this.contentHost.style.opacity = '0.3';
        const parent = this.container.parentElement || this.container;
        let container = parent.querySelector('.explorer-message');
        if (!container) {
            container = document.createElement('div');
            container.className = 'explorer-message';
            container.style.position = 'absolute';
            container.style.bottom = '0';
            container.style.left = '0';
            container.style.right = '0';
            container.style.background = 'var(--bg-active)';
            container.style.padding = '8px 12px';
            container.style.fontSize = '12px';
            container.style.borderTop = '1px solid var(--border-color)';
            container.style.zIndex = '9999';
            parent.appendChild(container);
        }
        container.style.display = 'block';
        container.style.zIndex = '9999';

        container.innerHTML = `
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%; font-weight: 500;">Scanning: ${currentPath}</span>
                <span style="font-weight: 600; color: var(--primary-color);">${percent}%</span>
            </div>
            <div class="explorer-progress-container" style="background: rgba(255,255,255,0.08); height: 4px; border-radius: 2px; overflow: hidden; margin-bottom: 4px;">
                <div class="explorer-progress-bar" style="width: ${percent}%; height: 100%; background: var(--primary-color); border-radius: 2px; transition: width 0.1s ease;"></div>
            </div>
            <div style="font-size: 11px; opacity: 0.8; color: var(--text-color);">
                Scanned: ${scanned} / ${total} | Found: ${found}
            </div>
        `;
    }

    clearMessage() {
        this.contentHost.style.opacity = '1';
        const parent = this.container.parentElement || this.container;
        const msg = parent.querySelector('.explorer-message');
        if (msg) msg.style.display = 'none';
    }

    createRow(item, index) {
        const div = document.createElement('div');
        div.className = 'tree-item';
        div.style.paddingLeft = `${item.level * 15 + 10}px`;
        div.style.height = `${this.rowHeight}px`;
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.tabIndex = -1; // Managed via Arrow Keys now
        div.dataset.path = item.path;
        div.dataset.index = index;

        // Icon Logic
        const isDir = item.type === 'DIRECTORY';
        const arrow = document.createElement('span');
        arrow.className = 'tree-arrow';
        if (isDir) {
            // `.tree-arrow.expanded` already rotates this 90°, so one
            // chevron covers both states instead of swapping glyphs.
            arrow.replaceChildren(iconEl('chevron-right', { size: 11 }));
            arrow.style.visibility = 'visible';
            if (item.expanded) {
                arrow.classList.add('expanded');
                div.classList.add('expanded');
            }
            arrow.onclick = (e) => {
                e.stopPropagation();
                this.toggle(item);
                this.setFocus(index);
            };
        } else {
            arrow.style.visibility = 'hidden';
        }

        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.replaceChildren(iconEl(iconForFile(item.name, isDir, item.expanded), { size: 14 }));

        const label = document.createElement('span');
        label.textContent = item.name;
        label.className = 'tree-label';

        // Git Status Styling
        if (this.gitStatus.staged.has(item.path) || this.gitStatus.folderStaged?.has(item.path)) div.classList.add('git-staged');
        else if (this.gitStatus.modified.has(item.path) || this.gitStatus.folderModified?.has(item.path)) div.classList.add('git-modified');
        else if (this.gitStatus.untracked.has(item.path) || this.gitStatus.folderUntracked?.has(item.path)) div.classList.add('git-untracked');

        // Active Selection Styling
        if (this.focusedIndex === index) {
            div.classList.add('focused'); // Keyboard Focus
        }

        if (this.selectedPaths.has(item.path)) {
            div.classList.add('selected');
        }

        if (State.activeTabIndex >= 0 && State.openFiles[State.activeTabIndex]) {
            const activePath = State.openFiles[State.activeTabIndex].path;
            if (activePath === item.path) {
                div.classList.add('selected-active');
            }
        }

        div.appendChild(arrow);
        div.appendChild(icon);
        div.appendChild(label);

        div.onclick = (e) => {
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey) {
                if (this.selectedPaths.has(item.path)) {
                    this.selectedPaths.delete(item.path);
                } else {
                    this.selectedPaths.add(item.path);
                }
                this.setFocus(index);
                this.lastClickedIndex = index;
                this.refresh();
            } else if (e.shiftKey && this.lastClickedIndex !== -1) {
                const start = Math.min(this.lastClickedIndex, index);
                const end = Math.max(this.lastClickedIndex, index);
                this.selectedPaths.clear();
                for (let i = start; i <= end; i++) {
                    if (this.flatItems[i]) this.selectedPaths.add(this.flatItems[i].path);
                }
                this.setFocus(index);
                this.refresh();
            } else {
                this.selectedPaths.clear();
                this.selectedPaths.add(item.path);
                this.lastClickedIndex = index;
                if (isDir) {
                    this.toggle(item);
                } else {
                    if (openFileCallback) openFileCallback(item.path);
                }
                // Re-focus explorer so keyboard shortcuts (Delete, etc.) still work
                this.setFocus(index);
                this.refresh();
            }
            // Ensure explorer retains focus after click so Delete/F2/etc. work
            setTimeout(() => this.container.focus(), 50);
        };

        div.onkeydown = (e) => {
            // F2 (rename) is intentionally NOT handled here: the EXPLORER-scoped
            // shortcut (explorer:rename) owns it. A row-level handler would race
            // it (capture-phase ShortcutManager runs first) and could open the
            // rename input twice. Ctrl+N stays local for convenience.
            if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                e.stopPropagation();
                handleNewFile(isDir ? item.path : FS.getParentDir(item.path));
            }
        };

        this.attachEvents(div, item);

        return div;
    }

    startRenaming(div, item, labelSpan) {
        // Renaming guard: setFocus() schedules a setTimeout that re-focuses the
        // row. Without this flag that timer would steal focus from the rename
        // input right after we .focus() it (blur → commit → input disappears
        // instantly), which is exactly why the inline rename never appeared.
        this._renaming = true;
        labelSpan.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = item.name;
        input.className = 'rename-input';
        input.style.flex = '1';
        input.style.background = 'var(--bg-color)';
        input.style.color = 'var(--text-color)';
        input.style.border = '1px solid var(--accent-color)';
        input.style.height = '20px';
        input.style.marginLeft = '5px';
        input.style.outline = 'none';

        div.appendChild(input);
        input.focus();
        input.select();

        let commited = false;

        const commit = async () => {
            if (commited) return;
            commited = true;
            this._renaming = false;
            const newName = input.value.trim();

            if (input.parentNode) input.parentNode.removeChild(input);
            labelSpan.style.display = 'inline';
            div.focus();

            if (newName && newName !== item.name) {
                const parent = item.parent || FS.getParentDir(item.path);
                const newPath = FS.joinPath(parent, newName);
                try {
                    if (await FS.exists(newPath)) {
                        showAlert('File exists!', { title: 'Rename', kind: 'warning' });
                        return;
                    }
                    await FS.rename(item.path, newPath);
                    if (this.dirCache) this.dirCache.delete(parent);
                    await loadExplorer();
                } catch (err) {
                    showAlert('Rename failed: ' + err, { title: 'Rename', kind: 'error' });
                }
            }
        };

        const cancel = () => {
            if (commited) return;
            commited = true;
            this._renaming = false;
            if (input.parentNode) input.parentNode.removeChild(input);
            labelSpan.style.display = 'inline';
            div.focus();
        };

        input.onblur = commit;
        input.onkeydown = (e) => {
            e.stopPropagation(); // STOP PROPAGATION (Fix Delete/Shortcuts firing)
            if (e.key === 'Enter') { commit(); }
            if (e.key === 'Escape') { cancel(); }
        };

        input.onclick = (e) => e.stopPropagation();
    }

    async toggle(item) {
        if (item.type !== 'DIRECTORY') return;

        if (item.expanded) {
            State.expandedFolders.delete(item.path);
        } else {
            State.expandedFolders.add(item.path);
        }

        // If searching, we need to re-render the filtered tree with updated expansion
        if (State.explorerSearchTerm && State.explorerSearchTerm.trim()) {
            await loadExplorer();
        } else {
            if (!item.expanded && !this.dirCache.has(item.path)) {
                this.showMessage('Loading directory...');
                // Give browser 10ms to paint the "Loading..." message before blocking
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            await this.refresh();
            this.clearMessage();
        }
    }

    attachEvents(div, item) {
        div.draggable = true;
        div.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            // Support multi-item drag: use selected paths
            const dragPaths = this.selectedPaths.has(item.path)
                ? Array.from(this.selectedPaths)
                : [item.path];
            e.dataTransfer.setData('text/plain', dragPaths.join('\n'));
            e.dataTransfer.setData('application/x-editor-item', 'true');
            e.dataTransfer.effectAllowed = 'move';
            // Style dragged items
            div.style.opacity = '0.5';
            const onDragEnd = () => { div.style.opacity = ''; };
            div.addEventListener('dragend', onDragEnd, { once: true });
        });

        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.setFocus(parseInt(div.dataset.index)); // Focus on right click

            if (!this.selectedPaths.has(item.path)) {
                this.selectedPaths.clear();
                this.selectedPaths.add(item.path);
                this.lastClickedIndex = parseInt(div.dataset.index);
                this.refresh();
            }

            const paths = Array.from(this.selectedPaths);
            const isDir = item.type === 'DIRECTORY';
            const menuItems = [
                { label: 'Refresh', action: () => { paths.forEach(p => this.dirCache.delete(p)); this.refresh(); } },
                { type: 'separator' },
                { label: 'New File', action: () => handleNewFile(isDir ? item.path : FS.getParentDir(item.path)) },
                { label: 'New Folder', action: () => handleNewFolder(isDir ? item.path : FS.getParentDir(item.path)) },
                { type: 'separator' },
                { label: 'Rename', action: () => handleRename(paths[0]) },
                { label: `Delete (${paths.length})`, action: () => handleDelete(paths) },
                { type: 'separator' },
                { label: `Cut (${paths.length})`, action: () => handleCut(paths) },
                { label: `Copy (${paths.length})`, action: () => handleCopy(paths) },
                { label: 'Paste', action: () => handlePaste(isDir ? item.path : FS.getParentDir(item.path)) },
                { type: 'separator' },
                { label: 'Find in Folder', action: () => {
                    // Grep within this folder (a file → its parent folder).
                    const dir = isDir ? item.path : FS.getParentDir(item.path);
                    GrepModal.show(dir);
                } },
                { type: 'separator' },
                { label: isDir ? 'Reveal in File Manager' : 'Reveal in File Manager',
                  action: async () => {
                      try {
                          await invoke('reveal_in_file_manager', { path: item.path });
                      } catch (e) {
                          console.error('reveal_in_file_manager failed', e);
                          if (window.showToast) window.showToast('Could not open the file manager');
                      }
                  } },
            ];

            // Exactly two items of the SAME kind selected → offer a comparison.
            // Selection order isn't tracked, so use tree order: the upper one is
            // "left" (original) and the lower one "right" (modified).
            // Via window.app: Editor.js already imports this module, so
            // importing it back here would be a circular dependency.
            const picked = (kind) => this.flatItems
                .filter(it => it.type === kind && this.selectedPaths.has(it.path))
                .map(it => it.path);
            const selectedFiles = picked('FILE');
            const selectedDirs = picked('DIRECTORY');

            if (selectedFiles.length === 2 && selectedDirs.length === 0) {
                const [leftPath, rightPath] = selectedFiles;
                menuItems.splice(1, 0,
                    { label: `Compare: ${FS.getBasename(leftPath)} / ${FS.getBasename(rightPath)}`,
                      action: () => window.app.compareTwoFiles(leftPath, rightPath) },
                    { type: 'separator' },
                );
            } else if (selectedDirs.length === 2 && selectedFiles.length === 0) {
                const [leftDir, rightDir] = selectedDirs;
                menuItems.splice(1, 0,
                    { label: `Compare Folders: ${FS.getBasename(leftDir)} / ${FS.getBasename(rightDir)}`,
                      action: () => window.app.compareTwoFolders(leftDir, rightDir) },
                    { type: 'separator' },
                );
            }
            ContextMenu.show(e, menuItems);
        });

        // Drop target: directories accept drops to move into them;
        // files accept drops to move into their parent directory.
        const isDropTarget = item.type === 'DIRECTORY' || item.type === 'FILE';
        if (isDropTarget) {
            const targetDir = item.type === 'DIRECTORY' ? item.path : FS.getParentDir(item.path);

            div.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Check if we're dragging a child of this target — prevent self-drop
                const srcPaths = (e.dataTransfer.getData('text/plain') || '').split('\n').filter(Boolean);
                const isSelfOrChild = srcPaths.some(src => {
                    const normalized = src.replace(/\\/g, '/');
                    const normalizedTarget = (item.type === 'DIRECTORY' ? item.path : FS.getParentDir(item.path)).replace(/\\/g, '/');
                    return normalized === normalizedTarget || normalizedTarget.startsWith(normalized + '/');
                });
                if (isSelfOrChild) {
                    e.dataTransfer.dropEffect = 'none';
                    div.style.opacity = '';
                } else {
                    e.dataTransfer.dropEffect = 'move';
                    div.style.outline = '1px dashed var(--primary-color, #3b82f6)';
                    div.style.outlineOffset = '-1px';
                }
            });
            div.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                div.style.outline = '';
                div.style.outlineOffset = '';
            });
            div.addEventListener('drop', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                div.style.outline = '';
                div.style.outlineOffset = '';
                await handleDropEvent(e, targetDir);
            });
        }
    }
}

// --- Init & Exports ---

let closeFileCallback = null;
let closeFilesUnderDirCallback = null;

const explorerActions = {
    'explorer:nav': (e) => {
        // Nav is handled by VirtualExplorer internal listener for performance
        // but it could be dispatched here.
    },
    'explorer:rename': () => {
        if (!vExplorer) return;
        const item = vExplorer.flatItems[vExplorer.focusedIndex];
        if (item) handleRename(item.path);
    },
    'explorer:new-file': () => {
        if (!vExplorer) return handleNewFile(State.currentDir);
        const item = vExplorer.flatItems[vExplorer.focusedIndex];
        const dir = (item && item.type === 'DIRECTORY') ? item.path : (item ? FS.getParentDir(item.path) : State.currentDir);
        handleNewFile(dir);
    }
};

export function initExplorer(openCallback, cbObj) {
    openFileCallback = openCallback;
    if (cbObj) {
        if (cbObj.closeFileByPath) closeFileCallback = cbObj.closeFileByPath;
        if (cbObj.closeFilesUnderDir) closeFilesUnderDirCallback = cbObj.closeFilesUnderDir;
    }

    const container = document.getElementById('file-list');
    if (container) {
        // A re-init must first tear down the previous instance: its VirtualScroll
        // keeps listening to the same container's scroll/resize and, if left
        // alive, its render() re-appends a dangling contentHost → duplicated
        // tree rows on scroll.
        if (vExplorer) vExplorer.destroy();
        vExplorer = new VirtualExplorer(container);
    }

    // Register Explorer Shortcuts
    SHORTCUTS.EXPLORER.forEach(s => {
        if (explorerActions[s.cmd]) {
            shortcuts.register({ ...s, action: explorerActions[s.cmd], scope: 'EXPLORER' });
        }
    });

    const searchInput = EL.explorer.querySelector('#explorer-search');
    let timeout;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            State.explorerSearchTerm = e.target.value;
            loadExplorer();
        }, 800);
    });

    // Keydown for search input wrapping?
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            vExplorer.setFocus(0);
            vExplorer.container.focus();
        }
    });

    // (Content search is handled by the workspace Grep — Ctrl+G / "Find in
    // Folder" — so the old "Txt" filter-content checkbox was removed.)

    EL.explorer.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.tree-item')) return;
        e.preventDefault();
        ContextMenu.show(e, [
            { label: 'New File', action: () => handleNewFile(State.currentDir) },
            { label: 'New Folder', action: () => handleNewFolder(State.currentDir) },
            { type: 'separator' },
            { label: 'Reveal in File Manager', action: async () => {
                try {
                    await invoke('reveal_in_file_manager', { path: State.currentDir });
                } catch (err) { console.error('reveal_in_file_manager failed', err); }
            } },
            { type: 'separator' },
            { label: 'Refresh All', action: () => loadExplorer(true) }
        ]);
    });

    // Register Explorer Shortcuts
    registerExplorerShortcuts();
}

function registerExplorerShortcuts() {
    const scope = 'EXPLORER';

    const explorerActions = {
        'explorer:nav': (e) => vExplorer && vExplorer.handleKeyDown(e),
        'explorer:rename': (e) => {
            // Single path into the inline rename (same as the context menu's
            // Rename item), so the behaviour can't drift between entry points.
            if (!vExplorer) return;
            const item = vExplorer.flatItems[vExplorer.focusedIndex];
            if (item) handleRename(item.path);
        },
        'explorer:new-file': (e) => {
            if (!vExplorer) return;
            const item = vExplorer.flatItems[vExplorer.focusedIndex];
            handleNewFile(item && item.type === 'DIRECTORY' ? item.path : (item ? FS.getParentDir(item.path) : State.currentDir));
        }
    };

    SHORTCUTS.EXPLORER.forEach(s => {
        if (explorerActions[s.cmd]) {
            shortcuts.register({ ...s, action: explorerActions[s.cmd], scope });
        }
    });
}

export async function loadExplorer(forceRefresh = false) {
    if (!vExplorer) return;

    if (forceRefresh) vExplorer.dirCache.clear();

    const term = State.explorerSearchTerm ? State.explorerSearchTerm.trim() : '';

    if (term) {
        // Name-only filter (content search moved to workspace Grep).
        await renderFilteredTree(State.currentDir, term, false);
    } else {
        vExplorer.clearMessage();
        lastSearchTerm = '';
        cachedMatches = null;
        await vExplorer.setRoot(State.currentDir);
    }
}

export function focusExplorer() {
    EL.explorerList.focus();
}

// Search Caching
let lastSearchTerm = '';
let lastSearchContentFlag = false;
let cachedMatches = null;

// --- Search Mode (Filtered) ---
async function renderFilteredTree(rootDir, term, searchContent = false) {
    let matches = [];

    // Check Cache
    if (term === lastSearchTerm && searchContent === lastSearchContentFlag && cachedMatches) {
        matches = cachedMatches;
    } else {
        vExplorer.showMessage('Searching...');
        let unlisten = null;
        const currentSearchId = Date.now();
        try {
            unlisten = await FS.onSearchProgress((event) => {
                const { scanned, found, current_path, total, search_id } = event.payload;

                if (search_id && search_id !== currentSearchId) return;

                // Truncate path for display
                let displayPath = current_path || '';
                if (displayPath.length > 30) displayPath = '...' + displayPath.slice(-30);

                let percent = 0;
                if (total > 0) {
                    percent = Math.floor((scanned / total) * 100);
                }

                vExplorer.showProgress(scanned, total, found, displayPath, percent);
            });
            matches = await FS.searchFiles(rootDir, term, searchContent, currentSearchId);

            // Update Cache
            lastSearchTerm = term;
            lastSearchContentFlag = searchContent;
            cachedMatches = matches;
        } catch (e) {
            console.error("Search failed", e);
            vExplorer.showMessage('Search failed: ' + e);
            // Reset Cache on failure
            lastSearchTerm = '';
            cachedMatches = null;
            return;
        } finally {
            if (unlisten) unlisten();
        }
    }

    if (matches.length === 0) {
        vExplorer.setData([]); // <--- Clear the old list!
        vExplorer.focusedIndex = -1; // Reset focus
        vExplorer.showMessage('No matches found');
        return;
    }

    vExplorer.clearMessage();

    // Reconstruct Tree Structure (Case Insensitive)
    const nodeMap = new Map();
    const normalize = (p) => p.replace(/\\/g, '/').toLowerCase();
    const rootKey = normalize(rootDir);

    // Auto-expand directories that contain matches
    // We do this by ensuring every node in the path is expanded if we are building a fresh tree
    // But since `State.expandedFolders` is persistent, we might want to just rely on that OR force expansion for search results?
    // UX: For search results, improved behavior is usually to expand everything to show matches.
    // Let's force expand all parent directories of matches in the transient structure logic below.

    const getNode = (path, type = 'DIRECTORY') => {
        const key = normalize(path);
        if (!nodeMap.has(key)) {
            let name = path.split(/[/\\]/).pop();
            if (key === rootKey) name = '';

            nodeMap.set(key, {
                path,
                name,
                type,
                children: []
            });
        }
        return nodeMap.get(key);
    };

    getNode(rootDir, 'DIRECTORY');

    for (const m of matches) {
        const node = getNode(m.path, m.type);

        let curr = m.path;
        let safeCounter = 0;

        while (normalize(curr) !== rootKey) {
            if (safeCounter++ > 50) break;

            const parentPath = FS.getParentDir(curr);
            const parentKey = normalize(parentPath);

            if (parentKey.length < rootKey.length && !rootKey.startsWith(parentKey)) {
                break;
            }

            const parentNode = getNode(parentPath, 'DIRECTORY');
            const currNode = getNode(curr);

            if (!parentNode.children.includes(currNode)) {
                parentNode.children.push(currNode);
            }

            curr = parentPath;
        }
    }

    const flatItems = [];

    const flatten = (node, level) => {
        node.children.sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'DIRECTORY' ? -1 : 1;
        });

        for (const child of node.children) {
            const isExpanded = State.expandedFolders.has(child.path);

            flatItems.push({
                path: child.path,
                name: child.name,
                type: child.type,
                level: level,
                expanded: isExpanded,
                parent: node.path
            });

            if (child.type === 'DIRECTORY' && isExpanded) {
                flatten(child, level + 1);
            }
        }
    };

    // Pre-pass: If new search, expand all participating directories
    // Auto-expand directories that contain matches if it's a new search
    if (term !== '' && (term !== lastSearchTerm || searchContent !== lastSearchContentFlag)) {
        for (const m of matches) {
            let curr = m.path;
            let safeCounter = 0;
            while (normalize(curr) !== rootKey) {
                if (safeCounter++ > 50) break;
                State.expandedFolders.add(curr);
                curr = FS.getParentDir(curr);
                if (normalize(curr).length < rootKey.length && !rootKey.startsWith(normalize(curr))) break;
            }
        }
    };

    const rootNode = nodeMap.get(rootKey);
    if (rootNode) flatten(rootNode, 0);

    // Capture focus before update
    let focusedPath = null;
    if (vExplorer.focusedIndex >= 0 && vExplorer.flatItems[vExplorer.focusedIndex]) {
        focusedPath = vExplorer.flatItems[vExplorer.focusedIndex].path;
    }

    vExplorer.setData(flatItems);

    // Restore focus if possible
    if (focusedPath) {
        const newIndex = vExplorer.flatItems.findIndex(x => x.path === focusedPath);
        if (newIndex >= 0) {
            vExplorer.setFocus(newIndex);
        }
    }
}


// --- Action Handlers ---

async function handleNewFile(dir) {
    // Phase 3: Explorer Logic
    // "Explorer context -> New File -> Prompt Name -> Create in selected dir -> Update Explorer"

    // User Request 1-2: Use the same Modal as Tab creation
    const res = await showNewFileModal();
    if (!res) return;

    // Fallback to current dir if no dir provided
    const targetDir = dir || State.currentDir;
    const targetPath = FS.joinPath(targetDir, res.filename);

    try {
        if (await FS.exists(targetPath)) {
            await showAlert('File already exists at that location.', { title: 'New File', kind: 'warning' });
            return;
        }

        // Use the specified encoding
        await FS.writeFile(targetPath, '', res.encoding); // Empty file
        await loadExplorer(true); // Force Refresh

        // Optional: Auto-open the newly created file
        if (openFileCallback) openFileCallback(targetPath);

    } catch (err) {
        showAlert('Failed to create file: ' + err, { title: 'New File', kind: 'error' });
    }
}

async function handleNewFolder(dir) {
    const name = await showCustomInput('New Folder', 'Enter folder name:');
    if (!name) return;
    const targetPath = FS.joinPath(dir, name);
    if (await FS.exists(targetPath)) {
        await showAlert('Exists!', { title: 'New Folder', kind: 'warning' });
        return;
    }
    await FS.createDirectory(targetPath);
    await loadExplorer(true); // Force Refresh
}

function handleRename(path) {
    // Inline rename (F2-style): flip the row's label into an edit field
    // instead of popping a modal. Falls back to the modal only if the row
    // can't be found (e.g. called while the tree is mid-search).
    if (!vExplorer) return;
    const index = vExplorer.flatItems.findIndex(x => x.path === path);
    if (index < 0) return;
    const item = vExplorer.flatItems[index];
    // setFocus FIRST: it scrolls the row into view and synchronously re-renders
    // the virtual list (render() wipes contentHost.innerHTML), which DESTROYS
    // any row node queried beforehand. Querying the fresh row afterwards avoids
    // starting the rename on a detached node — the input was appended to a
    // ghost row and never appeared on screen (both F2 and the context-menu
    // Rename went through this broken path).
    vExplorer.setFocus(index);
    const row = EL.explorerList.querySelector(`[data-index="${index}"]`);
    const label = row ? row.querySelector('.tree-label') : null;
    if (row && label) {
        vExplorer.startRenaming(row, item, label);
    }
}

async function handleDelete(pathOrPaths) {
    const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
    const targetName = paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} items`;
    const shouldDelete = await showCustomConfirm('Delete', `Delete ${targetName}?`);
    if (!shouldDelete) return;

    for (const path of paths) {
        if (closeFileCallback) closeFileCallback(path);
        if (closeFilesUnderDirCallback) closeFilesUnderDirCallback(path);
        await FS.removeFile(path);
    }
    await loadExplorer(true); // Force Refresh
}

function handleCopy(paths) { 
    const p = Array.isArray(paths) ? paths : [paths];
    clipboardAction = { type: 'copy', paths: p }; 
}
function handleCut(paths) { 
    const p = Array.isArray(paths) ? paths : [paths];
    clipboardAction = { type: 'cut', paths: p }; 
}

async function handlePaste(targetDir) {
    if (clipboardAction && clipboardAction.paths && clipboardAction.paths.length > 0) {
        try {
            for (const path of clipboardAction.paths) {
                const filename = path.split(/[/\\]/).pop();
                const destPath = FS.joinPath(targetDir, filename);
                if (clipboardAction.type === 'copy') await FS.copyFile(path, destPath);
                else await FS.rename(path, destPath);
            }
            if (clipboardAction.type === 'cut') clipboardAction = null;
            await loadExplorer(true);
        } catch (e) { showAlert(e.message, { title: 'Explorer', kind: 'error' }); }
    } else {
        const files = await FS.pasteFiles();
        if (files && files.length > 0) {
            for (const src of files) {
                const name = src.split(/[/\\]/).pop();
                const dest = FS.joinPath(targetDir, name);
                try { await FS.copyFile(src, dest); } catch (e) { }
            }
            await loadExplorer(true);
        }
    }
}

async function handleDropEvent(e, targetDir) {
    const rawData = e.dataTransfer.getData('text/plain');
    if (!rawData) return;
    const srcPaths = rawData.split('\n').filter(Boolean);
    if (srcPaths.length === 0) return;

    const errors = [];
    for (const srcPath of srcPaths) {
        // Normalize path separators
        const normalizedSrc = srcPath.replace(/\\/g, '/');
        const normalizedTarget = targetDir.replace(/\\/g, '/');

        // Prevent dropping onto self or a child
        if (normalizedSrc === normalizedTarget || normalizedTarget.startsWith(normalizedSrc + '/')) {
            continue;
        }

        const fileName = normalizedSrc.split('/').pop();
        const destPath = FS.joinPath(targetDir, fileName);

        // Skip if source === destination
        if (normalizedSrc === normalizedTarget + '/' + fileName) continue;

        try {
            // Check destination exists
            if (await FS.exists(destPath)) {
                errors.push(`"${fileName}" already exists at destination`);
                continue;
            }
            await FS.rename(srcPath, destPath);
        } catch (err) {
            errors.push(`${fileName}: ${err.message || err}`);
        }
    }

    if (errors.length > 0) {
        showAlert('Move failed:\n' + errors.join('\n'), { title: 'Move', kind: 'error' });
    }

    // Clear cut clipboard if we moved the cut items
    if (clipboardAction && clipboardAction.type === 'cut') {
        const cutMoved = srcPaths.every(src => {
            const normalizedSrc = src.replace(/\\/g, '/');
            return clipboardAction.paths.some(cp => cp.replace(/\\/g, '/') === normalizedSrc);
        });
        if (cutMoved) clipboardAction = null;
    }

    await loadExplorer(true);
}

export function showExplorerStatus(scanned, total, found, path, percent) {
    if (vExplorer) vExplorer.showProgress(scanned, total, found, path, percent);
}

export function clearExplorerStatus() {
    if (vExplorer) vExplorer.clearMessage();
}
