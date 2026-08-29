# Constants.js — Centralized DOM Element References

## Purpose
`Constants.js` provides a centralized `EL` object that caches all DOM element references used throughout the application. Elements are looked up from the DOM at module load time.

## File Info
- **Path**: `src/modules/core/Constants.js` (99 lines)
- **Dependencies**: None

## Export

### `EL` Object

#### File Explorer
| Property | DOM ID | Description |
|----------|--------|-------------|
| `explorer` | `#explorer` | Main explorer panel |
| `explorerList` | `#file-list` | Virtual scrolling file list |

#### Editor (Left Pane)
| Property | DOM ID | Description |
|----------|--------|-------------|
| `editorContainer` | `#editor-container` | Left editor pane wrapper |
| `editorContent` | `#editor-content` | Left editor content area |
| `tabsContainer` | `#tabs-container` | Left tab bar |
| `newTabBtn` | `#new-tab-btn` | New tab button |
| `currentFileLabel` | `#current-file` | Current file name display |
| `fileDirectoryLabel` | `#file-directory` | Current file directory display |

#### Editor (Right Pane)
| Property | DOM ID | Description |
|----------|--------|-------------|
| `editorContainerRight` | `#editor-container-right` | Right pane wrapper |
| `editorContentRight` | `#editor-content-right` | Right content area |
| `tabsContainerRight` | `#tabs-container-right` | Right tab bar |
| `newTabBtnRight` | `#new-tab-btn-right` | Right new tab button |
| `editorSplitResizer` | `#editor-split-resizer` | Split resizer bar |

#### Resizers
| Property | DOM ID | Description |
|----------|--------|-------------|
| `resizerLeft` | `#resizer-left` | Left resizer |
| `resizerRight` | `#resizer-right` | Right resizer |

#### Status Bar
| Property | DOM ID | Description |
|----------|--------|-------------|
| `statusSizeType` | `#status-file-type` | File type |
| `statusSize` | `#status-size` | File size |
| `statusLastModified` | `#status-last-modified` | Last modified time |
| `statusEncoding` | `#status-encoding` | Encoding |
| `statusSelection` | `#status-selection` | Cursor/selection info |

#### Search Panel
| Property | DOM ID | Description |
|----------|--------|-------------|
| `searchPanel` | `#search-panel` | Search panel container |
| `findInput` | `#find-input` | Find text input |
| `replaceInput` | `#replace-input` | Replace text input |
| `regexToggle` | `#regex-toggle` | Regex toggle |
| `caseToggle` | `#case-toggle` | Case toggle |
| `findPrevBtn` | `#find-prev-btn` | Previous button |
| `findNextBtn` | `#find-next-btn` | Next button |
| `replaceBtn` | `#replace-btn` | Replace button |
| `replaceAllBtn` | `#replace-all-btn` | Replace all button |
| `closeSearchBtn` | `#close-search-btn` | Close button |
| `searchStatusBar` | `#search-status-bar` | Search status bar |

#### Buttons
| Property | DOM ID | Description |
|----------|--------|-------------|
| `toggleExplorerBtn` | `#toggle-explorer-btn` | Explorer toggle button |
| `openFolderBtn` | `#open-folder-btn` | Open folder button |

#### Modals
- `EL.inputModal`: Input modal with `overlay`, `title`, `message`, `input`, `okBtn`, `cancelBtn`
- `EL.previewModal`: Preview modal with `overlay`, `content`, `closeBtn`

#### Terminal
`EL.terminal`: `toggleBtn`, `panel`, `header`, `container`, `closeBtn`, `clearBtn`, `resizer`

#### Settings
`EL.settingsBtn` and `EL.settingsModal`: `overlay`, `closeBtn`, `themeSelector`, `tabs`, `panes`

#### Shortcuts
`EL.shortcutGuide`: `container`, `list`