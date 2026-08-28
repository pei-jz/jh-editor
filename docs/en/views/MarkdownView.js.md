# MarkdownView.js — Markdown Live Preview View

## Purpose
Live preview view for Markdown files using marked.js and mermaid.js.

## File Info
- **Path**: `src/modules/views/MarkdownView.js` (51.4KB)

## Key Features

| Feature | Description |
|---------|-------------|
| Live preview | Markdown→HTML rendering |
| Book mode | Page flipper display |
| Table editing | TableEditor integration |
| Vim navigation | Block-level navigation |

## Branch Logic

| Condition | Action |
|-----------|--------|
| `markdownViewMode === 'scroll'` | Scroll preview mode |
| `markdownViewMode === 'book'` | Book mode (page-flip) |
| Table block detected | Delegate to TableEditor |
| Tree block detected | Delegate to StructureEditor |
| Mermaid code block | Render with mermaid.js |