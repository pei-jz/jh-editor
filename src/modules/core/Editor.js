import { EL } from './Constants.js';
import { iconEl } from '../ui/Icons.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { State } from './Store.js';
import * as FS from '../utils/FileSystem.js';
import { getOsLineEnding } from '../utils/FileSystem.js';
import { loadExplorer } from './Explorer.js';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { showNewFileModal, showCustomConfirm } from '../ui/Modal.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { lspClient } from '../lsp/LspClient.js';
import { CodeFormatter } from '../utils/CodeFormatter.js';
import { formatAsync } from '../utils/AsyncFormatter.js';
import { TabSearch } from '../ui/TabSearch.js';
import { t } from '../utils/I18n.js';

import { CodeMirrorView } from '../views/CodeMirrorView.js';
import { LargeFileEditView } from '../views/LargeFileEditView.js';
import { MarkdownView } from '../views/MarkdownView.js';
import { StructureView } from '../views/StructureView.js';
import { CsvView } from '../views/CsvView.js';
import { DiffEditor } from '../editors/DiffEditor.js';
import { CompareView } from '../editors/CompareView.js';
import { TaskNotificationPanel } from '../ai/TaskNotificationPanel.js';
import { SearchResultsView } from '../views/SearchResultsView.js';
import { DirDiffView } from '../views/DirDiffView.js';
import { NewFileModal } from '../ui/NewFileModal.js';
import { scheduleSessionSave, flushSession, loadSession, loadDrafts, dropDraft, clearDrafts } from './Session.js';
import { RecentFiles } from '../utils/RecentFiles.js';
import {
    activePane, normalizePane, paneFiles, paneActiveIndex, setPaneActiveIndex,
    findOpenFile, activeFile, activeIndexAfterRemoval, reorderInPlace,
    handleStillInUse, mergeRightIntoLeft,
} from './Panes.js';

export { activePane, normalizePane, paneFiles, paneActiveIndex, findOpenFile };

import { shortcuts } from './ShortcutManager.js';
import { SHORTCUTS } from './ShortcutDefinitions.js';
import { pluginManager } from './PluginManager.js';
import { initDefaultPlugins } from './ViewPlugins.js';
import { showAlert, showConfirm, showDialog } from '../ui/Dialog.js';
import { largeFileThresholdBytes } from '../utils/LargeFileSetting.js';

// Initialize Plugins
initDefaultPlugins();

// Above this size, plain-text files open in the read-only virtualized
// LargeFileView instead of the CM6-based CodeMirrorView. The user can still
// force full editing per-file.
//
// This was a constant at 500 MB. Whether 500 MB is the right line depends on
// the machine and the file — 500 MB of JSON on 8 GB of RAM is nothing like
// 500 MB of log on 64 GB — so it is a setting now, with 500 MB as its default.
// See utils/LargeFileSetting.js.

// Global View References for Split Editor
let leftView = null;
let rightView = null;

/** Release the Rust-side handles owned by a tab, unless a sibling shares them. */
function releaseFileHandles(file) {
    if (!file) return;
    // Call this AFTER the tab has been removed from its pane: the lists are
    // what decides whether anyone still holds the handle.
    if (file.largeId != null && !handleStillInUse('largeId', file.largeId)) {
        invoke('large_file_close', { id: file.largeId }).catch(() => {});
    }
    if (file.editId != null && !handleStillInUse('editId', file.editId)) {
        invoke('editable_close', { id: file.editId }).catch(() => {});
    }
}

/**
 * Keep the other pane's view of the SAME buffer in step.
 *
 * A split shares the buffer object (see splitEditor), so both panes are views
 * of one document and both must show the same text. Without this the idle pane
 * kept the text it was rendered with, and typing in it later wrote that stale
 * document back over the other pane's work — the divergence the shared object
 * was meant to end, just moved one level down.
 *
 * Only a view showing the same buffer OBJECT is mirrored: two tabs on the same
 * path that were opened separately are separate buffers, and always were.
 */
function mirrorToSibling(file, changes, sourceView) {
    if (!State.splitMode) return;
    const sibling = sourceView === leftView ? rightView : leftView;
    if (!sibling || sibling === sourceView) return;
    if (sibling.file !== file) return;
    if (typeof sibling.applyRemoteChanges !== 'function') return;
    sibling.applyRemoteChanges(changes);
}

export function getCurrentView() {
    return activePane() === 'left' ? leftView : rightView;
}

/**
 * The buffer the user is looking at. Everything that acts on "the current file"
 * — save, format, EOL, status bar — must go through this: reading
 * State.openFiles[State.activeTabIndex] directly saves the left pane's file
 * while the right one has focus.
 */
export const getActiveFile = activeFile;

/**
 * Toggle the CR/LF/TAB whitespace markers across open editor panes and persist
 * the choice. Re-renders the syntax layer in place (keeps cursor & scroll).
 */
export function toggleWhitespace() {
    State.showWhitespace = !State.showWhitespace;
    localStorage.setItem('settings_showWhitespace', State.showWhitespace ? 'true' : 'false');
    [leftView, rightView].forEach(v => {
        if (v && typeof v.setWhitespace === 'function') v.setWhitespace();       // CodeMirror view
        else if (v && typeof v._renderHighlights === 'function') v._renderHighlights();
    });
    const indicator = document.getElementById('status-whitespace');
    if (indicator) indicator.classList.toggle('active', State.showWhitespace);
}

export function openDiffEditor(original, modified, filePath, onApply, onChange, onSave, diffOptions) {
    // Normalize: null/undefined content (e.g. created-only files) would crash
    // the DiffEditor (it calls .length on both strings).
    original = original ?? '';
    modified = modified ?? '';
    const fileName = filePath ? String(filePath).split(/[\\/]/).pop() : 'temp';
    const virtualPath = `diff://${filePath || 'temp'}`;
    const opts = diffOptions || {};

    // "Apply & Save" button: apply the result and dismiss the diff tab.
    // The diff lives in `pane` (possibly the right split pane), so the close
    // must target that pane's own tab list — State.activeTabIndex belongs to
    // the OTHER pane when the right pane is active.
    const makeApply = (fileRef) => (finalText) => {
        fileRef.isDirty = false;
        if (onApply) onApply(finalText);
        const idx = openFiles.indexOf(fileRef);
        if (idx >= 0) closeTab(idx, pane);
        else closeTab(State.activeTabIndex, pane);
    };

    // Open in the ACTIVE pane: the diff tab must be visible where the user is
    // looking. `State.openFiles` (left) is the fallback when no split is active.
    const pane = activePane();
    const openFiles = paneFiles(pane);

    // Check if diff tab for this file already exists
    const existingIndex = openFiles.findIndex(f => f.path === virtualPath);
    if (existingIndex >= 0) {
        const ex = openFiles[existingIndex];
        ex.originalContent = original;
        ex.modifiedContent = modified;
        ex.isDirty = true;
        ex.onChange = onChange;
        ex.onSave = onSave;
        ex.onApply = makeApply(ex);
        if (diffOptions) ex.diffOptions = diffOptions;
        setActiveTab(existingIndex, pane);
        return;
    }

    const file = {
        name: `Diff: ${fileName}`,
        path: virtualPath,
        content: '',
        type: 'diff',
        // Mark dirty so the tab shows a "changes to review" indicator until the
        // diff is applied/saved back to the source file.
        isDirty: true,
        viewMode: 'diff',
        originalFilePath: filePath, // Store original path for saving

        // Custom properties for DiffEditor
        originalContent: original,
        modifiedContent: modified,
        onChange: onChange,
        // Ctrl+S: write the merged result back to the source WITHOUT closing the
        // diff tab (closing on save was landing users on the welcome screen).
        onSave: onSave,
        // Extra DiffEditor options (compareMode, leftLabel, rightLabel, onBack, etc.)
        diffOptions: opts,
    };
    file.onApply = makeApply(file);

    // Add to open files and set active
    openFiles.push(file);
    setActiveTab(openFiles.length - 1, pane);
}

// Apply a merged diff result back to the file being edited: update the open
// tab's content (live feedback for accept/reject) and, when saving, write it to
// disk and clear the dirty flag — instead of prompting to save a separate file.
async function applyDiffToSource(sourceFile, text, doSave, hasRejections) {
    if (!sourceFile) return;
    // Resolve the real (non-diff) tab for this file, in case a fresh object was passed.
    const target = State.openFiles.find(f => f === sourceFile)
        || State.openFiles.find(f => f.type !== 'diff' && f.path && sourceFile.path && f.path === sourceFile.path)
        || sourceFile;

    target.content = text;
    // Drop any stale CM6 history snapshot so re-opening shows the new content.
    if (target._cmStateJSON) target._cmStateJSON = null;

    if (doSave && target.path) {
        let toWrite = text;
        if (target.eol && target.eol !== '\n') {
            toWrite = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, target.eol);
        }
        try {
            await FS.writeFile(target.path, toWrite, target.encoding);
            target.isDirty = false;
        } catch (e) {
            console.error('applyDiffToSource: save failed', e);
            if (window.showToast) window.showToast(`Save failed: ${e.message || e}`);
        }
    } else {
        // Only mark dirty when there are rejected hunks — when all hunks are
        // accepted the merged content matches the disk original, so no * marker.
        target.isDirty = !!hasRejections;
    }
    // Also update the diff tab's own dirty flag to match.
    const diffFile = State.openFiles.find(f => f.type === 'diff' && f.originalFilePath === target.path);
    if (diffFile) {
        diffFile.isDirty = !!hasRejections;
    }
    renderTabs();
    // If the source tab happens to be the visible view, refresh it.
    const activeFile = State.openFiles[State.activeTabIndex];
    if (activeFile === target) renderEditor();
}

/**
 * Open an empty side-by-side comparison tab. The user pastes free-form text into
 * the left/right panes and presses 比較 to diff them — unlike openDiffEditor,
 * nothing is tied to a file on disk. Re-uses any existing compare tab.
 */
export function openCompareEditor() {
    const virtualPath = 'compare://scratch';
    const existingIndex = State.openFiles.findIndex(f => f.path === virtualPath);
    if (existingIndex >= 0) {
        setActiveTab(existingIndex);
        return;
    }

    const file = {
        name: 'Compare Text',
        path: virtualPath,
        content: '',
        type: 'compare',
        isDirty: false,
        viewMode: 'compare',
        compareLeft: '',
        compareRight: ''
    };

    State.openFiles.push(file);
    setActiveTab(State.openFiles.length - 1);
}

export function openAgentTasksTab(taskId) {
    const virtualPath = taskId ? `agent://tasks/${taskId}` : `agent://tasks`;
    const existingIndex = State.openFiles.findIndex(f => f.path === virtualPath);
    if (existingIndex >= 0) {
        setActiveTab(existingIndex);
    } else {
        const name = taskId ? `Task #${taskId.substring(0, 8)}` : 'Agent Tasks';
        const file = {
            name: name,
            path: virtualPath,
            content: '',
            type: 'agent',
            isDirty: false,
            viewMode: 'agent'
        };
        State.openFiles.push(file);
        setActiveTab(State.openFiles.length - 1);
    }

    if (taskId) {
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('app:focus-agent-task', { detail: { taskId } }));
        }, 100);
    }
}

// Register Editor Shortcuts
const editorActions = {
    'save': () => {
        saveCurrentFile();
    },
    'compiletotml': () => {
        const file = getActiveFile();
        // if (file && (file.path.endsWith('.xml') || file.path.endsWith('.html'))) {
        //     console.warn('compileToTml is not defined');
        //     // compileToTml(file);
        // }
    },

    'app:tab-search': () => {
        TabSearch.show(State.openFiles, (index) => {
            setActiveTab(index);
        });
    },
    'app:toggle-view-mode': (e) => {
        e.preventDefault();
        const file = getActiveFile();
        if (!file) return;
        const path = file.path ? file.path.toLowerCase() : '';
        const structural = ['.csv', '.xml', '.xsd', '.wsdl', '.html', '.htm', '.jsp', '.json'];
        const isMarkdown = path.endsWith('.md') || path.endsWith('.markdown') || !file.path;

        if (structural.some(ext => path.endsWith(ext)) || isMarkdown) {
            if (file.viewMode === 'text') {
                if (file.content && file.content.length > 5 * 1024 * 1024) {
                    if (window.showToast) window.showToast('This file is too large for the structure view.');
                    return;
                }
                file.viewMode = 'structure';
            } else {
                file.viewMode = 'text';
            }
            renderEditor();
            renderTabs();
        }
    },
    'md-block:nav': (e) => {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        const currentView = getCurrentView();
        if (currentView instanceof MarkdownView) currentView.navigateBlock(dir);
    },
    'md-block:move': (e) => {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        const currentView = getCurrentView();
        if (currentView instanceof MarkdownView) currentView.moveBlock(dir);
    },
    'md-block:edit': (e) => {
        e.preventDefault();
        const file = getActiveFile();
        const path = (file && (file.path || file.name) || '').toLowerCase();
        const isMarkdown = !!(file && (path.endsWith('.md') || path.endsWith('.markdown') || !file.path));
        // Markdown normally opens in the MarkdownView (viewMode 'structure'),
        // but if the user toggled it to plain text, F2 must switch back to the
        // block view first so the .md-block elements exist, then open the block
        // editor — otherwise editSelectedBlock() finds no blocks and silently
        // does nothing.
        if (isMarkdown && file.viewMode !== 'structure') {
            file.viewMode = 'structure';
            renderEditor();
            renderTabs();
        }
        const currentView = getCurrentView();
        if (currentView instanceof MarkdownView) {
            currentView.editSelectedBlock();
            return;
        }
    }
};

