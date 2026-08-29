# OutlineModal.js — Document Outline Navigation

## Purpose
Displays document heading structure as a navigable outline.

## File Info
- **Path**: `src/modules/ui/OutlineModal.js` (248 lines)
- **Dependencies**: `marked.js`

## Key Features

| Feature | Description |
|---------|-------------|
| Heading extraction | Extract H1-H6 from Markdown |
| Hierarchical display | Nested heading structure |
| Click navigation | Jump to heading line |
| Ctrl+O toggle | Shortcut support |

## Branch Logic

| Condition | Action |
|-----------|--------|
| No headings | Show "No headings found" |
| No file open | Disable |
| Ctrl+Enter | Jump to selected heading |