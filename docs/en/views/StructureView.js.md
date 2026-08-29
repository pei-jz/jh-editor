# StructureView.js — Structured Data Tree View

## Purpose
Displays XML/JSON/HTML data as a tree view with StructureEditor integration.

## File Info
- **Path**: `src/modules/views/StructureView.js` (38.6KB)
- **Dependencies**: `StructureEditor`, `HtmlParser`, `JsonParser`, `XmlParser`

## Key Features

| Feature | Description |
|---------|-------------|
| Tree display | Structured data tree rendering |
| File type detection | Auto-detect XML/JSON/HTML |
| Lazy loading | Delayed parsing for large data |
| Edit mode | Direct editing via StructureEditor |
| Serialize | Tree→XML/JSON/HTML conversion |

## Branch Logic

| Condition | Action |
|-----------|--------|
| `getStructureType()` = `'xml'` | Use XmlParser |
| `getStructureType()` = `'json'` | Use JsonParser |
| `getStructureType()` = `'html'` | Use HtmlParser |
| Parse error | Fallback to text mode |
| Large data | Enable lazy loading |