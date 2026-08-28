# Explorer.js Documentation

## File Purpose

`Explorer.js` is the **file tree explorer module** for JHEditor. At ~1290 lines it implements a high-performance virtualized file tree using `VirtualScroll`. It handles:
- Rendering a file/directory tree with lazy loading and caching
- File and directory operations (new, rename, delete, copy, cut, paste)
- Keyboard navigation (Arrow keys, Enter, Delete, F2, Ctrl+N/C/X/V)
- Drag-and-drop file moving between directories
- File search with content search option (with progress reporting)
- Git status indicators on files and folders
- Context menus for file operations
- Explorer-scoped keyboard shortcuts

## Module-Level State

| Variable | Type | Description |
|----------|------|-------------|
| `openFileCallback` | `function \| null` | Callback to open a file in the editor |
| `closeFileCallback` | `function \| null` | Callback to close a file tab by path |
| `closeFilesUnderDirCallback` | `function \| null` | Callback to close all tabs under a directory |
| `clipboardAction` | `object \| null` | Current clipboard state `{ type: 'copy'\|'cut', paths: string[] }` |
| `vExplorer` | `VirtualExplorer \| null` | The singleton VirtualExplorer instance |
| `lastSearchTerm` | `string` | Last search term for caching |
| `lastSearchContentFlag` | `boolean` | Last content search flag for caching |
| `cachedMatches` | `array \| null` | Cached search results |

## Classes

### `VirtualExplorer`

A high-performance virtualized tree viewer that only renders visible rows.

**Constructor:** `new VirtualExplorer(container)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `container` | `HTMLElement` | The DOM container for the file tree |

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `flatItems` | `Array` | Flattened list of visible tree items |
| `dirCache` | `Map<string, Array>` | Cache of directory entries keyed by path |
| `selectedPaths` | `Set<string>` | Currently selected file/folder paths |
| `focusedIndex` | `number` | Index of the keyboard-focused item |
| `lastClickedIndex` | `number` | Index of the last mouse-clicked item (for Shift+click range) |
| `rowHeight` | `number` | Fixed row height in pixels (26px) |
| `gitStatus` | `object` | Git status sets: `{ staged, modified, untracked, folderStaged, folderModified, folderUntracked }` |
| `scroller` | `VirtualScroll` | Virtual scroll instance |
| `contentHost` | `HTMLElement` | Height spacer for virtual scrolling |

**Key Methods:**

#### `handleKeyDown(e)`
Handles keyboard navigation within the explorer:
| Key | Action |
|-----|--------|
| `ArrowDown` | Move focus down |
| `ArrowUp` | Move focus up |
| `ArrowRight` | Expand directory or move to first child |
| `ArrowLeft` | Collapse directory or move to parent |
| `Enter` | Toggle directory / open file |
| `Delete` | Delete selected item(s) |
| `Ctrl+C` | Copy |
| `Ctrl+X` | Cut |
| `Ctrl+V` | Paste into target directory |
| `Ctrl+N` | New file in focused directory |
| `Tab` / `Shift+Tab` | Move focus to editor |

#### `setFocus(index)`
Sets keyboard focus to a specific item. Ensures the item is scrolled into view.

#### `setRoot(rootPath)`
Sets the root directory and refreshes the tree.

#### `destroy()`
Tears down listeners and empties the container. Called whenever `initExplorer()` re-initialises, preventing the old instance's `VirtualScroll` from keeping the same container under observation (which caused the tree to appear duplicated).

#### `setData(flatItems)`
Replaces the entire flat item list and resets focus. Used by search mode.

#### `refresh()`
Rebuilds the flat item list from root path and expanded state. Preserves focus across refresh.

**Generation guard:** `refresh()` is async (it awaits directory reads), so rapid expand/collapse, git status updates or multi-select clicks used to interleave their `buildFlatList` pushes into the same `flatItems` array, doubling rows. A `_refreshGen` counter now invalidates stale builds — a build superseded by a newer refresh aborts immediately.

#### `buildFlatList(dirPath, level, gen)`
Recursively builds the flattened tree by reading directories and expanding only folders in `State.expandedFolders`. Aborts (returns `false`) when `gen` no longer matches the current generation, preventing duplicate pushes.

#### `sortEntries(entries)`
Sorts directory entries: directories first, then alphabetically (case-insensitive).

#### `render({ startIndex, endIndex, offsetY, totalHeight })`
Renders visible rows only. Called by VirtualScroll on scroll events. **The contentHost is attached exactly once in the constructor and is never re-appended here** — this stops a superseded instance's VirtualScroll from re-attaching a dangling host and doubling the tree.

#### `toggle(item)`
Expands or collapses a directory. Updates `State.expandedFolders` and refreshes the tree.

#### `startRenaming(div, item, labelSpan)`
Inline rename: replaces the label with an input field. On Enter/blur: commits rename via `FS.rename()`. On Escape: cancels.

#### `attachEvents(div, item)`
Attaches drag, context menu, and drop event handlers to a tree row.

#### `showMessage(text)` / `showProgress(scanned, total, found, path, percent)` / `clearMessage()`
Display status messages and progress bars in the explorer panel.

#### `createRow(item, index)`
Creates a single DOM row for a tree item with:
- Arrow toggle for directories
- File/folder icons
- Git status CSS classes (staged, modified, untracked)
- Selection and focus styling
- Click handlers (single, Ctrl+, Shift+)
- Drag-and-drop setup

## Exported Functions

### `initExplorer(openCallback, cbObj)`
**Purpose:** Initializes the explorer module.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `openCallback` | `function` | Callback to open files in the editor |
| `cbObj` | `object` | `{ closeFileByPath, closeFilesUnderDir }` callbacks |

**Logic:**
1. Stores callbacks
2. Creates `VirtualExplorer` instance on `#file-list` container (**destroying any existing instance first**)
3. Registers EXPLORER-scoped shortcuts
4. Sets up search input with 800ms debounce
5. Sets up empty-area context menu

