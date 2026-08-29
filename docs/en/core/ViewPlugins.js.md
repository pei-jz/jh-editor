# ViewPlugins.js — Built-in View Plugin Registration

## Purpose
`ViewPlugins.js` registers all built-in view plugins into the `PluginManager`.

## File Info
- **Path**: `src/modules/core/ViewPlugins.js` (55 lines)
- **Dependencies**: `PluginManager.js`, `CodeMirrorView.js`, `MarkdownView.js`, `StructureView.js`, `CsvView.js`

## Exported Function

### `initDefaultPlugins(context: Object): void`
Registers default view plugins.

## Registered Plugins

| ID | View Class | Extensions | Mode | Priority |
|----|-----------|-----------|------|----------|
| `markdown` | `MarkdownView` | `md`, `markdown` | `structure` | 10 |
| `csv` | `CsvView` | `csv` | `structure` | 10 |
| `structure` | `StructureView` | `xml`, `json`, `html`, `xsd`, `wsdl`, `htm` | `structure` | 10 |
| `plain` | `CodeMirrorView` | `txt`, `log`, `java`, `js`, `javascript`, `ts`, `typescript`, `sql`, `css`, `json`, `xml`, `html`, `md`, `markdown`, `''` | `text` | 1 |

## Branch Logic

### `structure` Plugin's `getStructureType()`

| Condition | Return Value |
|-----------|-------------|
| `.xml`, `.xsd`, `.wsdl` | `'xml'` |
| `.html`, `.htm` | `'html'` |
| Otherwise | `'json'` |

### Resolution Priority

- `priority: 10` (structure, markdown, csv) > `priority: 1` (plain)
- Same priority: matched in registration order `markdown` → `csv` → `structure` → `plain`
- `plain` serves as lowest-priority fallback covering nearly all file extensions