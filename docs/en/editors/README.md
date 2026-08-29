# Editors Module — Documentation Index

Specialized editor components for specific file formats.

| File | Description |
|------|-------------|
| [CompareView.js.md](./CompareView.js.md) | File-independent text comparison workspace |
| [CsvEditor.js.md](./CsvEditor.js.md) | Virtualized CSV/spreadsheet editor (MVC architecture) |
| [DiffEditor.js.md](./DiffEditor.js.md) | Split/inline diff viewer with accept/reject per hunk |
| [StructureEditor.js.md](./StructureEditor.js.md) | Generic tree editor for XML/JSON |
| [TableEditor.js.md](./TableEditor.js.md) | Markdown table visual editor |
| [Vim.js.md](./Vim.js.md) | Vim-style modal editing for markdown blocks |

## Module Dependencies

```
CompareView → DiffEditor
DiffEditor → ShikiHighlighter, diff (npm)
CsvEditor → VirtualScroll, ShortcutManager, ContextMenu, AsyncCsvParser
StructureEditor → clipboard (Tauri)
TableEditor → (none)
Vim → Store, Editor, Explorer, Hints
```