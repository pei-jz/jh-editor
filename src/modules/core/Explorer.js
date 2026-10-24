import { EL } from './Constants.js';
import { t } from '../utils/I18n.js';
import { State } from './Store.js';
import { iconEl, iconForFile } from '../ui/Icons.js';
import * as FS from '../utils/FileSystem.js';
import { VirtualScroll } from '../utils/VirtualScroll.js';
import { explorerOpensOn } from '../utils/ExplorerPrefs.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { GrepModal } from '../ui/GrepModal.js';
import { showCustomInput, showCustomConfirm, showNewFileModal } from '../ui/Modal.js';
import { shortcuts } from './ShortcutManager.js';
import { SHORTCUTS } from './ShortcutDefinitions.js';
import { save } from '@tauri-apps/plugin-dialog';
import { showAlert } from '../ui/Dialog.js';
import { invoke } from '@tauri-apps/api/core';
import { isExternalFileDrag, resolveDroppedPaths } from '../utils/DroppedFiles.js';
import { escapeHtml } from '../utils/SanitizeHtml.js';

let openFileCallback = null;
// { type: 'copy' | 'cut', paths, seq }. `seq` is the OS clipboard's change
// counter right after we put the same files there: if it has moved on by the
// time of a paste, something newer was copied (in Explorer, say) and that wins.
let clipboardAction = null;
// Rows being dragged out of this explorer. dataTransfer cannot be read during
// dragover, and dragover is where a drop onto the dragged folder itself has to
// be refused.
let dragPaths = null;

// Virtual Explorer Instance
let vExplorer = null;

