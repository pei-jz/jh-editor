import { State } from './Store.js';
import { EL } from './Constants.js';
import { configureMarkdown } from '../utils/Markdown.js';
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
import { CommandPalette, initCommandPalette } from '../ui/CommandPalette.js';
import { applyIcons } from '../ui/Icons.js';
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
import { showConfirm, showAlert, showDialog } from '../ui/Dialog.js';
import { setPaneActiveIndex } from './Panes.js';
import { applyI18n, t } from '../utils/I18n.js';


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

/**
 * Startup safety net.
 *
 * The window is created with `visible: false` (tauri.conf.json) so the user
 * never sees an unpainted white rectangle while the frontend boots. The cost of
 * that trade is that the FRONTEND owns making the window appear — and when boot
 * threw on the way there, the process stayed alive with no window at all. From
 * the outside that is an application that does nothing when you launch it, with
 * no error, no log the user can reach, and nothing to report. A corrupt session
 * file was enough to cause it.
 *
 * So: every exit from boot ends at `showMainWindow()` — success, throw, or a
 * hang that never returns — and a failure puts the error on screen instead of
 * leaving a blank window behind.
 */
let _windowShown = false;
let _bootFinished = false;

/** Reveal the main window. Idempotent — the watchdog and the normal path race. */
function showMainWindow() {
    if (_windowShown) return;
    _windowShown = true;
    try {
        getCurrentWindow().show();
    } catch (e) {
        console.error('Failed to show window', e);
    }
}

/**
 * Boot failed. Show the window anyway and put the error somewhere the user can
 * read and copy it, rather than leaving them with a window that never appears.
 *
 * Built with createElement/textContent, not innerHTML: this runs when the app
 * is already in an unknown state, and an error message is the last place that
 * should be able to inject markup.
 */
function reportBootFailure(err) {
    console.error('Startup failed', err);
    try {
        const detail = (err && (err.stack || err.message)) || String(err);

        const box = document.createElement('div');
        box.setAttribute('role', 'alert');
        box.style.cssText = 'position:fixed; inset:0; z-index:99999; overflow:auto;'
            + 'display:flex; flex-direction:column; gap:12px; padding:32px;'
            + 'background:var(--bg-color,#1e1e1e); color:var(--text-color,#ddd);'
            + 'font-family:system-ui,sans-serif; font-size:14px; line-height:1.6;';

        const title = document.createElement('h2');
        title.textContent = t('J.H Editor failed to start');
        title.style.cssText = 'margin:0; font-size:18px;';

        const hint = document.createElement('p');
        // One key for the whole sentence. Splitting a sentence across keys
        // makes it untranslatable — word order is not the same in every
        // language, so a translator needs the whole thought.
        hint.textContent = t('The editor could not finish loading. The error is below — please include it when reporting this. Restarting may clear it; if it persists, the saved session may be corrupt.');
        hint.style.cssText = 'margin:0; max-width:70ch; opacity:.85;';

        const pre = document.createElement('pre');
        pre.textContent = detail;
        pre.style.cssText = 'margin:0; padding:12px; border-radius:4px; overflow:auto;'
            + 'background:rgba(127,127,127,.15); white-space:pre-wrap; user-select:text;';

        box.append(title, hint, pre);
        document.body.appendChild(box);
    } catch (_) {
        /* The error reporter must never be the thing that throws. */
    }
    showMainWindow();
}

// Nothing was watching for uncaught errors at all, so a failure during boot was
// invisible from inside the app.
//
// These deliberately do NOT paint the failure screen. Plenty of things reject
// during boot without boot having failed — the AI agent being offline, an LSP
// server that is not installed — and covering the editor with "failed to start"
// because a background connect gave up would be worse than the bug this whole
// block exists to fix. The screen is reserved for `bootstrap()` itself
// throwing, which is the only signal that actually means boot did not finish.
// What these guarantee is the part that matters: whatever goes wrong, the user
// gets a window rather than a process with no UI.
window.addEventListener('error', (e) => {
    if (_bootFinished) return;
    console.error('Uncaught error during startup', e.error || e.message);
    showMainWindow();
});
window.addEventListener('unhandledrejection', (e) => {
    if (_bootFinished) return;
    console.error('Unhandled rejection during startup', e.reason);
    showMainWindow();
});

