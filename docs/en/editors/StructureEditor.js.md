# StructureEditor.js — Generic Tree Editor

## Purpose
Generic tree-based editor for structured data (XML, JSON) with virtualized rendering and undo/redo.

## File Info
- **Path**: `src/modules/editors/StructureEditor.js` (699 lines)
- **Dependencies**: `@tauri-apps/plugin-clipboard-manager`

## Constructor
```javascript
constructor(container, model, onUpdate, onSelectionChange, options)
```

## Node Structure
```javascript
{ id, key, value, type, children, lazy }
```

## Key Methods

| Method | Description |
|--------|-------------|
| `mount()` | DOM construction, event binding |
| `render()` | Tree re-rendering |
| `undo()/redo()` | Undo/redo (50-step history) |
| `select(nodeId)` | Node selection |
| `startEditing(nodeId, field)` | Start editing |
| `toggleExpand(nodeId)` | Expand/collapse |
| `navigateSelection(delta)` | Selection movement |
| `copy()` | Clipboard copy |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Node has no `children` | Hide collapse button |
| `lazy: true` | Lazy load on expand |
| Editing field = `'key'` | Show key edit field |
| Editing field = `'value'` | Show value edit field |

## Event Handlers

| Event | Action |
|-------|--------|
| `click` | Node selection, expand toggle |
| `dblclick` | Start editing |
| `keydown` | Arrow nav, Enter/F2 to edit, Escape to cancel |