class VirtualExplorer {
    constructor(container) {
        this.container = container;
        this.flatItems = [];
        this.dirCache = new Map(); // path -> entries[]
        this.selectedPaths = new Set();
        // Where a Shift+click / Shift+arrow range starts. A path rather than an
        // index: opening a folder shifts every index below it.
        this.anchorPath = null;
        // Folder a drag is currently over, drawn as the drop target.
        this.dropTargetDir = null;
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

        // A click on the empty space below the rows clears the selection, as
        // in every file manager.
        this.container.addEventListener('click', (e) => {
            if (e.target.closest && e.target.closest('.tree-item')) return;
            if (this.selectedPaths.size === 0) return;
            this.selectedPaths.clear();
            this.redraw();
        });

        // The empty space is the workspace root as a drop target. Rows handle
        // their own drops and stop them, so whatever reaches here missed a row.
        this.container.addEventListener('dragover', (e) => {
            this.autoScrollWhileDragging(e);
            if (e.target.closest && e.target.closest('.tree-item')) return;
            if (!this.rootPath || !acceptsDrop(e, this.rootPath)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = dropEffectFor(e);
            this.setDropTarget(this.rootPath);
        });
        this.container.addEventListener('dragleave', (e) => {
            if (!this.container.contains(e.relatedTarget)) this.setDropTarget(null);
        });
        this.container.addEventListener('drop', (e) => {
            if (e.target.closest && e.target.closest('.tree-item')) return;
            if (!this.rootPath || !acceptsDrop(e, this.rootPath)) return;
            e.preventDefault();
            this.setDropTarget(null);
            handleDropEvent(e, this.rootPath);
        });
    }

    /** Redraw the visible rows (selection, focus, drop target) without re-reading the tree. */
    redraw() {
        this.scroller.onScroll();
    }

    /** The selected paths that are rows right now, top to bottom. */
    selectionInOrder() {
        return this.flatItems.filter(it => this.selectedPaths.has(it.path)).map(it => it.path);
    }

    /**
     * What a command acts on: the whole selection when the cursor is part of
     * it, otherwise the row under the cursor. A path inside another selected
     * folder is dropped — deleting or moving the folder already covers it.
     */
    targetPaths() {
        const item = this.flatItems[this.focusedIndex];
        let paths = (item && !this.selectedPaths.has(item.path))
            ? [item.path]
            : this.selectionInOrder();
        if (!paths.length && item) paths = [item.path];
        return outermostPaths(paths);
    }

    selectOnly(index) {
        const item = this.flatItems[index];
        this.selectedPaths.clear();
        if (item) {
            this.selectedPaths.add(item.path);
            this.anchorPath = item.path;
        }
    }

    /** Select every row between the anchor and `index`; `additive` keeps what was selected. */
    selectRangeTo(index, additive = false) {
        let anchor = this.anchorPath ? this.flatItems.findIndex(x => x.path === this.anchorPath) : -1;
        if (anchor < 0) anchor = this.focusedIndex >= 0 ? this.focusedIndex : index;
        if (!additive) this.selectedPaths.clear();
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
        for (let i = from; i <= to; i++) {
            if (this.flatItems[i]) this.selectedPaths.add(this.flatItems[i].path);
        }
        if (!this.anchorPath && this.flatItems[anchor]) this.anchorPath = this.flatItems[anchor].path;
    }

    /**
     * Move the cursor the way a keyboard does in a file manager: plain moves
     * the selection with it, Shift extends from the anchor, Ctrl moves the
     * cursor alone (Ctrl+Space then picks rows one by one).
     */
    moveCursor(index, e) {
        if (index < 0 || index >= this.flatItems.length) return;
        const ctrl = e.ctrlKey || e.metaKey;
        if (e.shiftKey) this.selectRangeTo(index, ctrl);
        else if (!ctrl) this.selectOnly(index);
        this.setFocus(index);
    }

    setDropTarget(dir) {
        if (this.dropTargetDir === dir) return;
        this.dropTargetDir = dir;
        this.container.classList.toggle('drop-target-root', !!dir && dir === this.rootPath);
        this.redraw();
    }

    /** Scroll when a drag hovers near the top or bottom edge. */
    autoScrollWhileDragging(e) {
        const rect = this.container.getBoundingClientRect();
        const edge = Math.min(32, rect.height / 4);
        if (e.clientY < rect.top + edge) this.container.scrollTop -= this.rowHeight / 2;
        else if (e.clientY > rect.bottom - edge) this.container.scrollTop += this.rowHeight / 2;
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

        const ctrl = e.ctrlKey || e.metaKey;
        const last = this.flatItems.length - 1;
        const page = Math.max(1, Math.floor(this.container.clientHeight / this.rowHeight) - 1);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.moveCursor(this.focusedIndex < 0 ? 0 : Math.min(last, this.focusedIndex + 1), e);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.moveCursor(Math.max(0, this.focusedIndex - 1), e);
        } else if (e.key === 'Home') {
            e.preventDefault();
            this.moveCursor(0, e);
        } else if (e.key === 'End') {
            e.preventDefault();
            this.moveCursor(last, e);
        } else if (e.key === 'PageDown') {
            e.preventDefault();
            this.moveCursor(Math.min(last, Math.max(0, this.focusedIndex) + page), e);
        } else if (e.key === 'PageUp') {
            e.preventDefault();
            this.moveCursor(Math.max(0, this.focusedIndex - page), e);
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
                                this.moveCursor(this.focusedIndex + 1, {});
                            }
                        }
                    }
                } else if (openFileCallback) {
                    // → on a file opens it, like Enter: with a single click
                    // only selecting, the keyboard needs a way in that does
                    // not leave the arrow keys.
                    openFileCallback(item.path);
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
                    if (parentIndex >= 0) this.moveCursor(parentIndex, {});
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
            // The whole selection, not just the row under the cursor — the
            // context menu always did this, the key did not. Shift+Delete
            // skips the Recycle Bin, as it does in Explorer.
            e.preventDefault();
            const paths = this.targetPaths();
            if (paths.length) handleDelete(paths, { permanent: e.shiftKey });
        } else if (e.key === 'Escape') {
            if (this.focusedIndex >= 0 && this.selectedPaths.size > 1) {
                e.preventDefault();
                this.selectOnly(this.focusedIndex);
                this.redraw();
            }
        } else if (ctrl && e.key === ' ') {
            e.preventDefault();
            const item = this.flatItems[this.focusedIndex];
            if (item) {
                if (this.selectedPaths.has(item.path)) this.selectedPaths.delete(item.path);
                else this.selectedPaths.add(item.path);
                this.anchorPath = item.path;
                this.redraw();
            }
        } else if (ctrl && !e.altKey) {
            const item = this.flatItems[this.focusedIndex];
            if (e.key === 'a' || e.key === 'A') {
                e.preventDefault();
                this.flatItems.forEach(it => this.selectedPaths.add(it.path));
                this.redraw();
            } else if (e.key === 'c' || e.key === 'C') {
                const paths = this.targetPaths();
                if (paths.length) handleCopy(paths);
            } else if (e.key === 'x' || e.key === 'X') {
                const paths = this.targetPaths();
                if (paths.length) handleCut(paths);
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

        // Rows deleted, moved or hidden by a collapse are no longer selectable.
        if (this.selectedPaths.size) {
            const present = new Set(this.flatItems.map(x => x.path));
            for (const p of [...this.selectedPaths]) {
                if (!present.has(p)) this.selectedPaths.delete(p);
            }
        }

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
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%; font-weight: 500;">Scanning: ${escapeHtml(currentPath)}</span>
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

        if (clipboardAction && clipboardAction.type === 'cut' && clipboardAction.paths.includes(item.path)) {
            div.classList.add('cut');
        }

        if (this.dropTargetDir && item.path === this.dropTargetDir) {
            div.classList.add('drop-target');
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
            const ctrl = e.ctrlKey || e.metaKey;
            if (e.shiftKey) {
                // Shift: range from the anchor; Ctrl+Shift adds the range.
                this.selectRangeTo(index, ctrl);
                this.setFocus(index);
            } else if (ctrl) {
                if (this.selectedPaths.has(item.path)) {
                    this.selectedPaths.delete(item.path);
                } else {
                    this.selectedPaths.add(item.path);
                }
                this.anchorPath = item.path;
                this.setFocus(index);
            } else {
                this.selectOnly(index);
                // A file opens on a single click. A folder, by default, only
                // gets selected — opening and closing it is a double-click,
                // Enter, ← / → or its chevron (settings: ExplorerPrefs).
                //
                // The second click of a double-click is recognised here rather
                // than with a dblclick listener: refresh() rebuilds every row,
                // so the two clicks land on two different elements and the
                // browser's own dblclick cannot be relied on.
                if (!isDir) {
                    if (openFileCallback) openFileCallback(item.path);
                } else {
                    const now = Date.now();
                    const last = this._lastRowClick;
                    const isDouble = !!last && last.path === item.path && now - last.time < 400;
                    this._lastRowClick = isDouble ? null : { path: item.path, time: now };
                    if (explorerOpensOn() === 'single' || isDouble) this.toggle(item);
                }
                // Re-focus explorer so keyboard shortcuts (Delete, etc.) still work
                this.setFocus(index);
                this.refresh();
            }
            // Ensure explorer retains focus after click so Delete/F2/etc. work.
            // At once as well as later: the re-render above detached the row
            // that was clicked, which drops focus to <body> until then, and a
            // key pressed in that gap went nowhere.
            if (!this._renaming) this.container.focus({ preventScroll: true });
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
                    retargetTabs(item.path, newPath);
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
            // Dragging an unselected row drags that row alone, and selects it,
            // as in Explorer. Dragging a selected one takes the whole selection.
            if (!this.selectedPaths.has(item.path)) {
                this.selectOnly(parseInt(div.dataset.index, 10));
            }
            const paths = this.selectionInOrder();
            dragPaths = outermostPaths(paths.length ? paths : [item.path]);
            e.dataTransfer.setData('text/plain', dragPaths.join('\n'));
            e.dataTransfer.setData('application/x-editor-item', 'true');
            e.dataTransfer.effectAllowed = 'copyMove';
            // No redraw here: replacing the row being dragged would leave the
            // drag without a source element.
            div.classList.add('selected');
        });
        div.addEventListener('dragend', () => {
            dragPaths = null;
            this.setDropTarget(null);
        });

        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const index = parseInt(div.dataset.index, 10);

            // Right-clicking outside the selection selects that row instead;
            // inside it keeps the selection, so the menu acts on all of it.
            if (!this.selectedPaths.has(item.path)) this.selectOnly(index);
            this.setFocus(index); // Focus on right click

            const paths = this.targetPaths();
            const isDir = item.type === 'DIRECTORY';
            const hereDir = isDir ? item.path : FS.getParentDir(item.path);
            const count = paths.length > 1 ? ` (${paths.length})` : '';
            const menuItems = [
                { label: t('Refresh'), action: () => { paths.forEach(p => this.dirCache.delete(p)); this.refresh(); } },
                { type: 'separator' },
                { label: t('New File'), action: () => handleNewFile(hereDir) },
                { label: t('New Folder'), action: () => handleNewFolder(hereDir) },
                { type: 'separator' },
                { label: t('Cut') + count, action: () => handleCut(paths) },
                { label: t('Copy') + count, action: () => handleCopy(paths) },
                { label: t('Paste'), action: () => handlePaste(hereDir) },
                { type: 'separator' },
                { label: t('Copy Path'), action: () => copyPathsAsText(paths, false) },
                { label: t('Copy Relative Path'), action: () => copyPathsAsText(paths, true) },
                { type: 'separator' },
                { label: t('Rename'), action: () => handleRename(item.path) },
                { label: t('Delete') + count, action: () => handleDelete(paths) },
                { type: 'separator' },
                { label: t('Find in Folder'), action: () => {
                    // Grep within this folder (a file → its parent folder).
                    GrepModal.show(hereDir);
                } },
                { type: 'separator' },
                { label: t('Reveal in File Manager'),
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

        // Drop target: a folder takes the drop itself, a file passes it to the
        // folder it sits in — and the folder is what gets highlighted.
        const targetDir = item.type === 'DIRECTORY' ? item.path : FS.getParentDir(item.path);

        div.addEventListener('dragover', (e) => {
            this.autoScrollWhileDragging(e);
            if (!acceptsDrop(e, targetDir)) {
                // Still ours to answer: letting it bubble would make the empty
                // area offer the workspace root instead.
                e.stopPropagation();
                if (dragPaths) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'none';
                }
                this.setDropTarget(null);
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = dropEffectFor(e);
            this.setDropTarget(targetDir);

            // Hovering on a closed folder for a moment opens it, so a drop can
            // go deeper than what is already expanded.
            if (item.type === 'DIRECTORY' && !item.expanded) {
                const now = Date.now();
                if (this._hoverOpen && this._hoverOpen.path === item.path) {
                    if (now - this._hoverOpen.since > 700) {
                        this._hoverOpen = null;
                        this.toggle(item);
                    }
                } else {
                    this._hoverOpen = { path: item.path, since: now };
                }
            } else {
                this._hoverOpen = null;
            }
        });
        div.addEventListener('drop', async (e) => {
            if (!acceptsDrop(e, targetDir)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            this._hoverOpen = null;
            this.setDropTarget(null);
            await handleDropEvent(e, targetDir);
        });
    }
}

/** Normalised for comparison: forward slashes, no trailing slash, case-folded (Windows). */
function normPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** `inner` is `outer` or somewhere beneath it. */
function isSameOrInside(outer, inner) {
    const o = normPath(outer);
    const i = normPath(inner);
    return i === o || i.startsWith(o + '/');
}

/** Drop duplicates and paths that sit inside another path of the list. Order is kept. */
export function outermostPaths(paths) {
    const out = [];
    for (const p of paths) {
        if (out.some(q => normPath(q) === normPath(p))) continue;
        if (paths.some(q => normPath(q) !== normPath(p) && isSameOrInside(q, p))) continue;
        out.push(p);
    }
    return out;
}

/**
 * A name for a copy landing in `dir` that overwrites nothing: `name.txt` if
 * it is free, then `name copy.txt`, `name copy 2.txt`, … Folders are not split
 * at a dot.
 */
export async function freeCopyName(dir, name, isDir, exists = FS.exists) {
    if (!(await exists(FS.joinPath(dir, name)))) return name;
    const dot = isDir ? -1 : name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 1; n < 1000; n++) {
        const candidate = `${stem} copy${n === 1 ? '' : ' ' + n}${ext}`;
        if (!(await exists(FS.joinPath(dir, candidate)))) return candidate;
    }
    throw new Error(`no free name for ${name}`);
}

/** Whether what is being dragged over `targetDir` can be dropped there. */
function acceptsDrop(e, targetDir) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dragPaths) {
        // A folder cannot go into itself or anything beneath it.
        return !dragPaths.some(src => isSameOrInside(src, targetDir));
    }
    const types = Array.from(dt.types || []);
    if (types.includes('application/x-editor-item')) return true;
    return isExternalFileDrag(dt);
}