### `loadExplorer(forceRefresh?)`
**Purpose:** Reloads the explorer tree.

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `forceRefresh` | `boolean` | If true, clears the directory cache |

**Logic:**
- If search term is active, renders filtered tree
- Otherwise, clears messages and calls `vExplorer.setRoot()`

### `focusExplorer()`
**Purpose:** Moves keyboard focus to the explorer list container.

### `showExplorerStatus(scanned, total, found, path, percent)`
**Purpose:** Delegates to `vExplorer.showProgress()` to display scan progress.

### `clearExplorerStatus()`
**Purpose:** Delegates to `vExplorer.clearMessage()` to hide status messages.

## Internal Functions

### `renderFilteredTree(rootDir, term, searchContent?)`
**Purpose:** Searches for files matching `term` and renders a filtered tree.

**Logic:**
1. Checks search cache for identical query
2. Shows progress via `FS.onSearchProgress` Tauri event
3. Calls `FS.searchFiles()` for the actual search
4. Builds a tree structure from flat search results
5. Auto-expands all directories containing matches
6. Updates the VirtualExplorer with filtered flat items

### `registerExplorerShortcuts()`
Registers EXPLORER-scoped shortcuts:
| Command | Action |
|---------|--------|
| `explorer:nav` | Delegates to `vExplorer.handleKeyDown()` |
| `explorer:rename` | Starts inline rename on focused item |
| `explorer:new-file` | Creates new file in focused directory |

### File Operation Handlers

| Function | Description |
|----------|-------------|
| `handleNewFile(dir)` | Shows new file modal, creates empty file, refreshes tree |
| `handleNewFolder(dir)` | Shows input dialog, creates directory |
| `handleRename(path)` | Shows input dialog, renames file/folder |
| `handleDelete(pathOrPaths)` | Confirms and deletes file(s), closes associated tabs |
| `handleCopy(paths)` | Stores copy action in clipboard |
| `handleCut(paths)` | Stores cut action in clipboard |
| `handlePaste(targetDir)` | Pastes from clipboard (copy or cut) or from system clipboard |
| `handleDropEvent(e, targetDir)` | Handles drag-and-drop file moves with self-drop prevention |

## Event Handlers

| Event | Location | Description |
|-------|----------|-------------|
| `git-status-updated` | VirtualExplorer constructor | Updates git status sets and triggers re-render |
| `keydown` on container | VirtualExplorer | Keyboard navigation |
| `focus` / `blur` on container | VirtualExplorer | Updates explorer header active state |
| `input` on search input | initExplorer | Debounced search (800ms) |
| `keydown` on search input | initExplorer | ArrowDown moves focus to tree |
| `contextmenu` on explorer | initExplorer | Empty-area context menu |
| `dragstart` on tree items | attachEvents | Sets up multi-item drag |
| `dragover` on tree items | attachEvents | Drop target validation |
| `dragleave` on tree items | attachEvents | Removes drop highlight |
| `drop` on tree items | attachEvents | Executes file move |
| `contextmenu` on tree items | attachEvents | Item context menu with file operations |
| `click` on tree items | createRow | Selection, expansion, and file open |
| `keydown` on tree items | createRow | F2 for rename, Ctrl+N for new file |

## Dependencies

| Module | Purpose |
|--------|---------|
| `Constants.js` | DOM element references (`EL`) |
| `Store.js` | Application state (`State`) |
| `FileSystem.js` | File operations, path utilities, search |
| `VirtualScroll.js` | Virtual scrolling engine |
| `ContextMenu.js` | Right-click context menus |
| `Modal.js` | Custom input/confirm/new-file modals |
| `ShortcutManager.js` | Shortcut registration |
| `ShortcutDefinitions.js` | Shortcut definitions |
| `@tauri-apps/plugin-dialog` | Native save dialog |
