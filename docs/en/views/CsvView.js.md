# CsvView.js — CSV File View

## Purpose
CSV file view delegating to CsvEditor.

## File Info
- **Path**: `src/modules/views/CsvView.js` (95 lines)
- **Dependencies**: `BaseView`, `CsvEditor`

## Class: `CsvView extends BaseView`

## Methods

| Method | Description |
|--------|-------------|
| `render(content, file)` | Delegates to CsvEditor.render() |
| `copy/cut/paste()` | Delegates to CsvEditor.activeInstance |
| `handleShortcut(command, e)` | Delegates to CsvEditor |
| `undo()/redo()` | Uses CsvEditor model history |
| `destroy()` | Destroys CsvEditor instance |