/** Ctrl copies, plain moves — Explorer's rule. Files from outside the app are copied. */
function dropEffectFor(e) {
    if (!dragPaths) return 'copy';
    return (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
}

// --- Init & Exports ---

let closeFileCallback = null;
let closeFilesUnderDirCallback = null;
let retargetOpenFileCallback = null;

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
        if (cbObj.retargetOpenFile) retargetOpenFileCallback = cbObj.retargetOpenFile;
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
            { label: t('New File'), action: () => handleNewFile(State.currentDir) },
            { label: t('New Folder'), action: () => handleNewFolder(State.currentDir) },
            { type: 'separator' },
            { label: t('Paste'), action: () => handlePaste(State.currentDir) },
            { type: 'separator' },
            { label: t('Reveal in File Manager'), action: async () => {
                try {
                    await invoke('reveal_in_file_manager', { path: State.currentDir });
                } catch (err) { console.error('reveal_in_file_manager failed', err); }
            } },
            { type: 'separator' },
            { label: t('Refresh All'), action: () => loadExplorer(true) }
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

/**
 * Is `path` somewhere the explorer could show?
 *
 * Compared segment by segment, not as a string prefix: "C:/project-backup" and
 * "C:/proj" share their first seven characters and are different folders, and
 * a plain startsWith would send the first one to a tree it is not in.
 */
export function isInsideWorkspace(path) {
    const root = State.currentDir;
    if (!root || !path) return false;
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const r = norm(root);
    const t = norm(path);
    return t === r || t.startsWith(r + '/');
}

/**
 * Open the tree down to `dirPath` and put the cursor on it.
 *
 * Every folder between the workspace root and the target is expanded first —
 * a row that is inside a collapsed parent is not in `flatItems` at all, so
 * there would be nothing to focus. The refresh is awaited for the same reason:
 * the rows do not exist until it has run.
 *
 * Returns false when the path is not under the current workspace, which is the
 * caller's cue to hand it to the OS file manager instead.
 */
export async function revealDirectory(dirPath) {
    if (!isInsideWorkspace(dirPath)) return false;
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const target = String(dirPath).replace(/\\/g, '/').replace(/\/+$/, '');
    const r = norm(State.currentDir);
    const tgt = norm(target);

    // Expand from the target up to (but not including) the root: the root row
    // is the tree itself and has no expander of its own.
    let curr = target;
    for (let guard = 0; guard < 64 && norm(curr) !== r; guard++) {
        State.expandedFolders.add(curr);
        const parent = FS.getParentDir(curr);
        if (!parent || parent === curr) break;
        curr = parent;
    }

    // Already true, and still true with no tree built yet: the answer is about
    // whose path this is, not about whether the panel happens to be up.
    if (!vExplorer) return true;
    await vExplorer.refresh();
    const index = vExplorer.flatItems.findIndex((x) => norm(x.path) === tgt);
    // The root itself has no row; showing the top of the tree is the honest
    // answer to "take me to the workspace root".
    if (index < 0) {
        if (tgt === r) vExplorer.container.scrollTop = 0;
        return true;
    }
    vExplorer.setFocus(index);
    return true;
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

/**
 * Tabs showing `oldPath`, or anything under it when it is a folder, follow the
 * file to `newPath`. Otherwise the next save writes it back where it was.
 */
function retargetTabs(oldPath, newPath) {
    if (!retargetOpenFileCallback) return;
    const o = String(oldPath).replace(/\\/g, '/');
    const n = String(newPath).replace(/\\/g, '/');
    const open = [...(State.openFiles || []), ...(State.rightOpenFiles || [])];
    const seen = new Set();
    for (const f of open) {
        if (!f || !f.path || seen.has(f.path)) continue;
        seen.add(f.path);
        const p = String(f.path).replace(/\\/g, '/');
        if (p === o) retargetOpenFileCallback(f.path, n);
        else if (p.startsWith(o + '/')) retargetOpenFileCallback(f.path, n + p.slice(o.length));
    }
}

/** Put the cursor on `path` once the tree has been rebuilt, if it is a row. */
function focusPath(path) {
    if (!vExplorer || !path) return;
    const index = vExplorer.flatItems.findIndex(x => normPath(x.path) === normPath(path));
    if (index >= 0) {
        vExplorer.selectOnly(index);
        vExplorer.setFocus(index);
    }
}

async function handleDelete(pathOrPaths, { permanent = false } = {}) {
    const paths = outermostPaths(Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths]);
    if (!paths.length) return;
    const what = paths.length === 1 ? FS.getBasename(paths[0]) : t('{n} items', { n: paths.length });
    const message = permanent
        ? t('Permanently delete {name}? This cannot be undone.', { name: what })
        : t('Move {name} to the Recycle Bin?', { name: what });
    const shouldDelete = await showCustomConfirm(t('Delete'), message);
    if (!shouldDelete) return;

    // Where the cursor goes afterwards: the first surviving row below the
    // deleted ones, or the one above — not back to the top of the tree.
    let after = null;
    if (vExplorer) {
        const gone = (p) => paths.some(d => isSameOrInside(d, p));
        const first = vExplorer.flatItems.findIndex(x => gone(x.path));
        if (first >= 0) {
            const next = vExplorer.flatItems.slice(first + 1).find(x => !gone(x.path))
                || vExplorer.flatItems.slice(0, first).reverse().find(x => !gone(x.path));
            after = next ? next.path : null;
        }
    }

    for (const path of paths) {
        if (closeFileCallback) await closeFileCallback(path);
        if (closeFilesUnderDirCallback) await closeFilesUnderDirCallback(path);
    }
    try {
        if (permanent) {
            for (const path of paths) await FS.removeFile(path);
        } else {
            // The Recycle Bin, as in Explorer. This used to delete outright.
            await FS.trashPaths(paths);
        }
    } catch (err) {
        showAlert(t('Delete failed: {error}', { error: (err && err.message) || err }), { title: t('Delete'), kind: 'error' });
    }
    if (clipboardAction) {
        clipboardAction.paths = clipboardAction.paths.filter(p => !paths.some(d => isSameOrInside(d, p)));
        if (!clipboardAction.paths.length) clipboardAction = null;
    }
    await loadExplorer(true); // Force Refresh
    focusPath(after);
}

/**
 * Copy or cut: remembered here for Paste, and put on the OS clipboard as well
 * so the files can be pasted into Explorer too.
 */
async function setClipboard(type, paths) {
    const list = outermostPaths(Array.isArray(paths) ? paths : [paths]);
    const entry = { type, paths: list, seq: null };
    clipboardAction = entry;
    if (vExplorer) vExplorer.redraw(); // dims the cut rows, undims the previous cut
    try {
        entry.seq = await FS.setClipboardFiles(list);
    } catch (e) {
        console.warn('Explorer: could not put the files on the OS clipboard', e);
    }
}

function handleCopy(paths) {
    return setClipboard('copy', paths);
}
function handleCut(paths) {
    return setClipboard('cut', paths);
}

/** Copy Path / Copy Relative Path: one path per line, as text. */
async function copyPathsAsText(paths, relative) {
    const root = State.currentDir ? String(State.currentDir).replace(/\\/g, '/').replace(/\/+$/, '') : '';
    const lines = paths.map((p) => {
        const fwd = String(p).replace(/\\/g, '/');
        if (relative && root && isSameOrInside(root, fwd)) return fwd.slice(root.length + 1) || '.';
        // Absolute paths in the OS's own form, ready for a shell or a dialog.
        return fwd.replace(/\//g, '\\');
    });
    try {
        await navigator.clipboard.writeText(lines.join('\n'));
    } catch (e) {
        console.warn('Explorer: copy path failed', e);
    }
}

/**
 * Paste into `targetDir`.
 *
 * Our own Copy/Cut wins only while it is still the latest thing on the OS
 * clipboard. It used to win for good: once anything had been copied in the
 * tree, files copied in Explorer afterwards could never be pasted here.
 */
async function handlePaste(targetDir) {
    if (!targetDir) return;
    let osSeq = null;
    try { osSeq = await FS.clipboardSequence(); } catch (_) { /* no OS clipboard: ours it is */ }
    const ours = clipboardAction && clipboardAction.paths.length ? clipboardAction : null;
    const oursIsLatest = !!ours && (!osSeq || !ours.seq || osSeq === ours.seq);

    let type = 'copy';
    let sources = [];
    if (oursIsLatest) {
        type = ours.type;
        sources = ours.paths;
    } else {
        try { sources = (await FS.pasteFiles()) || []; } catch (_) { sources = []; }
    }
    if (!sources.length) return;

    const done = await transferInto(targetDir, sources, type === 'cut' ? 'move' : 'copy');
    if (type === 'cut' && clipboardAction === ours) clipboardAction = null;
    await loadExplorer(true);
    if (done.length) focusPath(done[done.length - 1]);
}

/**
 * Copy or move `sources` into `targetDir`. Returns the paths created.
 *
 * A copy never overwrites: a name already taken gets " copy" added, which
 * also makes Ctrl+C, Ctrl+V in the same folder a duplicate. A move onto a
 * taken name is refused and reported — quietly replacing a file is the one
 * thing a move must not do.
 */
async function transferInto(targetDir, sources, mode) {
    const errors = [];
    const created = [];
    for (const src of outermostPaths(sources)) {
        const fwd = String(src).replace(/\\/g, '/');
        const name = FS.getBasename(fwd);
        try {
            if (mode === 'copy') {
                if (isSameOrInside(fwd, targetDir)) {
                    errors.push(t('{name}: cannot copy a folder into itself', { name }));
                    continue;
                }
                let isDir = false;
                try { isDir = await invoke('path_is_dir', { path: fwd }); } catch (_) { /* treat as a file */ }
                const dest = FS.joinPath(targetDir, await freeCopyName(targetDir, name, isDir));
                await FS.copyPath(fwd, dest);
                created.push(dest);
            } else {
                // Already where it is going: nothing to do, nothing to report.
                if (normPath(FS.getParentDir(fwd)) === normPath(targetDir)) continue;
                if (isSameOrInside(fwd, targetDir)) {
                    errors.push(t('{name}: cannot move a folder into itself', { name }));
                    continue;
                }
                const dest = FS.joinPath(targetDir, name);
                if (await FS.exists(dest)) {
                    errors.push(t('{name} already exists in the destination', { name }));
                    continue;
                }
                await FS.movePath(fwd, dest);
                retargetTabs(fwd, dest);
                created.push(dest);
            }
        } catch (err) {
            errors.push(`${name}: ${(err && err.message) || err}`);
        }
    }
    if (errors.length) {
        showAlert(errors.join('\n'), { title: mode === 'copy' ? t('Copy') : t('Move'), kind: 'error' });
    }
    return created;
}

/**
 * A drop onto the tree. Rows dragged within it move (Ctrl: copy); files
 * dragged in from outside the app are copied in.
 */
async function handleDropEvent(e, targetDir) {
    const dt = e.dataTransfer;
    const internal = dragPaths;
    dragPaths = null;
    let sources;
    let mode;
    if (internal) {
        sources = internal;
        mode = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
    } else if (Array.from(dt.types || []).includes('application/x-editor-item')) {
        sources = (dt.getData('text/plain') || '').split('\n').filter(Boolean);
        mode = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
    } else {
        // Read the File objects now: the drop's dataTransfer is emptied once
        // this handler returns, and the paths are only known asynchronously.
        const files = Array.from(dt.files || []);
        sources = await resolveDroppedPaths(files);
        mode = 'copy';
        if (!sources.length && files.length) {
            showAlert(t('Could not open the dropped files.'), { title: t('Copy'), kind: 'error' });
            return;
        }
    }
    if (!sources.length) return;

    const done = await transferInto(targetDir, sources, mode);

    // Cut-then-dragged: the cut is used up.
    if (mode === 'move' && clipboardAction && clipboardAction.type === 'cut') {
        clipboardAction.paths = clipboardAction.paths.filter(p => !sources.some(src => normPath(src) === normPath(p)));
        if (!clipboardAction.paths.length) clipboardAction = null;
    }

    await loadExplorer(true);
    if (done.length) focusPath(done[done.length - 1]);
}

export function showExplorerStatus(scanned, total, found, path, percent) {
    if (vExplorer) vExplorer.showProgress(scanned, total, found, path, percent);
}

export function clearExplorerStatus() {
    if (vExplorer) vExplorer.clearMessage();
}