export async function closeAllTabs(action = 'prompt') {
    // action can be: 'prompt' (undefined), true (save), false (discard), or 'force' (discard)
    if (action === undefined) action = 'prompt';

    // Both panes: quitting/closing with the right-hand split's work unsaved
    // is just as final. Save and dirty-check must cover both, not just the
    // left one.
    const allFiles = [...State.openFiles, ...State.rightOpenFiles];
    const hasDirty = allFiles.some(f => f.isDirty);
    
    if (action === true || action === 'save') {
        // One buffer open in both panes is now literally one object, so
        // identity dedups it exactly — and there is no longer a second,
        // divergent copy whose edits a path-based dedup could silently drop.
        const seen = new Set();
        for (const file of allFiles) {
            if (!file.isDirty || !file.path) continue;
            if (seen.has(file)) continue;
            seen.add(file);
            if (file.isEditing && file.editId != null) {
                // Rope-backed huge file: write via the backend, not file.content.
                try { await invoke('editable_save', { id: file.editId, path: file.path }); } catch (e) { console.error(e); }
                file.isDirty = false;
            } else if (!file.isLarge) {
                await FS.writeFile(file.path, file.content);
                file.isDirty = false;
            }
        }
    } else if (action === 'prompt' && hasDirty) {
        const proceed = await showConfirm('Some files have unsaved changes. Close all tabs and discard them?', {
            title: 'Unsaved Changes',
            kind: 'warning',
            okLabel: 'Discard & Close',
            cancelLabel: 'Cancel'
        });
        if (!proceed) return false;
    }

    // Free any Rust-side handles tied to the tabs being closed. Everything is
    // going away, so the shared-handle guard is not needed here.
    for (const file of [...State.openFiles, ...State.rightOpenFiles]) {
        if (file.largeId != null) invoke('large_file_close', { id: file.largeId }).catch(() => {});
        if (file.editId != null) invoke('editable_close', { id: file.editId }).catch(() => {});
    }

    State.openFiles = [];
    State.activeTabIndex = -1;
    State.rightOpenFiles = [];
    State.rightActiveTabIndex = -1;
    leftView = null;
    rightView = null;
    // A split with nothing in it is just dead chrome — and leaving splitMode on
    // would keep addressing a pane that has no tabs.
    if (State.splitMode) teardownSplit();
    renderTabs();
    renderEditor();
    updateToolbar();
    setupWatcher(null);
    return true;
}

export function renderEditor(targetPane = null) {
    const panesToRender = targetPane ? [targetPane] : (State.splitMode ? ['left', 'right'] : ['left']);

    panesToRender.forEach(pane => {
        const isLeft = pane === 'left';
        const container = isLeft
            ? EL.editorContent
            : (EL.editorContentRight || (EL.editorContainerRight && EL.editorContainerRight.querySelector('#editor-content-right')));
        if (!container) return;

        let paneView = isLeft ? leftView : rightView;
        if (paneView) {
            if (typeof paneView.destroy === 'function') {
                paneView.destroy();
            }
            if (isLeft) leftView = null;
            else rightView = null;
        }

        container.innerHTML = '';
        // Views style their own container, so the previous view's leftovers have
        // to go — but the pane's own layout must survive. #editor-content gets
        // `flex: 1` from a stylesheet; #editor-content-right only ever had it
        // inline, so blanket-stripping the attribute collapsed it to zero height
        // and the pane rendered blank.
        container.removeAttribute('style');
        container.className = '';
        container.style.flex = '1';
        container.style.minHeight = '0';

        const openFiles = paneFiles(pane);
        const activeIdx = paneActiveIndex(pane);
        const file = openFiles[activeIdx];

        if (!file) {
            container.innerHTML = '<div class="welcome-message">Select a file from the explorer to start editing.</div>';
            return;
        }

        if (activePane() === pane) {
            updateStatusBar(file);
            setupContextMenu(file);
        }

        // Special Case: Diff View
        if (file.type === 'diff' || file.viewMode === 'diff') {
            const extraOpts = file.diffOptions || {};
            const view = new DiffEditor(
                container,
                file.originalContent,
                file.modifiedContent,
                file.originalFilePath,
                file.onApply,
                { onChange: file.onChange, ...extraOpts }
            );
            if (isLeft) leftView = view;
            else rightView = view;
            return;
        }

        // Special Case: Free-form Text Compare View
        if (file.type === 'compare' || file.viewMode === 'compare') {
            const view = new CompareView(container, {});
            view.render(file.content, file);
            if (isLeft) leftView = view;
            else rightView = view;
            return;
        }

        // Special Case: Agent Tasks View
        if (file.type === 'agent' || file.viewMode === 'agent') {
            const panel = new TaskNotificationPanel();
            panel.init(container, file);
            const view = {
                destroy: () => panel.destroy()
            };
            if (isLeft) leftView = view;
            else rightView = view;
            return;
        }

        // Special Case: folder comparison result
        if (file.type === 'dir-diff') {
            const view = new DirDiffView(container, file);
            if (isLeft) leftView = view;
            else rightView = view;
            return;
        }

        // Special Case: Workspace Grep results
        if (file.type === 'search-results') {
            const view = new SearchResultsView(container, file);
            if (isLeft) leftView = view;
            else rightView = view;
            return;
        }

        // Huge file in edit mode (Phase 2): rope-backed sliding-window editor.
        if (file.isEditing && file.editId != null) {
            container.classList.remove('csv-mode', 'markdown-mode');
            container.classList.add('plain-mode');
            file.viewMode = 'text';
            const view = new LargeFileEditView(container, {
                file,
                renderTabs: () => renderTabs(pane),
            });
            view.render(file);
            if (isLeft) leftView = view;
            else rightView = view;
            return;
        }

        // Large-file guard: route oversized files into the read-only virtualized
        // viewer instead of the <textarea>-based editor (a 100MB textarea hangs
        // the browser). Two cases:
        //   - backend (mmap) files: content was never loaded into JS (file.isLarge)
        //   - in-memory huge content (e.g. AI output with no disk path)
        // The escape hatch (forceFullEdit) loads the file fully and falls through.
        if (!file.forceFullEdit
            && (file.isLarge || (file.content && file.content.length > largeFileThresholdBytes()))) {
            container.classList.remove('csv-mode', 'markdown-mode');
            container.classList.add('plain-mode');
            file.viewMode = 'text';
            const view = new LargeFileView(container, {
                renderEditor: () => renderEditor(pane),
            });
            view.render(file.content, file);
            if (isLeft) leftView = view;
            else rightView = view;
            return;
        }

        const path = (file.path || file.name || '').toLowerCase();
        const isMarkdown = path.endsWith('.md') || path.endsWith('.markdown') || (path === '' && !file.path);
        const isCsv = path.endsWith('.csv');
        const isXml = path.endsWith('.xml') || path.endsWith('.xsd') || path.endsWith('.wsdl');
        const isHtml = path.endsWith('.html') || path.endsWith('.htm') || path.endsWith('.jsp');
        const isJson = path.endsWith('.json');

        if (!file.viewMode) {
            // CSV opens straight into the table (grid) view; Markdown opens in
            // the MarkdownView (block) view with its book/scroll mode remembered
            // in State.markdownViewMode. Every other type (html, json, …)
            // defaults to plain text. The choice sticks for that tab and can be
            // flipped with Ctrl+Shift+E.
            file.viewMode = (isCsv || isMarkdown) ? 'structure' : 'text';
        }

        container.classList.remove('plain-mode', 'csv-mode', 'markdown-mode');
        if (file.viewMode === 'text') {
            container.classList.add('plain-mode');
        } else if (file.viewMode === 'structure') {
            if (isMarkdown) {
                container.classList.add('markdown-mode');
            } else if (isCsv || isXml || isJson || isHtml) {
                container.classList.add('csv-mode');
            }
        }

        const plugin = pluginManager.resolve(file, file.viewMode);
        let view;
        if (plugin) {
            const options = {
                updateStatusBar: () => { if (activePane() === pane) updateStatusBar(file); },
                renderEditor: () => renderEditor(pane),
                renderTabs: () => renderTabs(pane),
            };

            view = new plugin.viewClass(container, options);
            if (plugin.getStructureType) {
                const type = plugin.getStructureType(file);
                view.render(file.content, file, type);
            } else {
                view.render(file.content, file);
            }
        } else {
            view = new CodeMirrorView(container, {
                pane,
                updateStatusBar: () => { if (activePane() === pane) updateStatusBar(file); },
                renderTabs: () => renderTabs(pane),
                onDocChanged: mirrorToSibling,
            });
            view.render(file.content, file);
        }

        // Structured views get a small, minimizable usage-hint panel in the
        // bottom-right corner (View モードの使い方 — users forget the keys).
        if (plugin) addViewUsageHint(container, file);
        // Plain-text (CodeMirror) views have no built-in hint panel, but when
        // vi mode is on we still show the vi command palette in the corner.
        // `isTextEditor` has to be told, not guessed from the extension: a .md
        // or .csv file opened in TEXT mode is a CodeMirror editor, and inferring
        // the model from the file name showed it the "Markdown View" / "Table
        // View" block hints while vi was actually running.
        else if (localStorage.getItem('settings_editorVim') === 'true') {
            addViewUsageHint(container, file, { isTextEditor: true });
        }

        if (isLeft) leftView = view;
        else rightView = view;
    });
}

/**
 * Semi-transparent "how to use this view" panel, bottom-right corner, that can
 * be minimized to a tiny tab. Shown only for the structured views (Markdown /
 * CSV / Structure). The collapsed state persists per view type.
 */
export function addViewUsageHint(container, file, options = {}) {
    if (!container || container.querySelector('.view-usage-hint')) return;
    // Anchor the absolute-positioned panel to THIS container (the editor pane).
    container.style.position = 'relative';
    const ext = (file.path || file.name || '').toLowerCase();
    const isMd = ext.endsWith('.md') || ext.endsWith('.markdown') || !file.path;
    const isCsv = ext.endsWith('.csv') || ext.endsWith('.tsv');

    let title, lines;
    // When vi (vim) mode is on, swap the ordinary shortcut hints for a vi
    // command palette so the bottom-right hint stays relevant to the active
    // editing model. `settings_vimMode` = the Markdown block vi navigation
    // (Vim.js); `settings_editorVim` = the full CodeMirror vim keymap that
    // Ctrl+Alt+V / the toolbar badge toggles.
    // `options.isTextEditor` marks the CodeMirror view. Without it the choice
    // was made from the file extension, so vi mode on a .md / .csv file in text
    // mode never got its palette.
    const isTextEditor = options.isTextEditor === true;
    const cmVi = isTextEditor && localStorage.getItem('settings_editorVim') === 'true';
    const mdVi = !isTextEditor && isMd && localStorage.getItem('settings_vimMode') === 'true';
    if (mdVi) {
        title = 'Vim (vi) Mode · Markdown';
        lines = [
            ['j / k', 'move block up / down'],
            ['Enter', 'edit block'],
            ['i', 'insert mode (edit block)'],
            ['o', 'new block (insert)'],
            ['f', 'show link hints'],
            ['Esc', 'back to normal']
        ];
    } else if (cmVi) {
        title = 'Vim (vi) Mode';
        // Grouped roughly as move → select → edit → replace → file. The counted
        // forms (3yy, v3l, 3w) are spelled out rather than left implicit: the
        // "prefix a number" idea is the one thing that is not guessable from a
        // list of single letters.
        lines = [
            ['h / j / k / l', 'move cursor'],
            ['w / b / e', 'word forward / back / end'],
            ['gg / G', 'file start / end'],
            ['0 / $', 'line start / end'],
            ['v / V / Ctrl+V', 'select char / line / block'],
            ['viw', 'select the word'],
            ['v3l / v3w', 'select next 3 chars / words'],
            ['V3j', 'select 3 lines down'],
            ['yy / 3yy', 'copy line / 3 lines'],
            ['dd / 3dd', 'cut line / 3 lines'],
            ['p / P', 'paste after / before'],
            ['i / a / o', 'insert mode'],
            ['r / R', 'replace one char / overwrite'],
            ['ciw / cw', 'change the word'],
            [':s/a/b/g', 'replace in this line'],
            [':%s/a/b/g', 'replace in the file'],
            [':%s/a/b/gc', '…asking each time'],
            ['u / Ctrl+R', 'undo / redo'],
            ['/ / n / N', 'search / next / previous'],
            [':w', 'save'],
            ['Esc', 'back to normal']
        ];
    } else if (isMd) {
        title = 'Markdown View';
        lines = [
            ['↑ / ↓', 'move between blocks'],
            ['Enter / F2', 'edit block (modal)'],
            ['Ctrl+Alt+B', 'book / scroll mode'],
            ['Ctrl+Shift+E', 'switch to text']
        ];
    } else if (isCsv) {
        title = 'Table View';
        lines = [
            ['Arrow keys', 'move cell'],
            ['F2 / Enter', 'edit cell'],
            ['Shift+Space', 'select row'],
            ['Ctrl+Shift+E', 'switch to text']
        ];
    } else {
        title = 'Structure View';
        lines = [
            ['Enter / →', 'expand node'],
            ['←', 'collapse node'],
            ['Ctrl+Shift+E', 'switch to text']
        ];
    }

    const storageKey = (mdVi || cmVi)
        ? 'view-usage-hint-min-vi'
        : `view-usage-hint-min-${isMd ? 'md' : isCsv ? 'csv' : 'struct'}`;
    const wasMin = localStorage.getItem(storageKey) === '1';

    const panel = document.createElement('div');
    panel.className = 'view-usage-hint' + (wasMin ? ' minimized' : '');

    const minBtn = document.createElement('button');
    minBtn.className = 'view-usage-min';
    minBtn.title = wasMin ? 'Show usage hints' : 'Minimize hints';
    minBtn.replaceChildren(iconEl(wasMin ? 'chevron-up' : 'minimize', { size: 12 }));

    // Close, like the shortcut guide's ✕: gone for now, back next time this
    // view is rendered. Deliberately NOT persisted — minimize (—) is the
    // sticky one, so closing can never leave the hints unreachable.
    const closeBtn = document.createElement('button');
    closeBtn.className = 'view-usage-close';
    closeBtn.title = 'Close hints';
    closeBtn.replaceChildren(iconEl('close', { size: 12 }));

    const body = document.createElement('div');
    body.className = 'view-usage-body';
    const head = document.createElement('div');
    head.className = 'view-usage-title';
    head.textContent = title;
    body.appendChild(head);
    lines.forEach(([k, d]) => {
        const row = document.createElement('div');
        row.className = 'view-usage-row';
        const kk = document.createElement('kbd');
        kk.textContent = k;
        const dd = document.createElement('span');
        dd.textContent = d;
        row.append(kk, dd);
        body.appendChild(row);
    });
    panel.append(minBtn, closeBtn, body);

    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.remove();
    });

    minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowMin = !panel.classList.contains('minimized');
        panel.classList.toggle('minimized', nowMin);
        minBtn.title = nowMin ? 'Show usage hints' : 'Minimize hints';
        minBtn.replaceChildren(iconEl(nowMin ? 'chevron-up' : 'minimize', { size: 12 }));
        localStorage.setItem(storageKey, nowMin ? '1' : '0');
    });

    container.appendChild(panel);
}

