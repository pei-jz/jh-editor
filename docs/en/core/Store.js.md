# Store.js — Global Application State

## Purpose
`Store.js` defines the global mutable state (a single `State` object) for JHEditor. All modules import this `State` to share application-wide state.

## File Info
- **Path**: `src/modules/core/Store.js` (32 lines)
- **Dependencies**: None

## Export

### `State` Object

| Property | Type | Initial Value | Description |
|----------|------|---------------|-------------|
| `currentDir` | `string` | `'.'` | Current workspace root directory |
| `gitRoot` | `string` | `'.'` | Git repository root |
| `gitRepos` | `Array<{name, path}>` | `[]` | Multiple Git repos in workspace |
| `splitMode` | `boolean\|string` | `false` | Split pane mode (`false` or `'horizontal'`) |
| `activePane` | `string` | `'left'` | Active pane (`'left'` or `'right'`) |
| `openFiles` | `Array<{path, content, isDirty}>` | `[]` | Left pane open files |
| `activeTabIndex` | `number` | `-1` | Left pane active tab index |
| `rightOpenFiles` | `Array` | `[]` | Right pane open files |
| `rightActiveTabIndex` | `number` | `-1` | Right pane active tab index |
| `isExplorerVisible` | `boolean` | `true` | Explorer visibility |
| `isOutlineVisible` | `boolean` | `false` | Outline visibility |
| `searchMatches` | `Array` | `[]` | Search match results |
| `currentMatchIndex` | `number` | `-1` | Current match index |
| `vimState` | `object` | `{mode: 'normal', selectedIndex: -1}` | Vim mode state |
| `expandedFolders` | `Set` | `new Set()` | Expanded folders in explorer |
| `explorerSearchTerm` | `string` | `''` | Explorer search term |
| `explorerSearchContent` | `boolean` | `false` | Content search mode |
| `aiShowDetailedLogs` | `boolean` | From localStorage | AI detailed logs setting |
| `ragModelSize` | `string` | From localStorage | RAG model size |
| `markdownViewMode` | `string` | `'scroll'` | Markdown view mode (`'scroll'` or `'book'`) |
| `plainTextViewMode` | `string` | `'edit'` | Plain text view mode (`'edit'` or `'book'`) |
| `showWhitespace` | `boolean` | From localStorage | CR/LF/TAB marker display |

## Branch Logic

No branching logic. Static property definitions only.
- Initial values from localStorage are read at module load time.