async function bootstrap() {
    let gitPanel = null;

    initScrollbarAutoHide();
    // Static chrome declares icons as data-icon and they are drawn here.
    // Safe to do before paint: the window is still hidden, so there is no
    // moment where the buttons are visibly empty.
    applyIcons();
    applyI18n();

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
                // Re-render highlights in the active view once the highlighter is ready
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
                        branchEl.classList.add('jh-icon-row');
                        branchEl.replaceChildren(
                            iconEl('branch', { size: 12 }),
                            document.createTextNode(status.branch),
                        );
                        branchEl.style.display = 'inline';
                    } else {
                        branchEl.style.display = 'none';
                    }
                }
            });

            // Make git panel globally accessible for auto-refresh
            window.app.gitPanel = gitPanel;

            // Heavy visual/parse stuff. Mermaid is NOT initialised here: it is
            // 2.7 MB that most sessions never draw a diagram with, and
            // renderMermaid() loads and initialises it on the first one.
            configureMarkdown();

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

    /**
     * Enter the editor with NO workspace.
     *
     * "Open File" and "New File" are the answer to "I just want to write
     * something", so neither adopts a folder. That has to be done explicitly:
     * the explorer, workspace grep and the Git panel all key off
     * `State.currentDir`, and leaving it set — or leaving the empty explorer
     * on screen — presents a workspace the user never chose.
     *
     * Same shape as the single-file launch argument path (`checkLaunchArgs`),
     * which is why both go through here instead of each doing it their own way.
     */
    function startWorkspaceless() {
        State.currentDir = '';
        State.isExplorerVisible = false;
        if (EL.explorer) EL.explorer.style.display = 'none';
        showMainLayout();
    }
    window.app.startWorkspaceless = startWorkspaceless;

    // 2.2 Welcome Screen (Visible Part)
    initWelcomeScreen(
        async (path) => {
            await switchProject(path);
            showMainLayout();
        },
        {
            onOpenFile: async (path) => {
                startWorkspaceless();
                await openFile(path);
                window.app.updateWindowTitle?.(path);
            },
            onNewFile: () => {
                startWorkspaceless();
                createNewFileAction();
            },
        },
    );

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

    // A shortcut cannot tell you it exists, so the shortcut guide gets a
    // permanent, visible way in. It shows its own key, so it is a lesson as
    // much as a button.
    // The always-visible way in. It used to open the shortcut GUIDE, which
    // only lists things and only the things that have a key bound; it now
    // opens the palette, which lists everything and runs it. The guide is
    // still one row down the palette, and still on F1.
    EL.statusCommandsBtn?.addEventListener('click', () => CommandPalette.toggle());

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
        'app:command-palette': () => CommandPalette.toggle(),
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

    // The palette runs commands through exactly the path a keystroke takes —
    // active view first, global action second. Anything else would give a
    // command two behaviours depending on how it was invoked.
    initCommandPalette((cmd) => delegateToView(cmd)(null));

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
    showMainWindow();
}

