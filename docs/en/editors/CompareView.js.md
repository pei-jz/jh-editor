# CompareView.js — Text Comparison Workspace

## Purpose
`CompareView` is a file-independent diff comparison workspace. Users paste text into two full-height panes and compare them. Results are displayed full-screen via DiffEditor.

## File Info
- **Path**: `src/modules/editors/CompareView.js` (162 lines)
- **Dependencies**: `DiffEditor`

## Class: `CompareView`

### Constructor
```javascript
constructor(container: HTMLElement, options?: Object)
```

### Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `render` | `content, file` | `void` | Initial render. If file has `compareLeft`/`compareRight`, shows result mode |
| `renderEditMode` | — | `void` | Renders two full-height textareas + toolbar |
| `renderResultMode` | — | `void` | Switches to full-screen diff via DiffEditor |
| `runCompare` | — | `void` | Executes comparison (skips if both empty) |
| `applyChanges` | — | `void` | No-op (compare tabs hold no disk content) |
| `destroy` | — | `void` | Destroys DiffEditor, removes CSS classes |

## Branch Logic

| Condition | Action |
|-----------|--------|
| `file.compareLeft`/`compareRight` exist | Renders in result mode (comparison already done) |
| Both texts empty | Button press only focuses (no mode transition) |
| `renderEditMode` called | Destroys existing DiffEditor before re-rendering |