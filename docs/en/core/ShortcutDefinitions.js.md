# ShortcutDefinitions.js — Keyboard Shortcut Definitions

## Purpose
`ShortcutDefinitions.js` is the single source of truth for all keyboard shortcuts in JHEditor. Actual function mapping is handled by respective modules or a central dispatcher.

## File Info
- **Path**: `src/modules/core/ShortcutDefinitions.js` (182 lines)
- **Dependencies**: None

## Export

### `SHORTCUTS` Object

Contains shortcut arrays per scope.

## Shortcut Scopes

### GLOBAL
| Key | Modifiers | Command | Description |
|-----|-----------|---------|-------------|
| `s` | Ctrl | `app:save` | Save |
| `f` | Ctrl | `app:search` | Search |
| `f` | Shift+Alt | `app:format` | Format |
| `o` | Ctrl | `app:outline-modal` | Outline Navigation |
| `p` | Ctrl | `app:file-search` | File Search |
| `r` | Ctrl+Shift | `app:file-search` | File Search |
| `n` | Ctrl | `app:new-file` | New File |
| `w` | Ctrl | `app:close-tab` | Close Tab |
| `F3` | — | `app:find-next` | Find Next |
| `k` | Ctrl | `app:find-next` | Find Next |
| `F3` | Shift | `app:find-prev` | Find Previous |
| `k` | Ctrl+Shift | `app:find-prev` | Find Previous |
| `Enter` | Alt | `app:replace-next` | Replace & Find Next |
| `F5` | — | `app:refresh-explorer` | Refresh Explorer |
| `F1` | — | `app:shortcut-guide` | Shortcut Guide |
| `?` | Ctrl | `app:shortcut-guide` | Shortcut Guide |
| `/` | Ctrl | `app:shortcut-guide` | Shortcut Guide |
| `t` | Ctrl | `app:tab-search` | Tab Search |
| `e` | Ctrl+Shift | `app:toggle-view-mode` | Toggle View Mode |
| `c` | Ctrl | `app:copy` | Copy |
| `x` | Ctrl | `app:cut` | Cut |
| `v` | Ctrl | `app:paste` | Paste |
| `z` | Ctrl | `app:undo` | Undo |
| `y` | Ctrl | `app:redo` | Redo |
| `z` | Ctrl+Shift | `app:redo` | Redo |
| `1` | Ctrl | `app:focus-explorer` | Focus Explorer |
| `2` | Ctrl | `app:focus-editor` | Focus Editor |
| `Space` | Ctrl | `app:inline-ai` | Inline AI Edit |
| `d` | Ctrl+Shift | `app:diff` | Compare with File |
| `d` | Ctrl+Alt | `app:open-compare` | Compare Text |
| `w` | Ctrl+Alt | `app:toggle-whitespace` | Toggle Whitespace |

### EXPLORER
Arrow keys for navigation, Enter to open, Delete to remove, F2 to rename, Ctrl+N for new file.

### EDITOR
Ctrl+Tab for next/prev tab, F12 for go-to-definition, Ctrl+\\ for split.

### CSV / CSV_EDIT
CSV navigation, cell editing, row/column operations.

### SEARCH
Search panel specific shortcuts (Alt+E: regex, Alt+C: case, etc.).

### MARKDOWN / MARKDOWN_TABLE / MARKDOWN_BLOCK
Markdown-specific shortcuts (Bold, Italic, Link, lists, etc.).

### AI_REVIEW
AI diff review shortcuts (Alt+A: accept, Alt+R: reject, etc.).

### STRUCTURE_EDIT
Structure editor shortcuts (Ctrl+S: save).
