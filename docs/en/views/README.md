# Views Module — Documentation Index

File display and editing view components.

| File | Description |
|------|-------------|
| [BaseView.js.md](./BaseView.js.md) | Abstract base class (view interface definition) |
| [CodeMirrorView.js.md](./CodeMirrorView.js.md) | Main code editor using CodeMirror 6 |
| [CsvView.js.md](./CsvView.js.md) | CSV file view (delegates to CsvEditor) |
| [LargeFileEditView.js.md](./LargeFileEditView.js.md) | Large file editing view (rope + sliding window) |
| [LargeFileView.js.md](./LargeFileView.js.md) | Large file read-only viewer, search, and statistics |
| [MarkdownView.js.md](./MarkdownView.js.md) | Markdown live preview view |
| [StructureView.js.md](./StructureView.js.md) | Structured data tree view |

## View Hierarchy

```
BaseView (abstract base class)
  ├─ CodeMirrorView (CodeMirror 6 editor)
  ├─ CsvView (→ delegates to CsvEditor)
  ├─ MarkdownView (live preview)
  ├─ StructureView (tree display)
  └─ (independent)
      ├─ LargeFileView (read-only large files)
      └─ LargeFileEditView (editable large files)
```