document.addEventListener('DOMContentLoaded', () => {
    // The watchdog covers the case a try/catch cannot: boot does not throw, it
    // simply never returns — an await on something that will not settle. Four
    // seconds is far longer than a normal boot and far shorter than the user
    // deciding the app is broken.
    const watchdog = setTimeout(showMainWindow, 4000);

    bootstrap()
        .catch(reportBootFailure)
        .finally(() => {
            clearTimeout(watchdog);
            _bootFinished = true;
            // Belt to the watchdog's braces: whatever happened above, the
            // window is visible by the time this resolves.
            showMainWindow();
        });
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
        // Same helper the Welcome screen's "Open File" uses, so the two cannot
        // drift into treating a lone file differently.
        hideWelcomeScreen();
        if (window.app.startWorkspaceless) window.app.startWorkspaceless();
        else {
            State.isExplorerVisible = false;
            if (EL.explorer) EL.explorer.style.display = 'none';
        }
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

/**
 * A buffer that has never been written to disk, so saving it must ask the user
 * where to put it. Same test `saveCurrentFile()` applies before opening its
 * Save As dialog — a relative path counts as "not yet on disk".
 */
function needsSaveLocation(file) {
    const p = file && file.path;
    return !(p && (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')));
}

/**
 * Save every dirty buffer, whichever pane it is in.
 *
 * Each file is made active first because saveCurrentFile() works on the active
 * tab — saving them in place would write the front file's text once per dirty
 * buffer.
 *
 * Two things make this more than a loop:
 *
 *  - Buffers that already have a path go FIRST. They save without asking
 *    anything, and the old order could reach an untitled buffer, have the user
 *    cancel its Save As, and abandon the quit with work still unwritten that
 *    needed no dialog at all.
 *  - Cancelling a Save As is reported separately from a save that FAILED.
 *    Both left the buffer dirty, so both used to come back as "Could not
 *    save" — telling the user something went wrong when they had simply
 *    changed their mind.
 *
 * Returns `{ failed, cancelled }`, both arrays of display names.
 */
async function saveAllDirty(dirty) {
    const ordered = [
        ...dirty.filter((f) => !needsSaveLocation(f)),
        ...dirty.filter((f) => needsSaveLocation(f)),
    ];

    const failed = [];
    const cancelled = [];

    for (const file of ordered) {
        // Captured before saving: a successful Save As gives the file a path,
        // so asking afterwards would always answer "no".
        const willPrompt = needsSaveLocation(file);
        const label = file.name || file.path || 'Untitled';
        try {
            const pane = (State.rightOpenFiles || []).includes(file) ? 'right' : 'left';
            const index = (pane === 'right' ? State.rightOpenFiles : State.openFiles).indexOf(file);
            if (index >= 0) setPaneActiveIndex(pane, index);
            await saveCurrentFile();
            if (file.isDirty) (willPrompt ? cancelled : failed).push(label);
        } catch (e) {
            failed.push(label);
        }
    }
    return { failed, cancelled };
}

function setupCloseListener() {
    try {
        const appWindow = getCurrentWindow();
        appWindow.onCloseRequested(async (event) => {
            // Both panes: quitting with the right-hand split's work unsaved was
            // just as final, and this only looked at the left one.
            // A buffer open in both panes is one object in two lists; the Set
            // keeps it from being listed — and saved — twice.
            const dirty = [...new Set([...(State.openFiles || []), ...(State.rightOpenFiles || [])])]
                .filter((f) => f && f.isDirty && (!f.type || f.type === 'file'));
            if (!dirty.length) return;

            event.preventDefault();

            // Name them. "You have unsaved changes" leaves the reader deciding
            // blind about work they cannot see from the dialog.
            const names = dirty.map((f) => f.name || f.path || t('Untitled'));
            const shown = names.slice(0, 6).join('\n  • ');
            const more = names.length > 6 ? `\n  ${t('…and {n} more').replace('{n}', names.length - 6)}` : '';

            // "Save all" on a never-saved buffer opens a Save As dialog, one per
            // buffer. Finding that out only after committing to quit is a
            // surprise; saying so in the dialog makes it a choice.
            const promptCount = dirty.filter(needsSaveLocation).length;
            const promptNote = promptCount
                ? '\n\n' + t('{n} of these have never been saved — you will be asked where to put each one.')
                    .replace('{n}', promptCount)
                : '';

            const choice = await showDialog({
                title: t('Unsaved Changes'),
                kind: 'warning',
                message: t('{n} file(s) have unsaved changes:').replace('{n}', names.length)
                    + `\n\n  • ${shown}${more}${promptNote}`,
                buttons: [
                    { label: t('Cancel'), value: 'cancel', cancel: true },
                    { label: t('Quit without saving'), value: 'discard' },
                    { label: t('Save all and quit'), value: 'save', primary: true },
                ],
            });

            if (choice === 'save') {
                const { failed, cancelled } = await saveAllDirty(dirty);
                // A save that did not happen must not be followed by a quit:
                // the user was told why, and quitting now loses exactly the
                // work they just asked to keep.
                if (failed.length || cancelled.length) {
                    const parts = [];
                    if (failed.length) {
                        parts.push(t('Could not save:') + `\n  • ${failed.join('\n  • ')}`);
                    }
                    if (cancelled.length) {
                        parts.push(t('No location was chosen for:') + `\n  • ${cancelled.join('\n  • ')}`);
                    }
                    await showAlert(
                        parts.join('\n\n') + '\n\n' + t('Nothing was closed.'),
                        {
                            title: failed.length ? t('Save Failed') : t('Save Incomplete'),
                            // A cancelled Save As is a choice, not a fault.
                            kind: failed.length ? 'error' : 'warning',
                        },
                    );
                    return;
                }
                appWindow.destroy();
            } else if (choice === 'discard') {
                appWindow.destroy();
            }
        });
    } catch (e) {
        console.error('Failed to setup close listener', e);
    }
}
