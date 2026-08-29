# Editor.js Documentation

## File Purpose

`Editor.js` is the **editor orchestration module** for JHEditor. At 1641 lines it is the largest core module, responsible for:
- File opening, saving, and closing logic
- Tab management (create, switch, close, reorder, split panes)
- View rendering — selecting the correct view type per file (CodeMirror, Markdown, CSV, Diff, Compare, LargeFile, Agent)
- Split-editor (side-by-side) support
- File watcher integration (native Tauri events)
- Clipboard delegation (copy/cut/paste)
- Status bar updates, context menu setup
- Keyboard shortcut registration for editor-specific commands
- Formatting, undo/redo delegation, and LSP integration hooks

## Constants

| Name | Value | Description |
|------|-------|-------------|
| `LARGE_FILE_VIEW_THRESHOLD` | `500 * 1024 * 1024` (500 MB) | Files above this size open in read-only virtualized LargeFileView |

## Module-Level State

| Variable | Type | Description |
|----------|------|-------------|
| `leftView` | `object \| null` | Current view instance for the left editor pane |
| `rightView` | `object \| null` | Current view instance for the right editor pane (split mode) |
| `activeUnwatch` | `function \| null` | Cleanup function for the current native file watcher |
| `pendingOpens` | `Set<string>` | Tracks file paths currently being opened to prevent duplicate open calls |

## Exported Functions

### `getCurrentView()`
**Returns:** The active view instance (`leftView` or `rightView`) based on `State.activePane`.

### `toggleWhitespace()`
**Purpose:** Toggles CR/LF/TAB whitespace markers across all open editor panes. Persists choice to localStorage. Updates the status bar indicator.

### `openDiffEditor(original, modified, filePath, onApply, onChange, onSave, diffOptions)`
**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `original` | `string` | Original text (left side of diff) |
| `modified` | `string` | Modified text (right side of diff) |
| `filePath` | `string` | Original file path |
| `onApply` | `function` | Callback when user clicks Apply & Save |
| `onChange` | `function` | Callback on each accept/reject hunk |
| `onSave` | `function` | Callback for Ctrl+S in diff view |
| `diffOptions` | `object` | Extra options (compareMode, labels, etc.) |

**Logic:**
- If a diff tab for this file already exists, updates it in place
- Otherwise creates a new virtual tab with type `'diff'`
- Uses `makeApply()` wrapper to mark file as clean and close the diff tab

### `openCompareEditor()`
**Purpose:** Opens an empty side-by-side text comparison tab (not tied to any disk file). Reuses existing compare tab if present.

### `openAgentTasksTab(taskId?)`
**Purpose:** Opens the AI Agent Tasks panel as a tab. If `taskId` is provided, focuses that specific task.

### `closeAllTabs(action = 'prompt')`
**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | `string \| boolean` | `'prompt'`, `'save'`/`true`, `'force'`/`false` |

**Returns:** `Promise<boolean>` — `true` if tabs were closed, `false` if user cancelled.

**Logic:**
- `'save'`: Saves all dirty files then closes
- `'prompt'`: Shows dialog if dirty files exist
- `'force'`: Discards all changes
- Frees Rust-side handles (large file mmap, rope editor)
- Resets all state and re-renders

### `renderEditor(targetPane?)`
**Purpose:** The core view-rendering function. Selects the correct view type for the active file in each pane.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `targetPane` | `'left' \| 'right' \| null` | Which pane to render (null = all active panes) |

**View Selection Logic (priority order):**
1. **Diff** (`file.type === 'diff'`) → `DiffEditor`
2. **Compare** (`file.type === 'compare'`) → `CompareView`
3. **Agent Tasks** (`file.type === 'agent'`) → `TaskNotificationPanel`
4. **Huge file edit mode** (`file.isEditing && file.editId`) → `LargeFileEditView`
5. **Large file read-only** (`file.isLarge` or content > 500MB) → `LargeFileView`
6. **Plugin-based views** (CSV, XML, JSON, HTML, Markdown) → resolved via `pluginManager`
7. **Default** → `CodeMirrorView`

### `renderTabs(targetPane?)`
**Purpose:** Renders the tab bar for one or both panes. Each tab shows filename, dirty indicator, and close button. Supports right-click context menu with: Copy Path, Compare, Move to Other Pane, Close All, Close Others.

### `setActiveTab(index, pane?)`
**Purpose:** Switches the active tab. Cleans up search state, re-renders tabs and editor, updates toolbar, sets up file watcher, scrolls tab into view.

### `closeTab(index, pane?)`
**Purpose:** Closes a single tab. Prompts for dirty files (except virtual diff/compare/agent tabs). Frees Rust-side handles. Adjusts active tab index.

### `closeFileByPath(path)`
**Purpose:** Finds and closes a tab by its file path.

### `closeFilesUnderDir(dirPath)`
**Purpose:** Closes all tabs whose path starts with the given directory. Iterates backwards for safe removal.

### `openFile(path, forceEncoding?)`
**Purpose:** Opens a file in a new or existing tab.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | File path to open |
| `forceEncoding` | `boolean \| string` | Force re-open with specific encoding |

**Logic:**
- Normalizes path (resolves UNC, relative paths)
- Deduplicates via `pendingOpens` Set
- For files > 500MB: opens via Rust mmap backend (`large_file_open`)
- Otherwise: reads via `FS.readFileAutoDetect`
- Handles tab deduplication and re-encoding

