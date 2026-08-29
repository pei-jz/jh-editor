# CsvEditor.js — Virtualized CSV/Spreadsheet Editor

## Purpose
`CsvEditor.js` is an MVC-architecture CSV/spreadsheet editor with VirtualScroll virtualization, Excel-like keyboard navigation, and row/column operations.

## File Info
- **Path**: `src/modules/editors/CsvEditor.js` (1957 lines)
- **Dependencies**: `VirtualScroll`, `ShortcutManager`, `ShortcutDefinitions`, `ContextMenu`, `AsyncCsvParser`, `@tauri-apps/plugin-clipboard-manager`

## Classes

### `CsvModel`
Data management model for CSV content.

| Method | Description |
|--------|-------------|
| `constructor(content, existingLineEnding)` | Parses content, detects line endings |
| `parse(content, detectLineEnding)` | Parses CSV string to 2D array |
| `serialize()` | Serializes 2D array to CSV string |
| `getValue(r, c)` / `setValue(r, c, val)` | Cell value get/set |
| `insertRow(index)` / `insertCol(index)` | Row/column insertion |
| `insertRows(index, matrix)` / `insertCols(index, matrix)` | Multi-row/column paste |
| `deleteRow(index)` / `deleteCol(index)` | Row/column deletion |
| `transpose()` | Transpose rows/columns |
| `sort(colIndex, ascending)` | Column sort |
| `undo()` / `redo()` | Undo/redo (50-step history) |

### `CsvController` (internal)
User input and operation controller.

| Method | Description |
|--------|-------------|
| `handleCellDown/Over/DblClick()` | Mouse operations |
| `startEditing()` / `finishEditing()` | Cell editing |
| `moveSelection(dr, dc)` | Selection movement |
| `copy/cut/paste()` | Clipboard operations |
| `handleShortcut()` | Shortcut handling |
| `startJump()` / `executeJump()` | Vim-style jump |

### `CsvView` (internal)
Virtual scrolling view layer with column width auto-calculation.

### `CsvEditor` (singleton)
Global CSV editor instance with `render(content, file)` and `activeInstance`.

## Keyboard Operations

| Key | Action |
|-----|--------|
| Arrows | Cell navigation |
| `Shift+Arrows` | Range selection |
| `Ctrl+Arrows` | Jump |
| `F2` / `Enter` | Start cell editing |
| `Tab` / `Shift+Tab` | Next/prev cell |
| `Alt+;` / `Alt+-` | Add/delete row |
| `Alt+Shift+;` / `Alt+Shift+-` | Add/delete column |
| `j` | Start jump mode |