/**
 * Rebuild the bottom-right hint panel in both panes.
 *
 * vi mode is toggled at RUNTIME (Ctrl+Alt+V, or the toolbar badge) but the
 * panel is built during render — so without this the corner kept showing the
 * hints for the mode you just left, or stayed empty when you turned vi on.
 *
 * Only panes that already show a hint, or that host a CodeMirror editor (the
 * one place vi runs), are touched: everything else must not sprout a panel.
 */
export function refreshViewUsageHints() {
    const panes = [
        [EL.editorContent, State.openFiles[State.activeTabIndex]],
        [EL.editorContentRight, State.rightOpenFiles[State.rightActiveTabIndex]],
    ];
    for (const [container, file] of panes) {
        if (!container || !file) continue;
        const existing = container.querySelector('.view-usage-hint');
        const isTextEditor = !!container.querySelector('.cm-editor-wrapper');
        if (!existing && !isTextEditor) continue;

        if (existing) existing.remove();
        if (isTextEditor) {
            if (localStorage.getItem('settings_editorVim') === 'true') {
                addViewUsageHint(container, file, { isTextEditor: true });
            }
        } else {
            addViewUsageHint(container, file);
        }
    }
}

window.addEventListener('vimModeChanged', refreshViewUsageHints);



SHORTCUTS.GLOBAL.forEach(s => {
    if (editorActions[s.cmd]) {
        shortcuts.register({ ...s, action: editorActions[s.cmd] });
    }
});

SHORTCUTS.MARKDOWN_BLOCK.forEach(s => {
    if (editorActions[s.cmd]) {
        shortcuts.register({ ...s, action: editorActions[s.cmd], scope: 'MARKDOWN_BLOCK' });
    }
});

// Register EDITOR Scope Shortcuts
const extendedEditorActions = {
    ...editorActions,
    'editor:next-tab': () => {
        const pane = activePane();
        const n = paneFiles(pane).length;
        if (!n) return;
        setActiveTab((paneActiveIndex(pane) + 1) % n, pane);
    },
    'editor:prev-tab': () => {
        const pane = activePane();
        const n = paneFiles(pane).length;
        if (!n) return;
        setActiveTab((paneActiveIndex(pane) - 1 + n) % n, pane);
    },
    'editor:go-to-definition': () => {
        const view = getCurrentView();
        if (view && typeof view._triggerDefinition === 'function') {
            const offset = typeof view.getCursorOffset === 'function' ? view.getCursorOffset() : (view.textarea ? view.textarea.selectionStart : 0);
            view._triggerDefinition(offset);
        }
    },
    'editor:find-references': () => {
        const view = getCurrentView();
        if (view && typeof view._triggerReferences === 'function') {
            const offset = typeof view.getCursorOffset === 'function' ? view.getCursorOffset() : (view.textarea ? view.textarea.selectionStart : 0);
            view._triggerReferences(offset);
        }
    },
    'editor:split-right': () => {
        splitEditor({ direction: 'horizontal' });
    },
    'editor:split-down': () => {
        splitEditor({ direction: 'vertical' });
    },
    'editor:close-split': () => {
        closeSplit();
    },
    'editor:focus-other-pane': () => {
        if (!State.splitMode) return;
        const other = activePane() === 'left' ? 'right' : 'left';
        const idx = paneActiveIndex(other);
        setActiveTab(idx >= 0 ? idx : 0, other);
    }
};

SHORTCUTS.EDITOR.forEach(s => {
    if (extendedEditorActions[s.cmd]) {
        shortcuts.register({ ...s, action: extendedEditorActions[s.cmd], scope: 'EDITOR' });
    }
});

// The pane-splitting commands moved from the EDITOR scope to GLOBAL (see
// ShortcutDefinitions) so they also fire from a markdown block, the CSV grid or
// the explorer. Their actions live in extendedEditorActions, which the GLOBAL
// pass above only reads from `editorActions` — register them explicitly.
['editor:split-right', 'editor:split-down', 'editor:close-split', 'editor:focus-other-pane']
    .forEach((cmd) => {
        if (extendedEditorActions[cmd]) {
            shortcuts.register({ cmd, scope: 'GLOBAL', action: extendedEditorActions[cmd] });
        }
    });

// --- File & Tab Management ---

export async function closeFileByPath(path) {
    const idx = State.openFiles.findIndex(f => f.path === path);
    if (idx >= 0) await closeTab(idx);
}

export async function closeFilesUnderDir(dirPath) {
    // Iterate backwards to safely handle removals
    for (let i = State.openFiles.length - 1; i >= 0; i--) {
        if (State.openFiles[i].path && State.openFiles[i].path.startsWith(dirPath)) {
            await closeTab(i);
            // Note: If user cancels, the file remains open.
            // If user confirms, it's removed.
            // Since we iterate backwards, index i-1 is still valid for the next file.
        }
    }
}

const pendingOpens = new Set();

// forcePlainText: open in the plain-text editor regardless of the file type.
// Used when jumping to a specific line (e.g. from grep results) — the
// structure/CSV/book views are not line-addressable, so a line jump there
// would silently land nowhere.
export async function openFile(path, forceEncoding = false, gotoLine = null, forcePlainText = false) {
    let cleanPath = path;
    if (cleanPath.startsWith('\\\\?\\')) {
        cleanPath = cleanPath.substring(4);
    } else if (cleanPath.startsWith('//?/')) {
        cleanPath = cleanPath.substring(4);
    }
    let resolvedPath = cleanPath.replace(/\\/g, '/');
    if (!/^[a-zA-Z]:\//.test(resolvedPath) && !resolvedPath.startsWith('/')) {
        const root = (State.currentDir || '.').replace(/\\/g, '/').replace(/\/$/, '');
        resolvedPath = `${root}/${resolvedPath}`;
    }
    const normalizedPath = resolvedPath;
    
    // A tab may live in either pane — focus it where it actually is rather than
    // assuming the left one.
    const existing = findOpenFile(normalizedPath);
    if (existing && !forceEncoding) {
        // Set before setActiveTab — it re-renders the pane.
        if (forcePlainText) existing.file.viewMode = 'text';
        setActiveTab(existing.index, existing.pane);
        if (gotoLine) scheduleGoToLine(gotoLine);
        return;
    }

    if (pendingOpens.has(resolvedPath)) return;
    pendingOpens.add(resolvedPath);

    // Remember real files for quick re-open (command palette / recent list).
    try { RecentFiles.recordFile(resolvedPath); } catch (_) { /* non-critical */ }

    try {
        const stats = await FS.getFileStats(resolvedPath);

        let fileData = null;

        // Huge files: open via the Rust mmap backend so the content is never
        // pulled into JS. The viewer fetches visible lines on demand.
        if (stats && stats.size > largeFileThresholdBytes() && !forceEncoding) {
            try {
                const meta = await invoke('large_file_open', { path: resolvedPath });
                fileData = {
                    path: resolvedPath,
                    content: '',
                    encoding: meta.encoding || 'UTF-8',
                    eol: getOsLineEnding(),
                    isDirty: false,
                    isLarge: true,
                    largeId: meta.id,
                    lineCount: meta.line_count,
                    stats: stats
                };
            } catch (e) {
                // e.g. binary file or mmap failure — fall back to a normal read.
                console.warn('large_file_open failed, falling back to full read:', e);
            }
        }

        if (!fileData) {
            const { content, encoding, eol } = await FS.readFileAutoDetect(resolvedPath, forceEncoding);
            fileData = {
                path: resolvedPath,
                content: FS.normalizeToLF(content),
                encoding: encoding || 'UTF-8',
                eol: eol || getOsLineEnding(),
                isDirty: false,
                stats: stats || { size: 0, mtime: 0 }
            };
        }

        if (forcePlainText) fileData.viewMode = 'text';

        // Re-check after the await: the tab may have appeared meanwhile.
        const settled = findOpenFile(normalizedPath);
        if (settled && !forceEncoding) {
            if (forcePlainText) settled.file.viewMode = 'text';
            setActiveTab(settled.index, settled.pane);
        } else if (settled && forceEncoding) {
            paneFiles(settled.pane)[settled.index] = fileData;
            setActiveTab(settled.index, settled.pane);
            renderEditor(settled.pane);
        } else {
            // New tabs land in the focused pane. Sending them to the left list
            // while the right pane had focus was what made opening a file after
            // a split look like a freeze: the tab was added, then setActiveTab
            // addressed the *other* pane's list, found no such index, and
            // silently did nothing at all.
            const pane = activePane();
            paneFiles(pane).push(fileData);
            setActiveTab(paneFiles(pane).length - 1, pane);
        }
        renderTabs();
        if (gotoLine) scheduleGoToLine(gotoLine);
    } catch (e) {
        console.warn('Failed to open file (silenced):', resolvedPath);
        // User requested: リンク先がない場合はエラーダイヤログではなく、処理を握りつぶしてください
    } finally {
        pendingOpens.delete(resolvedPath);
    }
}

// Ensure window.app exists for cross-component access
if (typeof window.app === 'undefined') {
    window.app = {};
}

// Create a new file tab (e.g. from AI Panel) that hasn't been saved to disk yet
window.app.createNewTab = function (proposedPath, content) {
    const normalizedPath = proposedPath.replace(/\\/g, '/');
    // If a tab with this path already exists, just focus it and perhaps append/update content
    const existingIndex = State.openFiles.findIndex(f => f.path && f.path.replace(/\\/g, '/') === normalizedPath);
    if (existingIndex >= 0) {
        State.openFiles[existingIndex].content = content;
        State.openFiles[existingIndex].isDirty = true;
        setActiveTab(existingIndex);
        return;
    }

    const fileData = {
        path: proposedPath,
        content: content,
        encoding: 'UTF-8',
        eol: getOsLineEnding(),
        isDirty: true, // Mark as dirty immediately so the user knows to save it
        stats: { size: 0, mtime: 0 }
    };

    State.openFiles.push(fileData);
    setActiveTab(State.openFiles.length - 1);
};