### `createNewFileAction()`
**Purpose:** Creates a new untitled tab (`Untitled.txt`, `Untitled-1.txt`, etc.) with empty content.

### `saveCurrentFile()`
**Purpose:** Saves the active file. Handles multiple cases:
- Virtual scratch tabs (compare) → no-op
- Diff tabs → delegates to `onSave` callback
- Rope-backed huge files → delegates to view's save method
- Read-only large files → shows error toast
- Untitled files → shows Save dialog
- Normal files → writes with EOL conversion, updates stats, refreshes explorer and git

### `formatCurrentFile()`
**Purpose:** Formats the active file using async formatter. Supports: JSON, XML, SQL, HTML, Java, JavaScript, TypeScript.

### `splitEditor()` / `closeSplit()`
**Purpose:** Enable/disable horizontal split-editor mode. When splitting, clones the active file to the right pane.

### `moveTabToOtherPane(index, sourcePane)`
**Purpose:** Moves a tab from one pane to the other. Enables split mode if not already active.

### `setupWatcher(file)`
**Purpose:** Sets up a native Tauri file watcher on the given file. On external modification, prompts the user to reload (with 1-second debounce to avoid self-triggering).

### `updateToolbar()`
**Purpose:** Updates the toolbar with the current file's directory and filename.

### `updateStatusBar()`
**Purpose:** Updates the status bar with: file type, file size, last modified date, encoding, line/column position, and selection length.

### `compareWithDisk(file)`
**Purpose:** Opens a diff editor comparing the in-memory content against the on-disk version. Uses the same encoding for disk read.

### `compareWithFile(file)`
**Purpose:** Opens a file dialog to select another file, then opens a diff editor comparing the two.

### `focusEditor(options?)`
**Purpose:** Focuses the current view's editor. With `{ toStart: true }`, moves cursor to position 0.

### `getSelectedText()` / `replaceSelectedText(text)`
**Purpose:** Delegates text selection/replacement to the current view.

### `triggerCopy()` / `triggerCut()` / `triggerPaste()`
**Purpose:** Clipboard operations that check multiple contexts: active input/textarea, browser selection, then fall back to view-specific methods.

### Markdown Block Methods
- `selectBlock(index)` — Selects a markdown block by index
- `activateBlock(index)` — Activates a markdown block for editing
- `saveBlock(index, newText)` — Saves edited block content

## Editor Shortcut Actions

### Global Scope
| Command | Action |
|---------|--------|
| `save` | Save current file |
| `app:tab-search` | Open tab search modal |
| `app:toggle-view-mode` | Toggle text ↔ structure view (with 5MB limit for structure) |
| `md-block:nav` | Navigate markdown blocks (ArrowUp/Down) |
| `md-block:edit` | Edit selected markdown block |

### Editor Scope
| Command | Action |
|---------|--------|
| `editor:next-tab` | Switch to next tab |
| `editor:prev-tab` | Switch to previous tab |
| `editor:go-to-definition` | LSP go-to-definition |
| `editor:find-references` | LSP find-references |
| `editor:split-right` | Split editor |
| `editor:close-split` | Close split pane |

## window.app Exposed Methods

| Method | Description |
|--------|-------------|
| `createNewTab(proposedPath, content)` | Create tab from AI panel or other external source |
| `openFile` | Reference to the exported `openFile` |
| `openDiffEditor` | Reference to the exported `openDiffEditor` |
| `openCompareEditor` | Reference to the exported `openCompareEditor` |
| `openAgentTasksTab` | Reference to the exported `openAgentTasksTab` |
| `openMarkdownResult(title, md)` | Open AI result as a Markdown tab |
| `getCurrentView` | Reference to the exported `getCurrentView` |
| `refreshExplorer` | Force-refreshes the file tree |
| `toggleViewMode` | Toggle view mode |
| `getDiagnostics` | Get diagnostics from current view |
| `reloadFileSilently(path, newContent)` | Reload file content without triggering the watcher |

## window.Editor Exposed Methods

`formatCurrentFile`, `renderEditor`, `renderTabs`, `openFile`, `saveCurrentFile`, `compareWithFile`, `compareWithDisk`

## Dependencies

| Module | Purpose |
|--------|---------|
| `Constants.js` | DOM element references (`EL`) |
| `Store.js` | Application state (`State`) |
| `FileSystem.js` | File read/write, stats, path utilities |
| `Explorer.js` | `loadExplorer` for tree refresh |
| `ContextMenu.js` | Right-click context menus |
| `CodeFormatter.js` / `AsyncFormatter.js` | Code formatting |
| `TabSearch.js` | Tab search modal |
| `ShortcutManager.js` | Shortcut registration |
| `ShortcutDefinitions.js` | Shortcut definitions |
| `PluginManager.js` | View plugin resolution |
| `ViewPlugins.js` | Default plugin initialization |
| `CodeMirrorView.js` | CodeMirror 6 editor view |
| `LargeFileEditView.js` | Rope-backed editing for huge files |
| `MarkdownView.js` | Markdown editor/preview view |
| `StructureView.js` | Structured (tree) view |
| `CsvView.js` | CSV table view |
| `DiffEditor.js` | Side-by-side diff editor |
| `CompareView.js` | Free-form text comparison |
| `TaskNotificationPanel.js` | AI task panel |
| `@tauri-apps/api/core` | Tauri invoke |
| `@tauri-apps/plugin-clipboard-manager` | System clipboard access |
| `@tauri-apps/plugin-dialog` | Native save/open dialogs |
| `@tauri-apps/plugin-fs` | File system watcher |
