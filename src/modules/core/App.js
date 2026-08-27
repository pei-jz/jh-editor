import { State } from './Store.js';
import { EL } from './Constants.js';
import { configureMarkdown, initMermaid } from '../utils/Markdown.js';
import { initLayout } from './Layout.js';
import { initExplorer, loadExplorer } from './Explorer.js';
import { openFile, createNewFileAction, saveCurrentFile, saveCurrentFileAs, updateStatusBar, closeFileByPath, closeFilesUnderDir, closeAllTabs, renderEditor, renderTabs, setActiveTab, formatCurrentFile, closeTab, focusEditor, triggerCopy, triggerCut, triggerPaste, getCurrentView, compareWithDisk, openCompareEditor, toggleWhitespace, setFileEol, restoreSession } from './Editor.js';
import { activePane, paneActiveIndex } from './Panes.js';
import { flushSession, suspend as sessionSuspend, resume as sessionResume } from './Session.js';
import { ContextMenu } from '../ui/ContextMenu.js';

// ...


import { shortcuts } from './ShortcutManager.js';
import { SHORTCUTS } from './ShortcutDefinitions.js';
import { initSearch, toggleSearch, findNext, findPrev, replaceNext } from '../ui/Search.js';
// import 'highlight.js/styles/github.css'; // REMOVED: Conflicts with Dark Mode (White Background) 
import { initVimMode } from '../editors/Vim.js';
import { initWelcomeScreen, showWelcomeScreen, hideWelcomeScreen } from '../ui/WelcomeScreen.js';
import { TabSearch } from '../ui/TabSearch.js';
import { initSettingsModal } from '../ui/SettingsModal.js';
import { toggleShortcutGuide } from '../ui/ShortcutGuide.js';
import { OutlineModal } from '../ui/OutlineModal.js';
import { FileSearchModal } from '../ui/FileSearchModal.js';
import { GrepModal } from '../ui/GrepModal.js';
import { GotoLineModal } from '../ui/GotoLineModal.js';
import { focusExplorer } from './Explorer.js';
import { terminalManager } from '../ui/TerminalManager.js';
import GitPanel from '../ui/GitPanel.js';
import { lspClient } from '../lsp/LspClient.js';
import { SyntaxHighlighter } from '../utils/SyntaxHighlighter.js';
import { initJhEditorMcp, runJhaiIntent } from '../ai/JhAiMcp.js';
import { NotesPanel } from '../ui/NotesPanel.js';
import { aiChatPanel } from '../ui/AiChatPanel.js';
import { SelectionActions } from '../ui/SelectionActions.js';
import { DailyNotes } from '../utils/DailyNotes.js';

// Initialize Tauri (Auto-handled by lib, but we might want explicit setup if needed)
import { invoke } from '@tauri-apps/api/core';
import { Toast } from '../ui/Toast.js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { showConfirm } from '../ui/Dialog.js';


import { listen } from '@tauri-apps/api/event';

// ... other imports ...

// Overlay scrollbars: the thumb is transparent until the element is hovered
// (CSS) or actively scrolling. Scroll events fire for wheel, keyboard (arrows /
// PageUp / Space) and programmatic scrolls alike, so one capture-phase listener
// covers every scrollable region without per-element wiring.
function initScrollbarAutoHide() {
    const timers = new WeakMap();
    document.addEventListener('scroll', (e) => {
        const el = e.target;
        if (!el || el === document || el.nodeType !== 1) return;
        el.classList.add('is-scrolling');
        clearTimeout(timers.get(el));
        timers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 900));
    }, true); // capture: scroll doesn't bubble
}

