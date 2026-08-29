# CodeMirrorView.js — Main Code Editor (CodeMirror 6)

## Purpose
Primary code editor view using CodeMirror 6. Supports syntax highlighting for 12+ languages, LSP completion/hover/diagnostics, search/replace, Book Mode, and whitespace visualization.

## File Info
- **Path**: `src/modules/views/CodeMirrorView.js` (1177 lines)
- **Dependencies**: `@codemirror/*`, `page-flip`, `Store.js`, `SyntaxHighlighter.js`, `CMHighlighter.js`, `LspClient.js`, `InlineAI.js`, `Navigation.js`

## Class: `CodeMirrorView`

## Key Methods

| Method | Description |
|--------|-------------|
| `render(content, file)` | Render CM6 editor or Book Mode |
| `_renderEditor(content)` | Setup all CM6 extensions |
| `_renderBookMode(content)` | page-flip reader |
| `_getLanguageExtension(path)` | Extension→CM6 language mapping |
| `_lspCompletionSource(ctx)` | LSP completion source |
| `performSearch(query, ...)` | Search integration |
| `replaceNext/ReplaceAll(...)` | Replace operations |
| `getStatusInfo()` | Returns `{line, col, selectionLength}` |
| `jumpToLine(lineIndex)` | Jump to line |
| `destroy()` | Save CM6 state to `file._cmStateJSON` |

## Branch Logic

| Condition | Action |
|-----------|--------|
| `plainTextViewMode === 'book'` | Render in Book Mode (page-flip) |
| `plainTextViewMode === 'edit'` | Render normal CM6 editor |
| Ctrl+click | Go-to-definition via Navigation |
| Saved CM6 state exists | Restore state |