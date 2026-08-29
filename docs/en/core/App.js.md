# App.js Documentation

## File Purpose

`App.js` is the **application entry point** for JHEditor. It orchestrates the entire application lifecycle:
- Initializes all UI components (layout, explorer, search, settings)
- Sets up the custom Tauri title bar controls
- Registers global keyboard shortcuts
- Manages file drag-and-drop and single-instance handling
- Handles workspace/project switching
- Sets up file watcher, git panel, LSP, syntax highlighting, MCP integration
- Manages the welcome screen and initial launch logic

## Exports

This file does not export any named functions or classes. It is a side-effect module that runs on `DOMContentLoaded`.

## Key Internal Functions

### `switchProject(path)`

**Purpose:** Switches the active workspace to a new directory path.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | Absolute path to the new workspace root |

**Returns:** `Promise<boolean>` — `true` if switch succeeded, `false` if user cancelled.

**Logic:**
1. Closes all open tabs (with dirty-file prompts)
2. Sets `State.currentDir` and invokes Tauri backend `set_workspace_root`
3. Reloads the explorer tree
4. Restarts the terminal
5. Detects Git repositories within the workspace
6. Dispatches `app:project-switched` custom event

### `checkLaunchArgs()`

**Purpose:** Checks CLI launch arguments for a file path to open directly (skipping welcome screen).

**Returns:** `Promise<boolean>` — `true` if a file was opened from args.

**Logic:**
- Calls Tauri backend `get_launch_args`
- If a valid file path is found in args, hides explorer, opens the file, shows the main layout

### `setupCloseListener()`

**Purpose:** Intercepts the window close event to prompt users when there are unsaved changes.

**Logic:**
- If any open file has `isDirty === true`, prevents default close
- Shows a confirmation dialog (in Japanese)
- On confirm, calls `appWindow.destroy()` to force-close

## Event Handlers

| Event | Handler | Description |
|-------|---------|-------------|
| `DOMContentLoaded` | Main initialization | Full app bootstrap sequence |
| `click` on titlebar buttons | `appWindow.minimize/maximize/close` | Custom window controls |
| `click` on `newFileBtn`/`newTabBtn` | `createNewFileAction` | Creates a new untitled tab |
| `click` on `saveBtn` | `saveCurrentFile` | Saves the active file |
| `click` on `openFolderBtn` | `open()` dialog → `switchProject` | Opens a new workspace folder |
| `click` on explorer tabs | `switchExplorerPanel` | Toggles between Files and Git panels |
| `tauri://file-drop` | `openFile()` for each dropped file | Handles file drag-and-drop |
| `single-instance` | Opens files from CLI args | Single-instance protocol |
| `git-status-updated` | Updates branch label in status bar | Git status display |
| `shortcutTriggered` | Dispatches to `globalActions` | Custom event for view-triggered shortcuts |
| `contextmenu` | `preventDefault()` | Disables default browser context menu |
| `app:save-shortcut` | `saveCurrentFile` | Delegated save from other modules |

## Global Actions (Shortcut Mappings)

The following shortcuts are registered globally via `SHORTCUTS.GLOBAL`:

| Command | Action |
|---------|--------|
| `app:diff` | Compare active file with disk version |
| `app:open-compare` | Open free-form comparison editor |
| `app:toggle-whitespace` | Toggle CR/LF/TAB markers |
| `app:save` | Save current file |
| `app:search` | Toggle search panel |
| `app:file-search` | Open file search modal |
| `app:format` | Format current file |
| `app:outline-modal` | Open outline navigation |
| `app:new-file` | Create new untitled tab |
| `app:close-tab` | Close active tab |
| `app:find-next` / `app:find-prev` | Search navigation |
| `app:replace-next` | Replace next match |
| `app:refresh-explorer` | Reload file tree |
| `app:shortcut-guide` | Toggle shortcut guide overlay |
| `app:focus-explorer` | Focus the explorer panel |
| `app:focus-editor` | Focus the editor (to start) |
| `app:copy` / `app:cut` / `app:paste` | Clipboard operations |
| `app:undo` / `app:redo` | Undo/Redo in active view |
| `app:inline-ai` | Trigger inline AI on current view |
| `app:toggle-view-mode` | Toggle text/structure view |
| `app:init-lsp-syntax` | Initialize LSP and syntax highlighter |

Non-global shortcuts (EDITOR, MARKDOWN_BLOCK, EXPLORER, etc.) are delegated to the active view via `delegateToView()`.

## Dependencies

| Module | Purpose |
|--------|---------|
| `Store.js` | Application state (`State`) |
| `Constants.js` | DOM element references (`EL`) |
| `Markdown.js` | Markdown config and Mermaid init |
| `Layout.js` | UI layout initialization |
| `Explorer.js` | File tree explorer |
| `Editor.js` | Editor, tabs, file operations |
| `ShortcutManager.js` | Keyboard shortcut registration |
| `ShortcutDefinitions.js` | Shortcut definitions |
| `Search.js` | Search panel |
| `Vim.js` | Vim mode |
| `WelcomeScreen.js` | Welcome screen |
| `TabSearch.js` | Tab search |
| `SettingsModal.js` | Settings UI |
| `ShortcutGuide.js` | Shortcut guide overlay |
| `OutlineModal.js` | Outline navigation |
| `FileSearchModal.js` | File search |
| `TerminalManager.js` | Integrated terminal |
| `GitPanel.js` | Git operations panel |
| `LspClient.js` | Language Server Protocol client |
| `SyntaxHighlighter.js` | Shiki-based syntax highlighting |
| `JhAiMcp.js` | JHAI MCP AI integration |
| `@tauri-apps/api/core` | Tauri invoke |
| `@tauri-apps/api/window` | Window controls |
| `@tauri-apps/plugin-dialog` | Native dialogs |
| `@tauri-apps/api/event` | Tauri event listeners |