document.addEventListener('DOMContentLoaded', async () => {
    let gitPanel = null;

    initScrollbarAutoHide();

    // Persist the session + unsaved drafts on the way out. `pagehide` fires for
    // window close/reload where `beforeunload` may not in a webview, and
    // `visibilitychange` covers the app being hidden/killed by the OS.
    const _flush = () => { try { flushSession(); } catch (_) { /* ignore */ } };
    window.addEventListener('pagehide', _flush);
    window.addEventListener('beforeunload', _flush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') _flush();
    });

    // 1. Custom Title Bar Controls
    try {
        const appWindow = getCurrentWindow();
        const minimizeBtn = document.getElementById('titlebar-minimize');
        const maximizeBtn = document.getElementById('titlebar-maximize');
        const closeBtn = document.getElementById('titlebar-close');

        if (minimizeBtn) minimizeBtn.addEventListener('click', () => appWindow.minimize());
        if (maximizeBtn) maximizeBtn.addEventListener('click', async () => {
            const maximized = await appWindow.isMaximized();
            if (maximized) {
                await appWindow.unmaximize();
            } else {
                await appWindow.maximize();
            }
        });
        if (closeBtn) closeBtn.addEventListener('click', () => appWindow.close());
    } catch (e) {
        console.error('Title bar init failed:', e);
    }

    // 2. Initialize UI Components
    try {
        initLayout();
        initExplorer(openFile, { closeFileByPath, closeFilesUnderDir });   // Pass callback for 'OpenFile' and 'CloseFile'
        initSearch(renderEditor); // Pass callback for 'renderEditor'
        initVimMode();
        initSettingsModal();
    } catch (e) {
        console.error('Core UI initialization failed', e);
    }

    // 2.1 Post-Initial Paint Initializations (Performance Tuning)
    const deferInits = () => {
        try {
            // Terminal, LSP & SyntaxHighlighter
            terminalManager.init();
            lspClient.init();
            // Refresh the status bar's LSP warning when a server's availability
            // changes (start_lsp resolves asynchronously after a file opens).
            lspClient.onServerStatusChange = () => { try { updateStatusBar(); } catch (_) {} };
            SyntaxHighlighter.init().then(() => {
                // Re-render highlights in the active view once Shiki is ready
                const view = getCurrentView();
                if (view && typeof view._renderHighlights === 'function') {
                    view._renderHighlights();
                } else if (view) {
                    // For MarkdownView and other views, trigger full re-render
                    renderEditor();
                }
            }).catch(e => console.warn('SyntaxHighlighter init failed:', e));

            // Git Panel
            gitPanel = new GitPanel();
            const gitContainer = document.getElementById('explorer-git-panel');
            if (gitContainer) gitContainer.appendChild(gitPanel.element);

            window.addEventListener('git-status-updated', (e) => {
                const status = e.detail;
                const branchEl = document.getElementById('status-git-branch');
                if (branchEl) {
                    if (status && status.branch) {
                        branchEl.textContent = `🌿 ${status.branch}`;
                        branchEl.style.display = 'inline';
                    } else {
                        branchEl.style.display = 'none';
                    }
                }
            });

            // Make git panel globally accessible for auto-refresh
            window.app.gitPanel = gitPanel;

            // Heavy visual/parse stuff
            configureMarkdown();
            initMermaid();

            // JHAI "AI Hub" MCP adapter — expose JHEditor's buffer/selection as
            // tools JHAI's LLM can call, and run intents (e.g. summarize_logs).
            // Non-fatal: connects in the background, retries if JHAI is offline.
            initJhEditorMcp()
                .then((ai) => { window.app.jhaiMcp = ai; })
                .catch((e) => console.warn('JHAI MCP init failed:', e));
            window.app.runJhaiIntent = runJhaiIntent;
        } catch (e) {
            console.error('Deferred initialization failed', e);
        }
    };

    if (window.requestIdleCallback) {
        window.requestIdleCallback(deferInits);
    } else {
        setTimeout(deferInits, 500);
    }

    // 2.2 Welcome Screen (Visible Part)
    initWelcomeScreen(async (path) => {
        await switchProject(path);
        hideWelcomeScreen();
        // Show Main Layout
        const mainLayout = document.getElementById('main-layout');
        if (mainLayout) {
            mainLayout.style.display = 'flex';
        }
    });

    async function switchProject(path) {
        // Persist the OUTGOING project's session before anything closes, then
        // pause persistence: closeAllTabs() empties the tab list while
        // State.currentDir still points at the old project, which would
        // otherwise save an empty session over it.
        flushSession();
        sessionSuspend();
        let closed;
        try {
            // 1. Close all tabs with dirty check
            closed = await closeAllTabs();
        } finally {
            if (!closed) sessionResume(); // aborted → put persistence back
        }
        if (!closed) return false;

        // 2. Set State and Root (per-window; the backend keys this by window).
        State.currentDir = path;
        sessionResume(); // now scoped to the NEW workspace
        await invoke('set_workspace_root', { path });
        updateWindowTitle();
        loadExplorer();
        
        // 3. Restart Terminal
        if (terminalManager) {
            await terminalManager.restart();
        }

        // 4. Git Repo Selection — no dialog: default to the first repo found and
        // remember the full list so the Git panel can switch between them.
        try {
            const repos = await invoke('find_git_repos', { path });
            const toAbs = (r) => (r === '.' ? path : `${path}/${r}`.replace(/\\/g, '/'));
            State.gitRepos = repos.map(r => ({
                name: r === '.' ? 'Root Repository' : r,
                path: toAbs(r)
            }));
            State.gitRoot = repos.length > 0 ? toAbs(repos[0]) : path;
            if (gitPanel) gitPanel.refresh();
        } catch (e) {
            console.error('Failed to detect Git repos:', e);
            State.gitRepos = [];
            State.gitRoot = path;
        }

        // 5. Reopen the tabs this workspace had last time (and recover any
        //    unsaved edits). Non-fatal: a broken session must not block opening
        //    the project.
        try {
            await restoreSession();
        } catch (e) {
            console.warn('Session restore failed:', e);
        }

        window.dispatchEvent(new CustomEvent('app:project-switched', { detail: { path } }));
        return true;
    }

    // Expose switchProject globally
    window.app.switchProject = switchProject;

    // Open a SPECIFIC workspace/file in a new window (same process). Empty path
    // is NOT substituted with the current dir — callers pass what they mean.
    window.app.openWorkspaceInNewWindow = async (path) => {
        try {
            await invoke('create_app_window', { path: path || '' });
        } catch (e) {
            console.error('Failed to open new window', e);
        }
    };

    // Open a brand-new, workspace-less process (lands on the Welcome screen).
    window.app.openNewWindow = () => window.app.openWorkspaceInNewWindow('');

    // Bring THIS window to the foreground (used when a file is opened here).
    async function activateWindow() {
        try {
            const w = getCurrentWindow();
            if (w.unminimize) await w.unminimize();
            if (w.show) await w.show();
            await w.setFocus();
        } catch (e) { /* non-critical */ }
    }
    window.app.activateWindow = activateWindow;

    // Set the OS window title (taskbar / thumbnails) to the workspace name — or
    // the file name for a workspace-less window — so multiple windows are
    // distinguishable. Falls back to the plain app name.
    const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || '';
    function updateWindowTitle(fileName) {
        let label = '';
        if (State.currentDir) label = baseName(State.currentDir);
        else if (fileName) label = baseName(fileName);
        const title = label ? `${label} — J.H Editor` : 'J.H Editor';
        try { getCurrentWindow().setTitle(title); } catch (_) { /* non-critical */ }
    }
    window.app.updateWindowTitle = updateWindowTitle;

    const showMainLayout = () => {
        hideWelcomeScreen();
        const mainLayout = document.getElementById('main-layout');
        if (mainLayout) {
            mainLayout.style.display = 'flex';
            window.dispatchEvent(new Event('resize'));
        }
    };

    // Normalize a filesystem path for case/slash-insensitive comparison.
    const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const isUnderDir = (file, dir) => {
        if (!dir) return false;
        const f = normPath(file), d = normPath(dir);
        return f === d || f.startsWith(d + '/');
    };

    // Route an externally-requested path (double-click / single-instance) to the
    // right process: a folder opens here as a workspace; a file opens here if it
    // lives under THIS workspace, otherwise it is handed to the process that owns
    // its workspace, or opened in a fresh workspace-less process.
    async function handleIncomingPath(target) {
        if (!target) return false;
        try {
            const isDir = await invoke('path_is_dir', { path: target }).catch(() => false);
            if (isDir) {
                await switchProject(target);
                showMainLayout();
                await activateWindow();
                return true;
            }
            // File: prefer this window when it owns the containing workspace.
            if (isUnderDir(target, State.currentDir)) {
                await openFile(target);
                showMainLayout();
                await activateWindow();
                return true;
            }
            // Not under this window's workspace. If THIS window has no workspace,
            // open here; otherwise open a fresh workspace-less window. (Routing a
            // file to another window that owns it is done in the backend's
            // single-instance handler for OS double-clicks.)
            if (!State.currentDir) {
                State.isExplorerVisible = false;
                if (EL.explorer) EL.explorer.style.display = 'none';
                await openFile(target);
                showMainLayout();
                await activateWindow();
                return true;
            }
            await invoke('create_app_window', { path: target }).catch(() => {});
            return false;
        } catch (e) {
            console.error('handleIncomingPath failed', e);
            return false;
        }
    }
    window.app.handleIncomingPath = handleIncomingPath;

    // Backend asked a specific window to open a file. The payload carries the
    // target window label; ignore events meant for other windows (Tauri v2 global
    // `listen` receives events regardless of the emit target).
    const myLabel = (() => { try { return getCurrentWindow().label; } catch (_) { return null; } })();
    listen('open-external-file', async (event) => {
        const p = event.payload;
        const path = (typeof p === 'string') ? p : (p && p.path);
        const targetLabel = (p && typeof p === 'object') ? p.label : null;
        if (targetLabel && myLabel && targetLabel !== myLabel) return; // not for this window
        if (path) {
            try {
                await openFile(path);
                showMainLayout();
                updateWindowTitle(path);
                await activateWindow();
            } catch (e) { console.error('open-external-file failed', e); }
        }
    }).catch(e => console.error('Failed to register open-external-file listener', e));

    // 3. Global Event Listeners
    if (EL.newFileBtn) EL.newFileBtn.addEventListener('click', createNewFileAction);
    if (EL.newTabBtn) EL.newTabBtn.addEventListener('click', createNewFileAction);
    if (EL.saveBtn) EL.saveBtn.addEventListener('click', saveCurrentFile);

    // Title bar: Notes button opens the quick-notes panel; Ctrl+Click opens
    // today's daily note instead (both are reachable without the command palette).
    const notesBtn = document.getElementById('notes-btn');
    if (notesBtn) {
        notesBtn.addEventListener('click', (e) => {
            if (e.ctrlKey || e.metaKey) DailyNotes.openToday();
            else NotesPanel.open();
        });
        notesBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            DailyNotes.openToday();
        });
    }

    if (EL.openFolderBtn) {
        EL.openFolderBtn.onclick = async () => {
            try {
                const folder = await open({
                    directory: true,
                    multiple: false,
                    title: 'Open Workspace'
                });

                if (folder) {
                    await switchProject(folder);
                }
            } catch (e) {
                console.error('Failed to open folder dialog', e);
            }
        };
    }
    
    // Explorer Tab System (Files / Git)
    const explorerTabs = document.querySelectorAll('.explorer-tab');
    const switchExplorerPanel = (panelName) => {
        // Toggle tab active states
        explorerTabs.forEach(t => t.classList.toggle('active', t.dataset.panel === panelName));
        
        // Toggle panel visibility
        const filesPanel = document.getElementById('explorer-files-panel');
        const gitPanelEl = document.getElementById('explorer-git-panel');
        
        if (filesPanel) filesPanel.style.display = panelName === 'files' ? 'flex' : 'none';
        if (gitPanelEl) gitPanelEl.style.display = panelName === 'git' ? 'flex' : 'none';
        
        // Lazy-init Git panel
        if (panelName === 'git') {
            if (!gitPanel) {
                gitPanel = new GitPanel();
                gitPanelEl.appendChild(gitPanel.element);
            }
            gitPanel.refresh();
        }
    };
    
    explorerTabs.forEach(tab => {
        tab.addEventListener('click', () => switchExplorerPanel(tab.dataset.panel));
    });



    // Register Global Shortcuts
    const switchTabRelative = (delta) => {
        const isLeft = !(State.splitMode && State.activePane === 'right');
        const files = isLeft ? State.openFiles : State.rightOpenFiles;
        const idx = isLeft ? State.activeTabIndex : State.rightActiveTabIndex;
        if (!files || files.length < 2) return;
        const n = (((idx + delta) % files.length) + files.length) % files.length;
        setActiveTab(n, isLeft ? 'left' : 'right');
    };

    const globalActions = {
        'app:diff': () => {
            const isLeft = !(State.splitMode && State.activePane === 'right');
            const file = isLeft ? State.openFiles[State.activeTabIndex] : State.rightOpenFiles[State.rightActiveTabIndex];
            if (file) compareWithDisk(file);
        },
        'app:open-compare': () => openCompareEditor(),
        'app:toggle-whitespace': () => toggleWhitespace(),
        'app:save': saveCurrentFile,
        'app:save-as': saveCurrentFileAs,
        'app:search': toggleSearch,
        'app:file-search': () => FileSearchModal.show(),
        'app:grep': () => GrepModal.show(),
        'app:format': formatCurrentFile,
        'app:outline-modal': () => OutlineModal.show(),
        'app:new-file': createNewFileAction,
        // Ctrl+W closes the tab in the FOCUSED pane (split-aware). In an unsplit
        // editor activePane() is always 'left', so this is a plain close-tab.
        'app:close-tab': () => {
            const pane = activePane();
            const idx = paneActiveIndex(pane);
            if (idx >= 0) closeTab(idx, pane);
        },
        // Cycle editor tabs (Ctrl+Tab / Ctrl+Shift+Tab). These were listed in the
        // shortcut table but had no action.
        'editor:next-tab': () => switchTabRelative(1),
        'editor:prev-tab': () => switchTabRelative(-1),
        'app:goto-line': () => GotoLineModal.show(),
        'app:toggle-vim': () => {
            const v = getCurrentView();
            if (v && typeof v.setVimEnabled === 'function') v.setVimEnabled(!v.isVimEnabled());
        },
        'app:toggle-book-mode': () => {
            const v = getCurrentView();
            if (v && typeof v.toggleBookMode === 'function') v.toggleBookMode();
        },
        // Preview toggle (Ctrl+Shift+P): opens the HTML preview pane for .html
        // files (CodeMirrorView.toggleHtmlPreview), and the markdown preview for
        // .md files (MarkdownView has no toggle — the block editor previews live,
        // so this is a no-op there).
        'app:toggle-preview': () => {
            const v = getCurrentView();
            if (v && typeof v.toggleHtmlPreview === 'function') v.toggleHtmlPreview();
        },
        'app:find-next': findNext,
        'app:find-prev': findPrev,
        'app:replace-next': replaceNext,
        'app:refresh-explorer': loadExplorer,
        'app:shortcut-guide': toggleShortcutGuide,
        'app:focus-explorer': focusExplorer,
        'app:focus-editor': () => focusEditor({ toStart: true }),
        'app:agent-tasks': () => {
            if (window.app && window.app.openAgentTasksTab) {
                window.app.openAgentTasksTab();
            }
        },
        'app:new-note': () => NotesPanel.open({ create: true }),
        'app:open-notes': () => NotesPanel.open(),
        'app:devtools': async () => {
            try { await invoke('open_devtools'); }
            catch (e) { Toast.info(String(e && e.message ? e.message : e)); }
        },
        'app:toggle-ai-chat': () => aiChatPanel.toggle(),
        'app:summarize-selection': () => SelectionActions.summarize(),
        'app:translate-selection': () => SelectionActions.translate(),
        'app:rephrase-selection': () => SelectionActions.rephrase(),
        'app:daily-note': () => DailyNotes.openToday(),
        'app:git-panel': () => {
            const btn = document.getElementById('toggle-git-btn');
            if (btn) btn.click();
        },
        // Delegates to the single implementation in Editor.js. This used to be a
        // second, hand-copied version whose extension list had drifted (it was
        // missing .jsp/.htm, so Ctrl+Shift+E silently did nothing for those) and
        // it lacked the large-file guard. App.js registers after Editor.js, so
        // the stale copy was the one that actually ran.
        'app:toggle-view-mode': (e) => {
            if (e && e.preventDefault) e.preventDefault();
            window.app.toggleViewMode();
        },
        // Clipboard Delegation
        'app:copy': triggerCopy,
        'app:cut': triggerCut,
        'app:paste': triggerPaste,
        // Initialize LSP and SyntaxHighlighter
        'app:init-lsp-syntax': () => {
            Promise.all([
                lspClient.init(),
                SyntaxHighlighter.init()
            ]).then(() => {
                // Trigger a re-render of the active view to apply highlighting if already open
                const activeView = getCurrentView();
                if (activeView && typeof activeView._renderHighlights === 'function') {
                    activeView._renderHighlights();
                }
            });
        },
        'app:undo': () => {
            const view = getCurrentView();
            if (view && typeof view.undo === 'function') {
                view.undo();
            } else {
                document.execCommand('undo');
            }
        },
        'app:redo': () => {
            const view = getCurrentView();
            if (view && typeof view.redo === 'function') {
                view.redo();
            } else {
                document.execCommand('redo');
            }
        },
        // Inline AI
        'app:inline-ai': () => {
            const view = getCurrentView();
            if (view && typeof view._handleInlineAI === 'function') {
                if (view.textarea) view._handleInlineAI(view.textarea);
                else if (view.sourceTextarea) view._handleInlineAI(view.sourceTextarea);
                else view._handleInlineAI();
            } else if (view && view.inlineAI && typeof view.inlineAI.show === 'function') {
                view.inlineAI.show(); // Fallback if view exposes it
            }
        }
    };

    SHORTCUTS.GLOBAL.forEach(s => {
        if (globalActions[s.cmd]) {
            shortcuts.register({ ...s, action: globalActions[s.cmd] });
        }
    });


    // Status-bar whitespace toggle: click to show/hide CR/LF/TAB markers.
    const whitespaceIndicator = document.getElementById('status-whitespace');
    if (whitespaceIndicator) {
        whitespaceIndicator.classList.toggle('active', State.showWhitespace);
        whitespaceIndicator.addEventListener('click', () => toggleWhitespace());
    }

    // Status-bar EOL indicator: click to change the file's line-ending style.
    const eolIndicator = document.getElementById('status-eol');
    if (eolIndicator) {
        eolIndicator.addEventListener('click', (e) => {
            ContextMenu.show(e, [
                { label: 'LF (\\n) — Unix/macOS', action: () => setFileEol('\n') },
                { label: 'CRLF (\\r\\n) — Windows', action: () => setFileEol('\r\n') },
                { label: 'CR (\\r) — Classic Mac', action: () => setFileEol('\r') },
            ]);
        });
    }

    // Register Scope-Specific Shortcuts (Fix: These were missing!)
    SHORTCUTS.EDITOR.forEach(s => {
        // Map editor commands to internal logic if needed, or if they are View-specific, 
        // the View should handle them? 
        // Actually ShortcutDefinitions.js maps `editor:next-tab` etc.
        // We need to define those actions here or in specific modules.
        // For `editor:next-tab`, let's define them in `globalActions` or a separate `editorScopedActions`.

        // Let's check `editorActions` defined earlier in this file.
    });

    // Actually `editorActions` was defined at top of file, but we only registered GLOBAL and MARKDOWN_BLOCK.
    // We need to register EDITOR, CSV, etc.



    // Register all scope-specific shortcuts from SHORTCUTS
    const delegateToView = (cmd) => (e) => {
        const view = getCurrentView();
        if (view && view.handleShortcut) {
            const result = view.handleShortcut(cmd, e);
            // If view explicitly returns true, it handled the shortcut
            if (result === true) return;
        }

        // Fallback: if view didn't handle it (returned undefined/false/nothing),
        // check if there's a global action for this command
        if (globalActions[cmd]) {
            globalActions[cmd](e);
        }
    };

    // Skip GLOBAL as it's handled separately above. IMPORTANT: only register
    // the view-delegation fallback for commands that NO module has already
    // claimed with a real action. Editor.js (GLOBAL/MARKDOWN_BLOCK/EDITOR),
    // Explorer.js (EXPLORER) and MarkdownView (MARKDOWN/MARKDOWN_TABLE)
    // register concrete actions at import/init time; blindly re-registering
    // every scope entry here with delegateToView() would OVERWRITE those real
    // actions, and views without handleShortcut (MarkdownView, the explorer)
    // would then silently drop the key (F2 rename / F2 edit block broke this
    // way). Commands no module claimed (e.g. the CSV scope, which is delegated
    // to CsvView.handleShortcut) still get the delegateToView fallback.
    for (const scope in SHORTCUTS) {
        if (scope === 'GLOBAL') continue;
        SHORTCUTS[scope].forEach(s => {
            // Entries without a cmd are documentation-only: keys owned by
            // CodeMirror or a view's own handler. Registering them would attach
            // an action and make ShortcutManager preventDefault the key, so the
            // real handler would never see it.
            if (!s.cmd) return;
            const existing = shortcuts.shortcuts.find(x => x.cmd === s.cmd && x.scope === scope);
            if (existing && typeof existing.action === 'function') return;
            shortcuts.register({ ...s, action: globalActions[s.cmd] || delegateToView(s.cmd), scope });
        });
    }

    // 4. Initial Load Global Event Listeners
    setupCloseListener();
    window.addEventListener('app:save-shortcut', saveCurrentFile);

    // Handle shortcuts dispatched from views via CustomEvent (e.g. MarkdownView block editor)
    window.addEventListener('shortcutTriggered', (e) => {
        const cmd = e.detail.command;
        if (globalActions[cmd]) {
            globalActions[cmd](e.detail.originalEvent);
        }
    });

    // Drag & Drop Listener
    // Note: listen returns a Promise that resolves to an unlisten function.
    // We should not await it blocking the rest of init if it takes time, but it's usually fast.
    // However, to be safe and ensure it runs:
    // Tauri v2 provides drop paths + position. Route by where the file was
    // dropped: onto the tab bar → open the file(s); onto the editor → insert the
    // (first) file's content at the caret, as before.
    listen('tauri://drag-drop', async (event) => {
        const paths = event.payload && event.payload.paths;
        if (!paths || paths.length === 0) return;

        // Physical → CSS pixels for elementFromPoint.
        const dpr = window.devicePixelRatio || 1;
        const pos = event.payload.position || { x: 0, y: 0 };
        const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
        const onTabBar = !!(el && el.closest && (
            el.closest('#tabs-container') || el.closest('#tabs-container-right') ||
            el.closest('.tab') || el.closest('#tabs-bar') || el.closest('.tabs-bar') ||
            el.closest('#explorer')
        ));

        hideWelcomeScreen();
        const mainLayout = document.getElementById('main-layout');
        if (mainLayout) { mainLayout.style.display = 'flex'; window.dispatchEvent(new Event('resize')); }

        if (onTabBar || !getCurrentView()) {
            // Open the dropped file(s) as tabs.
            paths.forEach(p => openFile(p));
            return;
        }

        // Dropped on the editor: insert the first file's text at the caret.
        const view = getCurrentView();
        if (view && typeof view.insertTextAtCursor === 'function') {
            try {
                const res = await invoke('read_file_auto_detect', { path: paths[0] });
                const content = (res && res.content) ? res.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : '';
                view.insertTextAtCursor(content);
            } catch (e) {
                console.warn('Drop-insert failed, opening instead:', e);
                paths.forEach(p => openFile(p));
            }
        } else {
            paths.forEach(p => openFile(p));
        }
    }).catch(e => console.error('Failed to register drag-drop listener', e));

    // With dragDropEnabled: false (required for HTML5 tab / explorer drag-and-
    // drop on Windows), Tauri's tauri://drag-drop event no longer fires for OS
    // file drops. Re-create the external-file-drop behaviour with plain HTML5
    // events. WebView2 exposes the real filesystem path on File.path (non-
    // standard but reliable there); other platforms fall back to File.name.
    const extDropHandler = async (e) => {
        const dt = e.dataTransfer;
        if (!dt) return;
        // Internal JHEditor drags (tabs / explorer rows) carry their own custom
        // MIME types and are handled by their own drop handlers — leave them be.
        if (dt.types && Array.from(dt.types).some(t => t.startsWith('application/x-jheditor') || t === 'application/x-editor-item')) return;
        const files = Array.from(dt.files || []);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = files.map(f => f.path || f.name).filter(Boolean);
        if (paths.length === 0) return;
        const el = e.target;
        const onTabBar = !!(el && el.closest && (
            el.closest('#tabs-container') || el.closest('#tabs-container-right') ||
            el.closest('.tab') || el.closest('#tabs-bar') || el.closest('.tabs-bar') ||
            el.closest('#explorer')
        ));
        hideWelcomeScreen();
        const mainLayout = document.getElementById('main-layout');
        if (mainLayout) { mainLayout.style.display = 'flex'; window.dispatchEvent(new Event('resize')); }
        if (onTabBar || !getCurrentView()) {
            paths.forEach(p => openFile(p));
            return;
        }
        const view = getCurrentView();
        if (view && typeof view.insertTextAtCursor === 'function') {
            try {
                const res = await invoke('read_file_auto_detect', { path: paths[0] });
                const content = (res && res.content) ? res.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : '';
                view.insertTextAtCursor(content);
            } catch (err) {
                console.warn('Drop-insert failed, opening instead:', err);
                paths.forEach(p => openFile(p));
            }
        } else {
            paths.forEach(p => openFile(p));
        }
    };
    // Only needs to fire when actual files come in; guard on the dragenter so
    // we don't fight the internal tab/explorer drag sources.
    document.addEventListener('drop', extDropHandler);
    document.addEventListener('dragover', (e) => {
        const dt = e.dataTransfer;
        if (!dt) return;
        const types = dt.types ? Array.from(dt.types) : [];
        if (types.some(t => t.startsWith('application/x-jheditor') || t === 'application/x-editor-item')) return;
        if (types.includes('Files') && (dt.files && dt.files.length > 0)) e.preventDefault();
    });

    // Subsequent launches (a second `JHEditor.exe <path>`) are handled entirely
    // in the backend single-instance callback: it focuses the window that owns
    // the file's workspace (emitting `open-external-file` to it) or opens a new
    // window. Nothing to listen for here.

    // 5. Initial Load Logic
    // Open the launch arg (workspace folder or file) if any; otherwise show the
    // Welcome screen — standard behavior for a fresh / workspace-less window.
    checkLaunchArgs().then((launched) => {
        if (!launched) showWelcomeScreen();
    });

    // Disable the default context menu (User Request) — EXCEPT on text fields,
    // where the native Cut/Copy/Paste menu is expected (e.g. the grep / search
    // inputs). Editable areas get their own menus elsewhere.
    document.addEventListener('contextmenu', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
            return; // allow native clipboard menu
        }
        e.preventDefault();
    });

    // Block browser reload shortcuts (Ctrl/Cmd+R, Ctrl+Shift+R, F5). A reload
    // discards the current session and returns to the selection screen, which
    // the user explicitly does not want. DevTools reload is unaffected.
    window.addEventListener('keydown', (e) => {
        const isReloadCombo =
            e.key === 'F5' ||
            ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'));
        if (isReloadCombo) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    // 6. Show Window (Hidden by default in tauri.conf.json to avoid white flash)
    try {
        getCurrentWindow().show();
    } catch (e) {
        console.error('Failed to show window', e);
    }
});