// Jump the active view to a 1-based line, retrying briefly until the view is
// mounted (openFile renders asynchronously). jumpToLine is 0-based.
function scheduleGoToLine(line, tries = 12) {
    const n = parseInt(line, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const v = getCurrentView();
    if (v && typeof v.jumpToLine === 'function') {
        v.jumpToLine(n - 1);
        return;
    }
    if (tries > 0) setTimeout(() => scheduleGoToLine(n, tries - 1), 40);
}
window.app.goToLine = (line) => scheduleGoToLine(line);

// Total line count of the active document (for go-to-line range validation).
window.app.getLineCount = () => {
    const v = getCurrentView();
    if (v && typeof v.getLineCount === 'function') {
        const n = v.getLineCount();
        if (n) return n;
    }
    const f = getActiveFile();
    return f && typeof f.content === 'string' ? f.content.split('\n').length : 0;
};

window.app.openFile = openFile;
window.app.openDiffEditor = openDiffEditor;
window.app.compareTwoFiles = compareTwoFiles;

/** Open a folder-vs-folder comparison in its own tab. */
window.app.compareTwoFolders = function (leftRoot, rightRoot) {
    if (!leftRoot || !rightRoot) return;
    const name = `${String(leftRoot).split(/[\\/]/).pop()} / ${String(rightRoot).split(/[\\/]/).pop()}`;
    State.openFiles.push({
        name,
        // Unique virtual path: tabs are matched by path, so each comparison
        // gets its own tab instead of replacing the previous one.
        path: `dirdiff://${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'dir-diff',
        leftRoot, rightRoot,
        content: '',
        encoding: 'UTF-8',
        eol: getOsLineEnding(),
        isDirty: false,
        stats: { size: 0, mtime: 0 },
    });
    setActiveTab(State.openFiles.length - 1);
};
window.app.openCompareEditor = openCompareEditor;
window.app.openAgentTasksTab = openAgentTasksTab;

// Open an AI result as a (non-dirty) Markdown tab so it renders full-size in the
// editor instead of a cramped popup. Virtual `ai://….md` path → MarkdownView.
window.app.openMarkdownResult = function (title, md) {
    const safeTitle = (title || 'AI Result').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const path = `ai://${safeTitle}-${Date.now()}.md`;
    const file = {
        name: safeTitle,
        path,
        content: md || '',
        encoding: 'UTF-8',
        eol: getOsLineEnding(),
        isDirty: false,
        isAiResult: true,
        stats: { size: 0, mtime: 0 },
    };
    State.openFiles.push(file);
    setActiveTab(State.openFiles.length - 1);
};

// Open (or reuse) a tab showing workspace grep results (streaming when a
// searchId is given — matches arrive live via grep-match/grep-done events).
window.app.openSearchResults = function ({ query, matches, options, searchId, streaming }) {
    const title = String(query || '').slice(0, 30);
    // Every search opens its own tab so earlier results stay available for
    // comparison. Each needs a unique path (tabs are matched by path).
    const file = {
        name: title,
        path: `search://results-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'search-results',
        query: query || '',
        matches: matches || [],
        options: options || {},
        searchId: searchId,
        streaming: !!streaming,
        _done: false,
        _truncated: false,
        _grepUnlisteners: [],
        content: '',
        encoding: 'UTF-8',
        eol: getOsLineEnding(),
        isDirty: false,
        stats: { size: 0, mtime: 0 },
    };

    // Own the streaming listeners at the model level so results keep arriving in
    // file.matches even when this tab isn't the active view; update the live view
    // when it IS active. (The view is destroyed on tab switch — listeners aren't.)
    if (streaming && searchId != null) {
        const liveView = () => {
            const v = getCurrentView();
            return (v && typeof v.appendMatches === 'function' && v.searchId === searchId) ? v : null;
        };
        listen('grep-match', (event) => {
            const p = event.payload;
            if (!p || p.search_id !== searchId) return;
            if (Array.isArray(p.matches) && p.matches.length) {
                for (const m of p.matches) file.matches.push(m);
                const v = liveView();
                if (v) v.appendMatches(p.matches);
            }
        }).then(un => file._grepUnlisteners.push(un)).catch(() => {});
        listen('grep-done', (event) => {
            const p = event.payload;
            if (!p || p.search_id !== searchId) return;
            file._done = true;
            file._truncated = !!p.truncated;
            const v = liveView();
            if (v) v.setDone(!!p.truncated);
            for (const un of file._grepUnlisteners) { try { un(); } catch (_) {} }
            file._grepUnlisteners = [];
        }).then(un => file._grepUnlisteners.push(un)).catch(() => {});
    }

    State.openFiles.push(file);
    setActiveTab(State.openFiles.length - 1);
};
window.app.getCurrentView = getCurrentView;
window.app.getActiveFile = getActiveFile;
window.app.getCurrentDir = () => State.currentDir;
window.app.refreshExplorer = () => loadExplorer(true);
window.app.toggleViewMode = () => {
    editorActions['app:toggle-view-mode']({ preventDefault: () => { } });
};
window.app.getDiagnostics = () => {
    // Placeholder for future linter integration
    // Returns array of objects: { line, message, type }
    const currentView = getCurrentView();
    if (currentView && typeof currentView.getDiagnostics === 'function') {
        return currentView.getDiagnostics();
    }
    return [];
};

window.app.reloadFileSilently = async function(path, newContent) {
    const fileIndex = State.openFiles.findIndex(f => f.path === path);
    if (fileIndex !== -1) {
        const file = State.openFiles[fileIndex];
        file.content = newContent;
        file._skipNextWatcher = true; // Signal the watcher to skip the next event
        
        // Update stats so it doesn't trigger the warning
        const curStats = await FS.getFileStats(path);
        if (curStats) {
            file.stats = curStats;
        }
        
        // If this is the active tab, refresh the view
        if (State.activeTabIndex === fileIndex) {
            renderEditor();
        }
    }
};

export function setActiveTab(index, pane = activePane()) {
    pane = normalizePane(pane);
    const isLeft = pane === 'left';
    const openFiles = paneFiles(pane);    if (index >= 0 && index < openFiles.length) {
        // Clear any active search highlights/state BEFORE switching: the marks
        // and _restoreMap references belong to the outgoing view's DOM. Leaving
        // them live across the switch lets stale element references restore the
        // wrong file's content into the incoming view.
        if (typeof window.cleanupSearch === 'function') {
            try { window.cleanupSearch(); } catch (e) { /* ignore */ }
        }

        setPaneActiveIndex(pane, index);

        State.activePane = pane;

        // Visual indicator for active editor pane
        if (State.splitMode) {
            EL.editorContainer.classList.toggle('active', isLeft);
            if (EL.editorContainerRight) EL.editorContainerRight.classList.toggle('active', !isLeft);
        }

        renderTabs(pane);
        renderEditor(pane);
        updateToolbar();
        setupWatcher(openFiles[index]);

        setTimeout(() => {
            const container = isLeft ? EL.tabsContainer : EL.tabsContainerRight;
            if (container) {
                const tabs = container.querySelectorAll('.tab');
                if (tabs[index]) {
                    scrollTabIntoView(tabs[index], container);
                }
            }
        }, 0);
    }
}

function scrollTabIntoView(tabEl, container = EL.tabsContainer) {
    const rect = tabEl.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    if (rect.left < containerRect.left) {
        container.scrollBy({ left: rect.left - containerRect.left - 20, behavior: 'smooth' });
    } else if (rect.right > containerRect.right) {
        container.scrollBy({ left: rect.right - containerRect.right + 20, behavior: 'smooth' });
    }
}

export async function closeTab(index, pane = activePane()) {
    pane = normalizePane(pane);
    const isLeft = pane === 'left';
    const openFiles = paneFiles(pane);
    const activeIdx = paneActiveIndex(pane);

    if (index < 0 || index >= openFiles.length) return;
    const file = openFiles[index];

    // Virtual tabs (diff/compare/agent) aren't real files — their dirty flag is
    // just a review indicator, so don't nag with a discard prompt on close.
    const isVirtualTab = file.type === 'diff' || file.type === 'compare' || file.type === 'agent';

    if (file.isDirty && !isVirtualTab) {
        const displayName = file.path ? file.path.split(/[\\/]/).pop() : 'Untitled';
        // Three buttons, not two. The obvious answer to "this has unsaved
        // changes" is to save it, and offering only Discard or Cancel made the
        // destructive option the only way forward.
        const choice = await showDialog({
            title: 'Unsaved Changes',
            kind: 'warning',
            message: `${displayName} has unsaved changes.`,
            buttons: [
                { label: 'Cancel', value: 'cancel', cancel: true },
                { label: 'Close without saving', value: 'discard' },
                { label: 'Save and close', value: 'save', primary: true },
            ],
        });
        if (choice === 'cancel' || !choice) return;
        if (choice === 'save') {
            // Bring the tab to the front first: saveCurrentFile works on the
            // ACTIVE file, and closing a background tab must not save the one
            // the user happens to be looking at.
            setPaneActiveIndex(pane, index);
            await saveCurrentFile();
            // Still dirty means the save was cancelled or failed; the user has
            // already been told why, and closing now would lose the work.
            if (file.isDirty) return;
        }
    }

    openFiles.splice(index, 1);

    // Free any Rust-side handles tied to this tab (mmap viewer / rope editor).
    // These are owned by the tab, not the view, so they outlive tab switches —
    // and a split SHARES the buffer, so only release what nobody else holds.
    // The splice above already happened, which is what makes that check valid.
    releaseFileHandles(file);

    const newActiveIdx = activeIndexAfterRemoval(index, activeIdx, openFiles.length);
    setPaneActiveIndex(pane, newActiveIdx);

    // A pane with nothing in it has nothing to show and keeps stealing focus,
    // so fold the split back up. This has to cover the PRIMARY pane too: an
    // empty left pane above a full right one looks like a broken window — a
    // stray welcome message stacked on top of the real editor — and there is no
    // obvious way to get out of it.
    if (openFiles.length === 0 && State.splitMode) {
        closeSplit();
        return;
    }

    renderTabs(pane);
    renderEditor(pane);
    updateToolbar();
    setupWatcher(newActiveIdx >= 0 ? openFiles[newActiveIdx] : null);
}

/**
 * Which icon marks a tab. Regular files get none — the tab strip would be a
 * wall of identical page glyphs, and the extension is already in the name.
 * Only the tabs that are NOT a file on disk are worth marking.
 */
export function tabIconFor(file) {
    if (!file) return null;
    const path = String(file.path || '');
    if (file.type === 'diff' || file.viewMode === 'diff') return 'diff';
    if (file.type === 'compare' || file.viewMode === 'compare') return 'compare';
    if (path.startsWith('agent://')) return 'robot';
    if (path.startsWith('search://')) return 'search';
    if (path.startsWith('ai://')) return 'sparkles';
    return null;
}

export function renderTabs(targetPane = null) {
    // Tabs changed (opened / closed / reordered / dirtied) → persist the session
    // so a crash or restart comes back to the same place. Cheap + debounced
    // internally for the heavy part (draft text).
    try { scheduleSessionSave(); } catch (_) { /* never block rendering */ }

    const panesToRender = targetPane ? [targetPane] : (State.splitMode ? ['left', 'right'] : ['left']);

    panesToRender.forEach(pane => {
        const isLeft = pane === 'left';
        const openFiles = paneFiles(pane);
        const activeIdx = paneActiveIndex(pane);
        const container = isLeft ? EL.tabsContainer : EL.tabsContainerRight;
        if (!container) return;
        installTabDropTarget(container, pane);

        const fragment = document.createDocumentFragment();
        openFiles.forEach((file, index) => {
            const tab = document.createElement('div');
            tab.className = `tab ${index === activeIdx ? 'active' : ''}`;
            tab.draggable = true;
            tab.dataset.tabIndex = String(index);
            tab.dataset.tabPane = pane;
            let fileName = file.name || 'Untitled';
            if (file.path && !file.path.startsWith('agent://') && !file.path.startsWith('diff://')) {
                fileName = file.path.replace(/\\/g, '/').split('/').pop();
            }
            
            // Virtual tabs (diff / compare / agent / search results) used to
            // carry an emoji at the front of file.name. That put a decoration
            // inside a value the rest of the app treats as a name — and it is
            // the tab STRIP that wants an icon, not the name.
            const tabIcon = tabIconFor(file);
            if (tabIcon) {
                const ic = iconEl(tabIcon, { size: 12 });
                ic.classList.add('tab-icon');
                tab.appendChild(ic);
            }
            const titleSpan = document.createElement('span');
            titleSpan.className = 'tab-title';
            titleSpan.textContent = fileName + (file.isDirty ? ' *' : '');
            tab.appendChild(titleSpan);

            tab.onclick = () => setActiveTab(index, pane);
            tab.ondragstart = (e) => {
                dragSource = { pane, index };
                tab.classList.add('tab-dragging');
                // Lets the pane bodies act as drop targets: without it the drag
                // lands inside CodeMirror, which owns its own drop handling.
                document.body.classList.add('tab-drag-active');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    // A drag needs *some* payload to start, but deliberately not
                    // text/plain — CodeMirror would happily insert that path into
                    // the document. The real payload is `dragSource`, since
                    // dataTransfer contents are unreadable during dragover.
                    try { e.dataTransfer.setData(TAB_DRAG_MIME, `${pane}:${index}`); } catch (_) { /* older webview */ }
                }
            };
            tab.ondragend = () => {
                tab.classList.remove('tab-dragging');
                endTabDrag();
            };
            tab.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                ContextMenu.show(e, [
                    { label: 'Copy Path', action: () => { if (file.path) writeText(file.path); } },
                    { label: 'Compare with File...', action: () => compareWithFile(file) },
                    { label: 'Save As...', action: () => saveCurrentFileAs() },
                    { type: 'separator' },
                    { label: 'New Window', action: () => window.app?.openNewWindow?.() },
                    { label: 'Move to Other Pane', action: () => moveTabToOtherPane(index, pane) },
                    { type: 'separator' },
                    { label: 'Close All (Discard)', action: () => closeAllTabs(false) },
                    { label: 'Close All (Save)', action: () => closeAllTabs(true) },
                    { label: 'Close Others', action: () => closeOtherTabs(index, pane) }
                ]);
            };
            const closeBtn = document.createElement('span');
            closeBtn.className = 'tab-close';
            closeBtn.replaceChildren(iconEl('close', { size: 12 }));
            closeBtn.onclick = (e) => { e.stopPropagation(); closeTab(index, pane); };
            tab.appendChild(closeBtn);
            fragment.appendChild(tab);
        });

        container.innerHTML = '';
        container.appendChild(fragment);
    });

    updateTabNavigation();
}

// --- Tab drag & drop ---------------------------------------------------------
// The dragged tab is tracked in a module variable rather than in dataTransfer:
// browsers deliberately hide dataTransfer's contents during `dragover`, and the
// insertion marker has to be positioned on every move.

const TAB_DRAG_MIME = 'application/x-jheditor-tab';

let dragSource = null;

function clearDropMarkers() {
    document.querySelectorAll('.tab-drop-before, .tab-drop-after')
        .forEach(el => el.classList.remove('tab-drop-before', 'tab-drop-after'));
    document.querySelectorAll('.pane-drop-target, .pane-drop-split')
        .forEach(el => el.classList.remove('pane-drop-target', 'pane-drop-split'));
}

/** Clear every trace of an in-flight tab drag (dropped, or cancelled). */
function endTabDrag() {
    dragSource = null;
    document.body.classList.remove('tab-drag-active');
    clearDropMarkers();
}

/** Insertion index for a pointer position inside a tab strip. */
function dropIndexAt(container, clientX) {
    const tabs = [...container.querySelectorAll('.tab')];
    for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect();
        if (clientX < r.left + r.width / 2) return i;
    }
    return tabs.length;
}

function installTabDropTarget(container, pane) {
    if (container._tabDropBound) return;
    container._tabDropBound = true;

    container.addEventListener('dragover', (e) => {
        if (!dragSource) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

        clearDropMarkers();
        const idx = dropIndexAt(container, e.clientX);
        const tabs = [...container.querySelectorAll('.tab')];
        if (tabs.length === 0) {
            container.classList.add('pane-drop-target');
        } else if (idx >= tabs.length) {
            tabs[tabs.length - 1].classList.add('tab-drop-after');
        } else {
            tabs[idx].classList.add('tab-drop-before');
        }
    });

    container.addEventListener('dragleave', (e) => {
        if (e.target === container) clearDropMarkers();
    });

    container.addEventListener('drop', (e) => {
        if (!dragSource) return;
        e.preventDefault();
        e.stopPropagation();
        const target = dropIndexAt(container, e.clientX);
        const src = dragSource;
        endTabDrag();

        if (src.pane === pane) reorderTab(src.index, target, pane);
        else moveTabToOtherPane(src.index, src.pane, target);
    });
}

/**
 * Dropping a tab onto a pane's body moves it there.
 *
 * The left body additionally acts as a "split here" zone: while the editor is
 * unsplit the right pane is display:none and can't receive a drop at all, so
 * dropping on the right quarter of the left body is what creates the split.
 */
export function installPaneDropTargets() {
    const targets = [
        [EL.editorContent, 'left'],
        [EL.editorContentRight, 'right'],
    ];

    // Would this drop land in the right pane? True for the right body always,
    // and for the right edge of the left body while unsplit.
    const wantsRight = (el, pane, clientX) => {
        if (pane === 'right') return true;
        if (State.splitMode) return false;
        const r = el.getBoundingClientRect();
        return clientX > r.right - Math.max(80, r.width * 0.25);
    };

    for (const [el, pane] of targets) {
        if (!el || el._paneDropBound) continue;
        el._paneDropBound = true;

        el.addEventListener('dragover', (e) => {
            if (!dragSource) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            const toRight = wantsRight(el, pane, e.clientX);
            el.classList.toggle('pane-drop-target', !toRight);
            el.classList.toggle('pane-drop-split', toRight && pane === 'left');
        });
        el.addEventListener('dragleave', () => {
            el.classList.remove('pane-drop-target', 'pane-drop-split');
        });
        el.addEventListener('drop', (e) => {
            if (!dragSource) return;
            e.preventDefault();
            const src = dragSource;
            const destPane = wantsRight(el, pane, e.clientX) ? 'right' : 'left';
            endTabDrag();
            if (src.pane === destPane) return; // already there
            moveTabToOtherPane(src.index, src.pane);
        });
    }
}

// --- Tab Navigation Logic ---
let scrollInterval = null;
let navLeftBtn = null;
let navRightBtn = null;

let paneFocusBound = false;

/**
 * Keep State.activePane in sync with which editor pane the user is actually
 * interacting with. setActiveTab() updates it when a tab is switched, but
 * clicking/focusing inside a pane's editor does NOT go through setActiveTab —
 * without this, Ctrl+W (app:close-tab) kept closing the LEFT pane's tab even
 * when the right pane had focus.
 */
function trackPaneFocus() {
    if (paneFocusBound) return;
    paneFocusBound = true;
    const mark = (pane) => () => {
        if (!State.splitMode) return;
        if (State.activePane === pane) return;
        State.activePane = pane;
        // Update the visual active-pane indicator (mirrors setActiveTab).
        if (EL.editorContainer) EL.editorContainer.classList.toggle('active', pane === 'left');
        if (EL.editorContainerRight) EL.editorContainerRight.classList.toggle('active', pane === 'right');
    };
    if (EL.editorContent) {
        EL.editorContent.addEventListener('focusin', mark('left'), true);
        EL.editorContent.addEventListener('mousedown', mark('left'), true);
    }
    if (EL.editorContentRight) {
        EL.editorContentRight.addEventListener('focusin', mark('right'), true);
        EL.editorContentRight.addEventListener('mousedown', mark('right'), true);
    }
}

function updateTabNavigation() {
    if (!navLeftBtn) {
        initTabNavigation();
        installPaneDropTargets();
        trackPaneFocus();
    }

    const container = EL.tabsContainer;
    const hasOverflow = container.scrollWidth > container.clientWidth;

    if (hasOverflow) {
        navLeftBtn.classList.remove('hidden');
        navRightBtn.classList.remove('hidden');
    } else {
        navLeftBtn.classList.add('hidden');
        navRightBtn.classList.add('hidden');
    }
}

function initTabNavigation() {
    const tabBar = document.getElementById('tab-bar');
    if (!tabBar) return;

    navLeftBtn = document.createElement('button');
    navLeftBtn.className = 'tab-nav-btn hidden';
    navLeftBtn.innerHTML = '‹';
    navLeftBtn.title = 'Scroll Left';

    navRightBtn = document.createElement('button');
    navRightBtn.className = 'tab-nav-btn hidden';
    navRightBtn.innerHTML = '›';
    navRightBtn.title = 'Scroll Right';

    // Insert at specific positions
    tabBar.insertBefore(navLeftBtn, EL.tabsContainer);
    tabBar.insertBefore(navRightBtn, EL.newTabBtn);

    const startScroll = (dir) => {
        if (scrollInterval) return;
        EL.tabsContainer.scrollBy({ left: dir * 100, behavior: 'smooth' });
        scrollInterval = setInterval(() => {
            EL.tabsContainer.scrollBy({ left: dir * 50, behavior: 'auto' });
        }, 50);
    };

    const stopScroll = () => {
        if (scrollInterval) {
            clearInterval(scrollInterval);
            scrollInterval = null;
        }
    };

    navLeftBtn.onmousedown = () => startScroll(-1);
    navRightBtn.onmousedown = () => startScroll(1);
    window.addEventListener('mouseup', stopScroll);
    
    // Support touch
    navLeftBtn.ontouchstart = () => startScroll(-1);
    navRightBtn.ontouchstart = () => startScroll(1);
    window.addEventListener('touchend', stopScroll);

    // Initial check
    updateTabNavigation();

    // Resize observer to handle window resizing
    const resizeObserver = new ResizeObserver(() => updateTabNavigation());
    resizeObserver.observe(EL.tabsContainer);
}


function closeOtherTabs(keepIndex, pane = activePane()) {
    pane = normalizePane(pane);
    const isLeft = pane === 'left';
    const openFiles = paneFiles(pane);
    const keepFile = openFiles[keepIndex];
    if (!keepFile) return;
    if (isLeft) {
        State.openFiles = [keepFile];
        State.activeTabIndex = 0;
    } else {
        State.rightOpenFiles = [keepFile];
        State.rightActiveTabIndex = 0;
    }
    renderTabs(pane);
    renderEditor(pane);
    updateToolbar();
    setupWatcher(keepFile);
}

/**
 * Move a tab to the other pane, optionally at a specific position.
 * Splits the editor first if it isn't split yet.
 *
 * `destIndex === null` appends. The source tab always keeps its buffer object,
 * so unsaved edits travel with it.
 */
export function moveTabToOtherPane(index, sourcePane, destIndex = null) {
    sourcePane = normalizePane(sourcePane);
    const sourceFiles = paneFiles(sourcePane);
    if (index < 0 || index >= sourceFiles.length) return;

    const targetPane = sourcePane === 'left' ? 'right' : 'left';

    if (!State.splitMode) {
        // Split without duplicating the active buffer — the tab about to move
        // is what will populate the new pane.
        splitEditor({ seed: false });
    }

    const destFiles = paneFiles(targetPane);
    const file = sourceFiles.splice(index, 1)[0];
    const at = destIndex == null ? destFiles.length : Math.max(0, Math.min(destIndex, destFiles.length));
    destFiles.splice(at, 0, file);

    const newSourceActiveIdx = activeIndexAfterRemoval(
        index, paneActiveIndex(sourcePane), sourceFiles.length
    );
    setPaneActiveIndex(sourcePane, newSourceActiveIdx);
    setPaneActiveIndex(targetPane, at);
    State.activePane = targetPane;

    // Never leave a pane standing empty. A split with nothing on one side is
    // the exact state this whole area was reported for, and it can be reached
    // from either direction by dragging out a pane's last tab.
    if (State.splitMode && sourceFiles.length === 0) {
        closeSplit();
        const landed = State.openFiles.indexOf(file);
        if (landed >= 0) setActiveTab(landed, 'left');
        return;
    }

    renderTabs();
    renderEditor();
    updateToolbar();
    setupWatcher(file);
}

/** Reorder a tab within its own pane (drag & drop). */
export function reorderTab(fromIndex, toIndex, pane) {
    pane = normalizePane(pane);
    const files = paneFiles(pane);
    const focused = files[paneActiveIndex(pane)];

    reorderInPlace(files, fromIndex, toIndex);

    // Follow the buffer, not the slot — the active tab must not change identity
    // just because something ahead of it moved.
    const newActive = files.indexOf(focused);
    setPaneActiveIndex(pane, newActive >= 0 ? newActive : (files.length ? 0 : -1));

    renderTabs(pane);
    updateToolbar();
}

/**
 * Open (or re-orient) the second editor pane.
 *
 * @param {object}  [options]
 * @param {'horizontal'|'vertical'} [options.direction]
 *        'horizontal' = side by side, 'vertical' = stacked. Calling this while
 *        already split in the OTHER direction flips the layout instead of
 *        doing nothing, so Ctrl+\\ / Ctrl+Alt+\\ toggle between the two.
 * @param {boolean} [options.seed]  clone the active tab into the new pane
 */
export function splitEditor(options = {}) {
    const { seed = true, direction = 'horizontal' } = options;
    if (State.splitMode === direction) return;

    const reorienting = !!State.splitMode;
    State.splitMode = direction;
    applySplitOrientation(direction);

    if (EL.editorContainerRight) EL.editorContainerRight.style.display = 'flex';
    if (EL.editorSplitResizer) EL.editorSplitResizer.style.display = 'block';

    if (reorienting) {
        // Panes and tabs stay exactly as they are — only the axis changed.
        renderTabs();
        renderEditor();
        updateToolbar();
        return;
    }

    if (seed && State.rightOpenFiles.length === 0 && State.openFiles.length > 0 && State.activeTabIndex >= 0) {
        // The SAME object, not a copy. Splitting duplicates the current file —
        // the convention VS Code and JetBrains both follow — and it only works
        // if the two panes are two views of ONE document. A `{ ...activeFile }`
        // clone diverged the moment either side was typed into: one path, two
        // texts, `file.content` set by whichever pane wrote last, and a save
        // that picked one of them arbitrarily.
        //
        // Both panes therefore share dirty state, encoding, EOL and any backend
        // handle. What must NOT be shared is per-view state (cursor, scroll,
        // undo history) — that is keyed by pane, see CodeMirrorView.
        State.rightOpenFiles.push(State.openFiles[State.activeTabIndex]);
        State.rightActiveTabIndex = 0;
    }

    State.activePane = 'right';

    trackPaneFocus(); // ensure the right pane's focus/mousedown listeners exist

    renderTabs();
    renderEditor();
    updateToolbar();
    setupSplitResizer();
}

export function closeSplit() {
    if (!State.splitMode) return;
    
    // Carry the right pane's tabs over instead of discarding them.
    mergeRightIntoLeft(State.openFiles, State.rightOpenFiles);

    teardownSplit();

    if (State.activeTabIndex < 0 && State.openFiles.length > 0) State.activeTabIndex = 0;
    if (State.activeTabIndex >= State.openFiles.length) State.activeTabIndex = State.openFiles.length - 1;

    renderTabs('left');
    renderEditor('left');
    updateToolbar();
    // The watcher was following whatever the right pane showed; re-point it at
    // what is actually on screen now.
    setupWatcher(State.openFiles[State.activeTabIndex] || null);
}

/** Reset split state + chrome. Does not touch the tab lists. */
function teardownSplit() {
    State.splitMode = false;
    applySplitOrientation(null);
    State.activePane = 'left';
    State.rightOpenFiles = [];
    State.rightActiveTabIndex = -1;
    if (rightView && typeof rightView.destroy === 'function') {
        try { rightView.destroy(); } catch (_) { /* view already gone */ }
    }
    rightView = null;

    if (EL.editorContainerRight) {
        EL.editorContainerRight.style.display = 'none';
        EL.editorContainerRight.classList.remove('active');
    }
    if (EL.editorSplitResizer) EL.editorSplitResizer.style.display = 'none';
    // Drop any width the resizer applied, so the next split starts even again.
    if (EL.editorContainer) {
        EL.editorContainer.style.flex = '1';
        EL.editorContainer.classList.add('active');
    }
    if (EL.editorContainerRight) EL.editorContainerRight.style.flex = '1';
}

let splitResizerBound = false;

/**
 * Point the wrapper, the divider and the pane borders along the split axis.
 * `null` restores the unsplit (horizontal) defaults.
 */
function applySplitOrientation(direction) {
    const wrapper = document.getElementById('editor-wrapper');
    const vertical = direction === 'vertical';
    if (wrapper) {
        wrapper.style.flexDirection = vertical ? 'column' : 'row';
        wrapper.classList.toggle('split-vertical', vertical);
    }
    const resizer = EL.editorSplitResizer;
    if (resizer) {
        // The divider is a flex item: it must be thin along the split axis and
        // stretch across the other one.
        resizer.style.width = vertical ? '100%' : '4px';
        resizer.style.height = vertical ? '4px' : '';
        resizer.style.cursor = vertical ? 'row-resize' : 'col-resize';
    }
    const right = EL.editorContainerRight;
    if (right) {
        right.style.borderLeft = vertical ? 'none' : '1px solid var(--border-color)';
        right.style.borderTop = vertical ? '1px solid var(--border-color)' : 'none';
    }
    // Both floors, both panes, whichever way they are stacked. A flex item
    // defaults to min-width/min-height:auto, which refuses to shrink below its
    // CONTENT — so a wide line or a book-mode page blew the pane out sideways
    // and pushed the whole window into horizontal overflow. Releasing one floor
    // because the split turned was simply wrong: the cross axis needs it too.
    for (const pane of [EL.editorContainer, right]) {
        if (!pane) continue;
        pane.style.minWidth = '0';
        pane.style.minHeight = '0';
    }
}

function setupSplitResizer() {
    const resizer = EL.editorSplitResizer;
    const leftPane = EL.editorContainer;
    const rightPane = EL.editorContainerRight;
    if (!resizer || !leftPane || !rightPane) return;
    // splitEditor() can run many times per session; binding document-level
    // listeners again each time would leave a growing pile of live handlers.
    if (splitResizerBound) return;
    splitResizerBound = true;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = State.splitMode === 'vertical' ? 'row-resize' : 'col-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const wrapper = document.getElementById('editor-wrapper');
        if (!wrapper) return;
        const wrapperRect = wrapper.getBoundingClientRect();
        // Measure along whichever axis the panes are stacked on.
        const vertical = State.splitMode === 'vertical';
        const pointer = vertical ? e.clientY - wrapperRect.top : e.clientX - wrapperRect.left;
        const total = vertical ? wrapperRect.height : wrapperRect.width;
        if (!total) return;

        const firstPercent = (pointer / total) * 100;
        if (firstPercent > 10 && firstPercent < 90) {
            leftPane.style.flex = `${firstPercent}`;
            rightPane.style.flex = `${100 - firstPercent}`;
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = 'default';
        }
    });
}

/**
 * Ask before a save writes over changes made outside the editor.
 *
 * Returns false only when the user chooses to keep the disk copy. Anything the
 * check itself cannot answer — no stats, an unreadable file, a decoding failure
 * — returns true: a save that refuses to run because a comparison failed is a
 * worse outcome than one that goes ahead.
 */
export async function confirmOverwrite(file) {
    if (!file || !file.path || !file.stats || !file.stats.mtime) return true;
    let curStats = null;
    try { curStats = await FS.getFileStats(file.path); } catch (_) { return true; }
    if (!curStats || !curStats.mtime) return true;

    const seen = new Date(file.stats.mtime).getTime();
    const now = new Date(curStats.mtime).getTime();
    // The same one-second slack the watcher uses: filesystems round mtimes, and
    // our own write updates it moments before this runs on the next save.
    if (!(now > seen + 1000)) return true;

    // A newer timestamp is not a newer FILE. Touching it, or a tool that
    // rewrites identical bytes, must not produce a prompt.
    //
    // Both sides are normalised to LF first: the buffer always holds LF, so
    // comparing it against the raw bytes of a CRLF file would differ on every
    // line and claim every Windows file had been rewritten.
    const disk = await FS.readFileText(file.path);
    if (disk === null) return true;
    if (FS.normalizeToLF(disk) === FS.normalizeToLF(file.content)) {
        file.stats = curStats;
        return true;
    }

    const overwrite = await showConfirm(
        `${file.name || file.path} has changed on disk since you opened it.\n\n`
        + 'Saving now replaces those changes with your version.',
        { title: 'File Changed on Disk', kind: 'warning',
          okLabel: 'Overwrite', cancelLabel: 'Cancel' },
    );
    if (overwrite) file.stats = curStats;
    return overwrite;
}

// Watcher Logic (Native Tauri Events)

/**
 * One watcher per open path.
 *
 * This used to be a single watcher that followed the ACTIVE tab, unwatching
 * whatever it was on before. Everything in the background was therefore
 * invisible: a file changed outside the editor stayed stale in its tab, and
 * saving it wrote the stale text back over the change without a word.
 */
const watchers = new Map();   // path -> unwatch()

/**
 * Bring the set of watchers in line with what is open.
 *
 * Takes no argument: which files are open is not something a caller should have
 * to remember to pass, and passing one file is what caused the bug above.
 */
export async function syncWatchers() {
    const open = [...(State.openFiles || []), ...(State.rightOpenFiles || [])];
    const wanted = new Set();
    for (const f of open) {
        if (!f || !f.path) continue;
        if (f.type && f.type !== 'file') continue;
        const isAbsolute = f.path.match(/^[a-zA-Z]:[\\/]/) || f.path.startsWith('/');
        if (isAbsolute) wanted.add(f.path);
    }

    for (const [path, unwatch] of watchers) {
        if (wanted.has(path)) continue;
        try { unwatch(); } catch (_) { /* already gone */ }
        watchers.delete(path);
    }

    for (const f of open) {
        if (!f || !f.path || !wanted.has(f.path) || watchers.has(f.path)) continue;
        // Reserve the slot before awaiting, or two calls in the same tick both
        // see "not watched" and start a second watcher on the same file.
        watchers.set(f.path, () => {});
        try {
            watchers.set(f.path, await watchFile(f));
        } catch (e) {
            watchers.delete(f.path);
            console.warn('Failed to watch', f.path, e);
        }
    }
}

/** Kept for callers that still pass a file; the set is what matters. */
export async function setupWatcher(_file) {
    return syncWatchers();
}

async function watchFile(file) {
    const isAbsolute = file.path && (file.path.match(/^[a-zA-Z]:[\\/]/) || file.path.startsWith('/'));
    if (!isAbsolute) return () => {};

    const { watch } = await import('@tauri-apps/plugin-fs');
    let isPrompting = false;

    return watch(
        file.path,
        async (event) => {
            if (isPrompting) return;
            if (file._skipNextWatcher) {
                file._skipNextWatcher = false;
                return;
            }

            const curStats = await FS.getFileStats(file.path);
            if (!curStats || !file.stats) return;
            const newTime = new Date(curStats.mtime).getTime();
            const oldTime = new Date(file.stats.mtime).getTime();
            if (!(newTime > oldTime + 1000)) return;

            const diskContent = await FS.readFileText(file.path);
            if (diskContent === null) return;
            // A newer timestamp is not a newer file: only a real difference is
            // worth interrupting anyone over — and the comparison is done in LF
            // on both sides, or every CRLF file would look rewritten.
            if (FS.normalizeToLF(diskContent) === FS.normalizeToLF(file.content)) {
                file.stats = curStats;
                return;
            }

            isPrompting = true;
            file.stats = curStats;
            // Reloading a DIRTY buffer throws away the user's own edits, and
            // the prompt used to say only "Reload?" — the one thing the reader
            // needed to know was the one thing it did not mention.
            const name = file.name || file.path;
            const reload = file.isDirty
                ? await showConfirm(
                    `${name} has changed on disk, and you have unsaved changes here.

`
                    + 'Reloading replaces your edits with the version on disk.',
                    { title: 'File Changed on Disk', kind: 'warning',
                      okLabel: 'Discard my edits and reload', cancelLabel: 'Keep my edits' })
                : await showConfirm(
                    `${name} has changed on disk. Reload it?`,
                    { title: 'File Changed on Disk', kind: 'warning', okLabel: 'Reload' });
            if (reload) openFile(file.path, file.encoding);
            isPrompting = false;
        },
        { delayMs: 500 },
    );
}

export function updateToolbar() {
    const current = getActiveFile();
    if (current) {
        const fullPath = current.path;
        if (!fullPath) {
            if (EL.fileDirectoryLabel) EL.fileDirectoryLabel.textContent = '';
            if (EL.currentFileLabel) EL.currentFileLabel.textContent = current.name || 'Untitled';
            return;
        }
        const match = fullPath.match(/^(.*[\\/])(.+)$/);
        if (match) {
            if (EL.fileDirectoryLabel) EL.fileDirectoryLabel.textContent = match[1];
            if (EL.currentFileLabel) EL.currentFileLabel.textContent = match[2];
        } else {
            if (EL.fileDirectoryLabel) EL.fileDirectoryLabel.textContent = '';
            if (EL.currentFileLabel) EL.currentFileLabel.textContent = fullPath;
        }
    } else {
        if (EL.currentFileLabel) EL.currentFileLabel.textContent = t('No file selected');
        if (EL.fileDirectoryLabel) EL.fileDirectoryLabel.textContent = '';
    }
}


// Editor Orchestrator (Render logic is above)

// View selection logic moved to renderEditor


// View selection logic moved to renderEditor

function setupContextMenu(file) {
    EL.editorContent.oncontextmenu = (e) => {
        if (!file) return;
        const menuItems = [
            { label: 'Copy', action: () => document.execCommand('copy') },
            { label: 'Cut', action: () => document.execCommand('cut') },
            {
                label: 'Paste', action: async () => {
                    try {
                        const text = await readText();
                        if (text) document.execCommand('insertText', false, text);
                    } catch (err) {
                        console.warn('Clipboard paste failed or empty:', err);
                    }
                }
            },
            { type: 'separator' },
            { label: 'Format Document', action: () => formatCurrentFile() }
        ];

        if (file.path) {
            const currentView = getCurrentView();
            if (currentView && typeof currentView._triggerDefinition === 'function') {
                menuItems.push({ type: 'separator' });
                menuItems.push({
                    label: 'Go to Definition (F12)',
                    action: () => {
                        const offset = typeof currentView.getCursorOffset === 'function'
                            ? currentView.getCursorOffset()
                            : (currentView.textarea ? currentView.textarea.selectionStart : 0);
                        currentView._triggerDefinition(offset);
                    }
                });
                menuItems.push({
                    label: 'Find References (Shift+F12)',
                    action: () => {
                        const offset = typeof currentView.getCursorOffset === 'function'
                            ? currentView.getCursorOffset()
                            : (currentView.textarea ? currentView.textarea.selectionStart : 0);
                        currentView._triggerReferences(offset);
                    }
                });
            }

            menuItems.push({ type: 'separator' });
            menuItems.push({
                label: 'Reopen with Encoding',
                submenu: [
                    { label: 'UTF-8', action: () => openFile(file.path, 'utf-8') },
                    { label: 'Shift-JIS', action: () => openFile(file.path, 'shift-jis') },
                    { label: 'EUC-JP', action: () => openFile(file.path, 'euc-jp') }
                ]
            });
        }

        ContextMenu.show(e, menuItems);
    };
}

export async function formatCurrentFile() {
    const file = getActiveFile();
    if (!file) return;
    const pathOrName = file.path || file.name || '';
    const ext = pathOrName.split('.').pop().toLowerCase();
    
    if (['json', 'xml', 'sql', 'html', 'java', 'javascript', 'js', 'ts', 'typescript'].includes(ext)) {
        try {
            const formatted = await formatAsync(file.content, ext);
            
            if (formatted !== file.content) {
                file.content = formatted;
                file.isDirty = true;
                renderEditor();
                renderTabs();
            }
        } catch (err) {
            console.error('Formatting error:', err);
            showAlert('Formatting failed: ' + err.message, { title: 'Format', kind: 'error' });
        }
    } else {
        showAlert('Formatting not supported for this file type.', { title: 'Format', kind: 'info' });
    }
}

export async function createNewFileAction() {
    // Phase 3: Split Logic
    // "Global Ctrl+N / Tab + -> New Tab (Draft) -> Save (Ctrl+S) -> Prompt Path"
    // Ask for the file type first (txt / md); the picker calls back with the ext
    // and, for Markdown, the content of the template chosen in the modal.
    NewFileModal.show((ext, templateContent) => { createNewFileOfType(ext, templateContent); });
}

/**
 * "Save As…" — write the active buffer to a NEW path without touching the
 * original file, exactly like a conventional editor's Save As. The source tab
 * is left open and unmodified; a fresh tab is opened for the new file (or an
 * existing tab for that path is focused).
 *
 * Virtual scratch tabs (diff / compare) and the mmap-backed large-file viewers
 * are deliberately not supported — those buffers have no single in-JS content
 * to copy, and the rope-editor's content lives in Rust.
 */
export async function saveCurrentFileAs() {
    const source = getActiveFile();
    if (!source) return;

    if (source.type === 'diff' || source.type === 'compare'
        || source.viewMode === 'diff' || source.viewMode === 'compare') {
        if (window.showToast) window.showToast('Save As is not available for this view.');
        return;
    }

    let contentToSave;
    if (source.isEditing && source.editId != null) {
        if (window.showToast) window.showToast('Save As is not available for this view.');
        return;
    }
    if (source.isLarge) {
        if (window.showToast) window.showToast('Read-only (large file) — cannot save.');
        return;
    }
    contentToSave = source.content ?? '';

    const defaultName = source.name || (source.path ? FS.getBasename(source.path) : 'Untitled.txt');
    let defaultPath = source.path && (source.path.match(/^[a-zA-Z]:[\\/]/) || source.path.startsWith('/'))
        ? source.path
        : FS.joinPath(State.currentDir || '.', defaultName);
    // For a real file, default to "<name>-copy.ext" in the SAME directory so the
    // save dialog never hints at overwriting the original.
    if (source.path && (source.path.match(/^[a-zA-Z]:[\\/]/) || source.path.startsWith('/'))) {
        const dir = FS.getParentDir(source.path);
        const base = FS.getBasename(source.path);
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : '';
        defaultPath = FS.joinPath(dir, `${stem}-copy${ext}`);
    }

    let selectedPath;
    try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        selectedPath = await save({
            title: 'Save As',
            defaultPath: defaultPath,
            filters: [{
                name: 'All Files',
                extensions: ['*']
            }]
        });
    } catch (e) {
        console.error('Save As dialog failed', e);
        if (window.showToast) window.showToast('Save As failed.');
        return;
    }
    if (!selectedPath) return; // user cancelled

    let toWrite = contentToSave;
    if (source.eol && source.eol !== '\n') {
        toWrite = toWrite.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, source.eol);
    }

    try {
        await FS.writeFile(selectedPath, toWrite, source.encoding);
    } catch (err) {
        console.error('Save As: failed to write file:', err);
        showAlert(`Save failed: ${err.message || err}`, { title: 'Save As', kind: 'error' });
        return;
    }

    // Open the freshly written file in its own tab (reusing an existing tab for
    // that path if one is already open) and refresh the explorer.
    try {
        await openFile(selectedPath);
    } catch (_) { /* tab opening is best-effort; the file is already on disk */ }
    await loadExplorer(true);
    if (window.app.gitPanel) window.app.gitPanel.refresh();
}

/** Create the in-memory draft tab for the chosen extension. */
export async function createNewFileOfType(ext = 'txt', initialContent = '') {
    // Generate a default "Untitled.txt", "Untitled-1.txt", etc.
    let count = 1;
    let filename = `Untitled.${ext}`;
    while (State.openFiles.some(f => f.name === filename)) {
        filename = `Untitled-${count}.${ext}`;
        count++;
    }

    const isMd = ext === 'md' || ext === 'markdown';

    // Create a new "file" object in memory without a path
    const file = {
        name: filename,
        path: null, // Indicates it's a new file not on disk
        content: initialContent || '',
        encoding: 'UTF-8',
        isDirty: true,
        // New Markdown drafts open in the plain text view with markdown syntax
        // highlighting (CodeMirrorView picks the language from file.name even
        // though path is null). Ctrl+Shift+E flips to the Markdown block view.
        ...(isMd ? { viewMode: 'text' } : {}),
        // history: ... initialized by view
    };

    State.openFiles.push(file);
    setActiveTab(State.openFiles.length - 1);
    await renderTabs();
    // View will initialize and render
}

export async function saveCurrentFile() {
    if (State.activeTabIndex >= 0) {
        // Ensure all code blocks are unfolded before saving to prevent data loss
        const currentView = getCurrentView();
        if (currentView && typeof currentView.unfoldAll === 'function') {
            currentView.unfoldAll();
        }

        const file = getActiveFile();

        // Virtual scratch tabs (free-form compare) have no on-disk backing.
        if (file.type === 'compare' || file.viewMode === 'compare') return;

        // Diff tab: Ctrl+S writes the accept/reject result back to the source
        // file and keeps the diff open (instead of prompting for a separate file
        // or closing the tab, which dropped users onto the welcome screen).
        if (file.type === 'diff' || file.viewMode === 'diff') {
            const view = getCurrentView();
            if (typeof file.onSave === 'function' && view && typeof view.getMergedContent === 'function') {
                await file.onSave(view.getMergedContent());
                file.isDirty = false;
                renderTabs();
            }
            // Diffs without a source-save hook (Git view / AI proposals): Ctrl+S
            // is a no-op. NEVER close the tab on save — closing could drop the
            // user onto the welcome screen.
            return;
        }

        // Huge file in rope edit mode: the content lives in Rust, not file.content.
        // Delegate to the edit view, which commits the window and writes the rope.
        if (file.isEditing && file.editId != null) {
            const view = getCurrentView();
            if (view && typeof view.save === 'function') await view.save();
            return;
        }

        // Large files opened read-only via the mmap backend have no content in
        // JS (file.content === ''). Saving would truncate the file — block it.
        if (file.isLarge) {
            if (window.showToast) window.showToast('Read-only (large file) — cannot save.');
            return;
        }

        // Handle Untitled/New Files
        // Handle Untitled/New Files or relative paths that aren't yet anchored to disk
        const isAbsolute = file.path && (file.path.match(/^[a-zA-Z]:[\\/]/) || file.path.startsWith('/'));
        if (!isAbsolute) {
            try {
                const { save } = await import('@tauri-apps/plugin-dialog');
                // Use default name if set, or Untitled
                const defaultName = file.name || 'Untitled.txt';
                const defaultPath = FS.joinPath(State.currentDir, defaultName);

                const selectedPath = await save({
                    defaultPath: defaultPath,
                    filters: [{
                        name: 'All Files',
                        extensions: ['*']
                    }]
                });

                if (!selectedPath) return; // User cancelled

                file.path = selectedPath;
                file.name = FS.getBasename(selectedPath);
                // Continue to save...
            } catch (e) {
                console.error('Save Dialog Failed', e);
                return;
            }
        }

        let contentToSave = file.content;
        if (file.eol && file.eol !== '\n') {
            // Normalize to LF FIRST so any stray CR/CRLF already in the buffer
            // isn't doubled (a plain \n→\r\n on content that already has \r\n
            // produces \r\r\n, which reloads as a blank line between every row).
            contentToSave = contentToSave.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, file.eol);
        }

        // Has the file moved under us since it was read? Without this the save
        // simply overwrote whatever was there — a `git pull`, another editor or
        // a formatter all lose their work silently, and the only warning was a
        // watcher that (see syncWatchers) was not even running on this tab.
        if (!await confirmOverwrite(file)) return;

        try {
            await FS.writeFile(file.path, contentToSave, file.encoding);
            file.isDirty = false;
            // The disk now holds this text — the crash-recovery draft is stale.
            try { dropDraft(file); } catch (_) { /* non-critical */ }
        } catch (err) {
            console.error('Editor: Failed to save file:', err);
            showAlert(`Save failed: ${err.message || err}`, { title: 'Save', kind: 'error' });
            return;
        }

        // Update stats
        const stats = await FS.getFileStats(file.path);
        if (stats) file.stats = stats;

        // If it was a new file, we might need to refresh explorer and update tab title
        await loadExplorer(true);

        // Refresh git status if available
        if (window.app.gitPanel) {
            window.app.gitPanel.refresh();
        }

        renderTabs();
        updateStatusBar();
    }
}

// Markdown-specific block methods (delegated to currentView)
export function focusEditor(options = {}) {
    const currentView = getCurrentView();
    // Any view that knows how to take focus gets it (Ctrl+2). Restricting this
    // to Markdown/CodeMirror left the structured views (JSON/XML tree, …)
    // unreachable from the keyboard.
    if (currentView && typeof currentView.focus === 'function') {
        currentView.focus();
        if (options.toStart) {
            if (currentView.textarea) {
                currentView.textarea.setSelectionRange(0, 0);
                currentView.textarea.scrollTop = 0;
            } else if (typeof currentView.jumpToLine === 'function') {
                currentView.jumpToLine(0);
            }
        }
    }
}
export function selectBlock(index) { const currentView = getCurrentView(); if (currentView instanceof MarkdownView) currentView.selectBlock(index); }
export function activateBlock(index) { const currentView = getCurrentView(); if (currentView instanceof MarkdownView) currentView.activateBlock(index); }
export function saveBlock(index, newText) { const currentView = getCurrentView(); if (currentView instanceof MarkdownView) currentView.saveBlock(index, newText); }

// AI / Selection Methods
export function getSelectedText() {
    const currentView = getCurrentView();
    if (currentView && typeof currentView.getSelectedText === 'function') {
        return currentView.getSelectedText();
    }
    return '';
}

export function replaceSelectedText(text) {
    const currentView = getCurrentView();
    if (currentView && typeof currentView.replaceSelectedText === 'function') {
        currentView.replaceSelectedText(text);
    }
}

export async function triggerCopy() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !active.classList.contains('plain-text-editor')) {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        const text = active.value.substring(start, end);
        if (text) await writeText(text);
        return;
    }

    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && !EL.editorContent.contains(sel.anchorNode)) {
        const text = sel.toString();
        if (text) await writeText(text);
        return;
    }

    const currentView = getCurrentView();
    if (currentView && typeof currentView.copy === 'function') {
        currentView.copy();
    } else {
        const text = sel ? sel.toString() : '';
        if (text) await writeText(text);
    }
}

export async function triggerCut() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !active.classList.contains('plain-text-editor')) {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        const text = active.value.substring(start, end);
        if (text) {
            await writeText(text);
            active.value = active.value.substring(0, start) + active.value.substring(end);
            active.selectionStart = active.selectionEnd = start;
            active.dispatchEvent(new Event('input'));
        }
        return;
    }

    const currentView = getCurrentView();
    if (currentView && typeof currentView.cut === 'function') {
        currentView.cut();
    } else {
        const sel = window.getSelection();
        const text = sel ? sel.toString() : '';
        if (text) {
            await writeText(text);
            document.execCommand('delete'); // fallback for general DOM deletion
        }
    }
}

export async function triggerPaste() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !active.classList.contains('plain-text-editor')) {
        try {
            const text = await readText();
            if (text) {
                // Insert at cursor
                const start = active.selectionStart;
                const end = active.selectionEnd;
                const val = active.value;
                active.value = val.substring(0, start) + text + val.substring(end);
                active.selectionStart = active.selectionEnd = start + text.length;
                active.dispatchEvent(new Event('input'));
            }
        } catch (err) {
            console.warn('triggerPaste (native) failed:', err);
        }
        return;
    }

    const currentView = getCurrentView();
    if (currentView && typeof currentView.paste === 'function') {
        currentView.paste();
    } else {
        try {
            const text = await readText();
            if (text) document.execCommand('insertText', false, text);
        } catch (err) {
            console.warn('triggerPaste (fallback) failed:', err);
        }
    }
}

function eolLabel(eol) {
    if (eol === '\r\n') return 'CRLF';
    if (eol === '\r') return 'CR';
    return 'LF';
}

// Change the active file's line-ending style. This is the ONLY place a file's
// EOL changes after it is loaded — so line endings never change on their own.
// Internally the buffer stays LF; on save the LF is written back as this EOL,
// which is how the original CRLF/LF is preserved.
export function setFileEol(eol) {
    const file = getActiveFile();
    if (!file) return;
    if (file.type === 'diff' || file.type === 'compare' || file.type === 'agent') return;
    if (file.isLarge || file.isEditing) return; // huge-file EOL is handled in Rust
    if (file.eol === eol) return;
    file.eol = eol;
    if (!file.isDirty) { file.isDirty = true; renderTabs(); }
    // Refresh the CM6 EOL whitespace marker (↓/↵/←) if shown.
    const view = getCurrentView();
    if (view && typeof view.setWhitespace === 'function') view.setWhitespace();
    updateStatusBar();
}

// `forFile` comes from renderEditor, which knows exactly which buffer it just
// mounted; without it the status bar described the left pane's file even when
// the right one had focus.
/**
 * How big the buffer in front of you is, in bytes.
 *
 * NOT `stats.size`: that is the size the file was when it was last read from
 * disk, so it sat unchanged while you typed and read `0 B` for anything that
 * had never been saved. The buffer is what the status bar is being asked about.
 *
 * Line endings are counted the way the save path writes them — a CRLF file is
 * one byte per line longer than the LF text held in memory.
 *
 * @returns {number|null} null when the content is not in JS to measure
 *   (a huge file opened through the mmap viewer), where `stats.size` is right.
 */
export function bufferByteSize(file) {
    if (!file) return null;
    if (file.isLarge || typeof file.content !== 'string') {
        return file.stats && file.stats.size ? file.stats.size : null;
    }
    let bytes = new TextEncoder().encode(file.content).length;
    if (file.eol === '\r\n') {
        // Every newline in the buffer is written as two bytes.
        bytes += (file.content.match(/\n/g) || []).length;
    }
    return bytes;
}

/** Bytes as B / KB / MB. */
export function formatByteSize(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

/**
 * Should we go and ask the filesystem when this file was last written?
 *
 * `file.stats` is captured once, when the file is opened. If that `stat` call
 * failed — and it returns null on any error — the buffer kept the placeholder
 * `{ size: 0, mtime: 0 }` for the rest of the session, so the date was simply
 * never shown for that file again. Anything with a real path and no known
 * mtime is worth one more look.
 *
 * Pure, so the rule is testable; the fetching is done by refreshStats().
 */
export function needsStatsRefresh(file) {
    if (!file || !file.path) return false;
    if (file.type && file.type !== 'file') return false;
    // Not yet anchored to disk: an Untitled buffer has nothing to stat.
    const isAbsolute = file.path.match(/^[a-zA-Z]:[\\/]/) || file.path.startsWith('/');
    if (!isAbsolute) return false;
    if (file.stats && file.stats.mtime) return false;      // already known
    if (file._statsPending) return false;                  // one in flight
    // A file that genuinely cannot be stat'ed must not be retried forever —
    // but a Save As gives it a new path, which deserves a fresh attempt.
    return file._statsFailedFor !== file.path;
}

/**
 * Fill in a missing modification time, and repaint if it arrives.
 *
 * Fire-and-forget: the status bar draws immediately with what it has, and
 * updates itself if the answer turns up.
 */
export async function refreshStats(file) {
    if (!needsStatsRefresh(file)) return;
    file._statsPending = true;
    try {
        const stats = await FS.getFileStats(file.path);
        if (stats && stats.mtime) {
            file.stats = stats;
            delete file._statsFailedFor;
            if (getActiveFile() === file) updateStatusBar();
        } else {
            file._statsFailedFor = file.path;
        }
    } catch (_) {
        file._statsFailedFor = file.path;
    } finally {
        file._statsPending = false;
    }
}

/**
 * When the file on disk was last written, or '' when there is no such moment.
 *
 * A never-saved buffer has no modification time. Its placeholder mtime of 0 is
 * a real date — 1 January 1970 — and printing it is worse than printing
 * nothing, because it looks like information.
 */
export function formatModified(file) {
    const mtime = file && file.stats ? file.stats.mtime : null;
    if (!mtime) return '';
    const at = new Date(mtime);
    if (Number.isNaN(at.getTime()) || at.getTime() <= 0) return '';
    return at.toLocaleString();
}

export function updateStatusBar(forFile = null) {
    const file = forFile || getActiveFile();
    if (!file) {
        // Clear the lot. Leaving the last file's size and date on screen with no
        // file open is the same fault as inventing them: numbers that describe
        // nothing that is there.
        for (const id of ['status-selection', 'status-size', 'status-last-modified']) {
            const el = document.getElementById(id);
            if (el) el.textContent = '';
        }
        return;
    }

    const isMd = file.path ? file.path.toLowerCase().endsWith('.md') : true;
    if (document.getElementById('status-file-type')) document.getElementById('status-file-type').textContent = isMd ? 'Markdown' : 'Plain Text';

    // Show the active view mode + the Ctrl+Shift+E hint so users discover the
    // Text ⇄ Structure / Table / Markdown toggle (previously a hidden feature).
    const modeHint = document.getElementById('status-view-mode');
    if (modeHint) {
        const ext = (file.path || file.name || '').toLowerCase();
        const isCsv = ext.endsWith('.csv') || ext.endsWith('.tsv');
        let label = '';
        if (isMd && file.viewMode === 'structure') label = 'Markdown View';
        else if (isCsv && file.viewMode === 'structure') label = 'Table View';
        else if (file.viewMode === 'structure') label = 'Structure View';
        else label = 'Text View';
        modeHint.textContent = `${label} · Ctrl+Shift+E`;
        modeHint.title = 'Switch Text / Structure (Table) view — Ctrl+Shift+E';
        modeHint.style.display = 'inline';
    }

    // A buffer that was never saved carries `stats: { size: 0, mtime: 0 }` as a
    // placeholder, and this printed it: "0 B" beside a file with text in it, and
    // "1970/1/1 9:00:00" — the epoch, presented as a modification date. Neither
    // number was ever real. Nothing is better than something invented.
    if (EL.statusSize) EL.statusSize.textContent = formatByteSize(bufferByteSize(file));
    if (EL.statusLastModified) EL.statusLastModified.textContent = formatModified(file);
    // Draw with what we have, then go and find the date if it is missing.
    refreshStats(file);

    const encEl = document.getElementById('status-encoding');
    if (encEl) encEl.textContent = file.encoding || 'UTF-8';

    const eolEl = document.getElementById('status-eol');
    if (eolEl) eolEl.textContent = eolLabel(file.eol);

    // LSP server status: a clickable warning when the current code file's
    // language server could not start (usually because it isn't installed). We
    // don't auto-install — clicking shows how to get it.
    const lspEl = document.getElementById('status-lsp');
    if (lspEl) {
        const st = (!isMd && file.path) ? lspClient.getServerStatusForFile(file.path) : null;
        if (st && st.status === 'unavailable') {
            lspEl.classList.add('jh-icon-row');
        lspEl.replaceChildren(
            iconEl('warning', { size: 12 }),
            document.createTextNode(`LSP (${st.language}) not running`),
        );
            lspEl.style.color = 'var(--warning-color, #e6a700)';
            lspEl.dataset.lang = st.language;
            lspEl.style.display = 'inline';
        } else {
            lspEl.style.display = 'none';
            lspEl.dataset.lang = '';
        }
        if (!lspEl._bound) {
            lspEl._bound = true;
            lspEl.onclick = async () => {
                const lang = lspEl.dataset.lang;
                if (!lang) return;
                const info = lspClient.getInstallInfo(lang);
                const ok = await showCustomConfirm(
                    'LSP server not found',
                    `${info.name} may not be installed. Example: ${info.command} (details: ${info.url}). Press OK to copy the install command.`
                );
                if (ok && info.command) {
                    try { writeText(info.command); } catch (_) {}
                }
            };
        }
    }

    let selectionValue = 'Ln 1, Col 1';
    const cmView = getCurrentView();
    if (!isMd && cmView && typeof cmView.getStatusInfo === 'function') {
        // CodeMirror view: derive Ln/Col from the editor state (no textarea).
        const info = cmView.getStatusInfo();
        if (info) {
            selectionValue = info.selectionLength > 0
                ? `Selected: ${info.selectionLength}`
                : `Ln ${info.line}, Col ${info.col}`;
        }
    } else if (!isMd) {
        const ta = document.querySelector('.plain-text-editor');
        if (ta) {
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            if (start !== end) selectionValue = `Selected: ${end - start}`;
            else {
                const lines = ta.value.substring(0, start).split('\n');
                selectionValue = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
            }
        }
    } else {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed && EL.editorContent.contains(sel.anchorNode)) {
            selectionValue = `Selected: ${sel.toString().length}`;
        } else {
            selectionValue = `Len: ${file.content.length}`;
        }
    }
    if (document.getElementById('status-selection')) document.getElementById('status-selection').textContent = selectionValue;
}

export async function compareWithDisk(file) {
    if (!file || !file.path) return;
    try {
        // Read the on-disk version with the SAME encoding as the open file, so a
        // Shift_JIS/EUC file isn't garbled by a fixed UTF-8 read. Fall back to
        // auto-detect if the encoding is unknown/unsupported.
        let savedContent;
        try {
            const res = await FS.readFileWithEncoding(file.path, file.encoding || 'UTF-8');
            savedContent = FS.normalizeToLF(res.content);
        } catch (e) {
            const res = await FS.readFileAutoDetect(file.path);
            savedContent = FS.normalizeToLF(res.content);
        }
        // Diff the on-disk version (original) against the in-edit content
        // (modified). Apply/Save writes back to THIS file; accept/reject feeds
        // the merged result back into the editing tab live.
        openDiffEditor(
            savedContent,
            file.content,
            file.path,
            (finalText) => applyDiffToSource(file, finalText, true),                       // Apply & Save button (apply + close)
            (mergedText, hasRejections) => applyDiffToSource(file, mergedText, false, hasRejections), // live feedback on accept/reject
            (mergedText) => applyDiffToSource(file, mergedText, true)                       // Ctrl+S: save to source, keep open
        );
    } catch (err) {
        console.error('Failed to compare with disk version:', err);
    }
}

/**
 * Diff two files picked in the explorer against each other.
 * Read-only comparison: neither file is the "current" editing buffer, so the
 * Accept/Reject/Apply affordances are hidden (compareMode) rather than writing
 * a merge back to a file the user never opened.
 */
/**
 * Reopen the tabs from the previous run of this workspace, and bring back any
 * unsaved edits that were still pending when the app went away.
 *
 * Files that no longer exist are skipped silently (deleted/moved since). A
 * recovered draft re-marks its tab dirty so the user is nudged to save — we
 * never write to disk on their behalf here.
 *
 * @returns {Promise<number>} how many tabs were restored
 */
export async function restoreSession() {
    const session = loadSession();
    if (!session || !Array.isArray(session.left) || session.left.length === 0) return 0;

    const drafts = loadDrafts();
    let restored = 0;

    for (const entry of session.left) {
        if (!entry || !entry.path) continue;
        // Skip anything already open (e.g. a file passed on the command line).
        if (State.openFiles.some(f => f.path === entry.path)) continue;
        try {
            const stats = await FS.getFileStats(entry.path);
            if (!stats) continue; // gone since last run
            const { content, encoding, eol } = await FS.readFileAutoDetect(entry.path);
            const file = {
                path: entry.path,
                content: FS.normalizeToLF(content),
                encoding: encoding || entry.encoding || 'UTF-8',
                eol: eol || getOsLineEnding(),
                isDirty: false,
                stats,
            };
            if (entry.viewMode) file.viewMode = entry.viewMode;

            // Unsaved edits win over the on-disk text.
            const draft = drafts[entry.path];
            if (draft && typeof draft.content === 'string' && draft.content !== file.content) {
                file.content = draft.content;
                file.isDirty = true;
                file._recoveredDraft = true;
            }
            State.openFiles.push(file);
            restored++;
        } catch (e) {
            console.warn('[Session] could not restore', entry.path, e);
        }
    }

    // The secondary pane, when the last session had one. Restored before the
    // untitled buffers so those always land in the primary pane.
    if (session.splitMode && Array.isArray(session.right) && session.right.length > 0) {
        for (const entry of session.right) {
            if (!entry || !entry.path) continue;
            if (State.rightOpenFiles.some(f => f.path === entry.path)) continue;
            try {
                const stats = await FS.getFileStats(entry.path);
                if (!stats) continue;
                const { content, encoding, eol } = await FS.readFileAutoDetect(entry.path);
                const file = {
                    path: entry.path,
                    content: FS.normalizeToLF(content),
                    encoding: encoding || entry.encoding || 'UTF-8',
                    eol: eol || getOsLineEnding(),
                    isDirty: false,
                    stats,
                };
                if (entry.viewMode) file.viewMode = entry.viewMode;
                State.rightOpenFiles.push(file);
                restored++;
            } catch (e) {
                console.warn('[Session] could not restore', entry.path, e);
            }
        }
        if (State.rightOpenFiles.length > 0) {
            // seed:false — the pane already has its own tabs. The saved value
            // is the DIRECTION, not a boolean: reopening a vertical split as a
            // horizontal one was a silent downgrade.
            splitEditor({
                seed: false,
                direction: session.splitMode === 'vertical' ? 'vertical' : 'horizontal',
            });
            const rIdx = Number.isInteger(session.rightActiveIndex)
                ? Math.min(Math.max(session.rightActiveIndex, 0), State.rightOpenFiles.length - 1)
                : 0;
            State.rightActiveTabIndex = rIdx;
        }
    }

    // Untitled buffers that only ever existed in memory.
    for (const id of Object.keys(drafts)) {
        const d = drafts[id];
        if (!d || d.path) continue;              // path-backed ones handled above
        if (d.workspace && d.workspace !== String(State.currentDir || '(none)')) continue;
        if (typeof d.content !== 'string' || !d.content) continue;
        State.openFiles.push({
            name: d.name || 'Untitled.txt',
            path: null,
            content: d.content,
            encoding: d.encoding || 'UTF-8',
            eol: d.eol || getOsLineEnding(),
            isDirty: true,
            _draftId: id,
            _recoveredDraft: true,
        });
        restored++;
    }

    if (restored > 0) {
        const idx = Number.isInteger(session.activeIndex)
            ? Math.min(Math.max(session.activeIndex, 0), State.openFiles.length - 1)
            : 0;
        // Focus the primary pane last: splitEditor() above leaves focus on the
        // right, and a restored session should open where the user reads first.
        setActiveTab(idx, 'left');
        await renderTabs();
        const recovered = State.openFiles.filter(f => f._recoveredDraft).length;
        if (recovered > 0 && window.showToast) {
            window.showToast(`Recovered ${recovered} unsaved change(s)`);
        }
    }
    return restored;
}

export async function compareTwoFiles(leftPath, rightPath) {
    if (!leftPath || !rightPath) return;
    try {
        const [leftRes, rightRes] = await Promise.all([
            FS.readFileAutoDetect(leftPath),
            FS.readFileAutoDetect(rightPath),
        ]);
        const leftName = FS.getBasename(leftPath);
        const rightName = FS.getBasename(rightPath);
        openDiffEditor(
            FS.normalizeToLF(leftRes.content),
            FS.normalizeToLF(rightRes.content),
            rightPath,           // drives syntax highlighting
            null, null, null,
            {
                compareMode: true,
                leftLabel: leftName,
                rightLabel: rightName,
            }
        );
    } catch (err) {
        console.error('Failed to compare the two selected files:', err);
        if (window.showToast) window.showToast('Failed to compare the files');
    }
}

export async function compareWithFile(file) {
    if (!file) return;
    try {
        const dialog = await import('@tauri-apps/plugin-dialog');
        const selectedPath = await dialog.open({
            directory: false,
            multiple: false,
            title: 'Compare with File'
        });
        if (selectedPath) {
            // Auto-detect the compared file's own encoding (it may differ from
            // the current file) instead of assuming UTF-8.
            const otherRes = await FS.readFileAutoDetect(selectedPath);
            const otherContent = FS.normalizeToLF(otherRes.content);
            openDiffEditor(
                otherContent,
                file.content,
                file.path,
                (finalText) => applyDiffToSource(file, finalText, true),
                (mergedText, hasRejections) => applyDiffToSource(file, mergedText, false, hasRejections),
                (mergedText) => applyDiffToSource(file, mergedText, true)
            );
        }
    } catch (err) {
        console.error('Failed to compare file:', err);
    }
}

// Expose to window for access from Views (e.g. ContextMenu actions)
window.Editor = {
    formatCurrentFile,
    renderEditor,
    renderTabs,
    openFile,
    saveCurrentFile,
    saveCurrentFileAs,
    compareWithFile,
    compareWithDisk
};
