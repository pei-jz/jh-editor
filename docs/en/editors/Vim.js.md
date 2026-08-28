# Vim.js — Vim-style Modal Editing for Markdown Blocks

## Purpose
`Vim.js` provides Vim-style Normal/Insert mode editing for the Markdown block editor.

## File Info
- **Path**: `src/modules/editors/Vim.js` (249 lines)
- **Dependencies**: `Store.js` (State), `Editor.js` (selectBlock, activateBlock), `Explorer.js` (focusExplorer), `Hints.js` (showHints)

## Exported Functions

### `updateVimStatus(): void`
Updates Vim mode display in the status bar.

**Branch Logic**:
| Condition | Action |
|-----------|--------|
| `settings_vimMode` is `true` and `vimState` exists | Shows status (green for Insert, primary color for Normal) |
| Vim disabled | Hidden |

### `initVimMode(): void`
Initializes Vim mode and sets up keydown event listener.

## Keyboard Operations

### Insert/Input Mode
| Key | Action |
|-----|--------|
| `Ctrl+Enter` | Click save button → transition to Normal |
| `Escape` | Click cancel button → transition to Normal |

### Normal Mode — In Explorer
| Key | Action |
|-----|--------|
| `j` / `ArrowDown` | Move focus down |
| `k` / `ArrowUp` | Move focus up |
| `Enter` | Click active element |
| `f` | Show Vimium hints |

### Normal Mode — In Editor
| Key | Action |
|-----|--------|
| `j` / `ArrowDown` | Move block selection down |
| `k` / `ArrowUp` | Move block selection up |
| `ArrowLeft/Right` | Caret movement |
| `Shift+Arrow` | Extend text selection |
| `Enter` | Activate block (start editing) |
| `f` | Show Vimium hints |
| `i` | Enter Insert mode, activate selected block |
| `o` | Enter Insert mode, select last block and activate |

## Internal Functions

### `moveSelection(delta: number): void`
Moves block selection by `delta`.

### `moveFocusInExplorer(delta: number): number`
Moves file item focus in explorer by `delta`. Clamps to valid range.

### `restoreFocus(): Promise<void>`
Restores focus to active block on window focus when in Normal mode.

## Event Listeners

| Event | Target | Description |
|-------|--------|-------------|
| `keydown` | `document` | Vim mode keyboard operations |
| `focus` | `window` | Focus restoration |
| `click` | `document` | Background click focus restoration |