async function checkLaunchArgs() {
    try {
        // A window opened via create_app_window carries an assigned path. The
        // first window (from tauri.conf) has none → fall back to CLI args.
        let target = '';
        try { target = (await invoke('take_launch_path')) || ''; } catch (_) {}
        if (!target) {
            const args = await invoke('get_launch_args').catch(() => []);
            const paths = (Array.isArray(args) ? args : []).slice(1).filter(a => a && !a.startsWith('--'));
            target = paths[0] || '';
        }
        if (!target) return false;

        const showMain = () => {
            const mainLayout = document.getElementById('main-layout');
            if (mainLayout) {
                mainLayout.style.display = 'flex';
                window.dispatchEvent(new Event('resize'));
            }
        };

        const isDir = await invoke('path_is_dir', { path: target }).catch(() => false);
        if (isDir) {
            // Folder → open as this window's workspace.
            hideWelcomeScreen();
            await window.app.switchProject(target);
            showMain();
            await window.app.activateWindow?.();
            return true;
        }

        // File → open directly as a workspace-less view in this window.
        State.isExplorerVisible = false;
        if (EL.explorer) EL.explorer.style.display = 'none';
        hideWelcomeScreen();
        await openFile(target);
        showMain();
        window.app.updateWindowTitle?.(target);
        await window.app.activateWindow?.();
        return true;
    } catch (e) {
        console.error('Failed to check launch args', e);
    }
    return false;
}

function setupCloseListener() {
    try {
        const appWindow = getCurrentWindow();
        appWindow.onCloseRequested(async (event) => {
            const hasDirty = State.openFiles.some(f => f.isDirty);
            if (hasDirty) {
                // Prevent closing immediately
                event.preventDefault();

                const discard = await showConfirm('You have unsaved changes. Quit and discard them?', {
                    title: 'Unsaved Changes',
                    kind: 'warning',
                    okLabel: 'Quit (Discard)',
                    cancelLabel: 'Cancel'
                });

                if (discard) {
                    // Force close if user confirms discard
                    appWindow.destroy();
                }
            }
        });
    } catch (e) {
        console.error('Failed to setup close listener', e);
    }
}
