# ShortcutManager.js — Shortcut Management and Scope Detection

## Purpose
`ShortcutManager.js` handles keyboard shortcut loading, scope detection, and keydown event processing. Supports user custom shortcut overrides.

## File Info
- **Path**: `src/modules/core/ShortcutManager.js` (207 lines)
- **Dependencies**: `Store.js` (State), `ShortcutDefinitions.js` (SHORTCUTS)

## Class: `ShortcutManager`

### Constructor
- `this.shortcuts: Array` — Merged shortcut list
- `this.currentScope: string` — Current scope (default `'GLOBAL'`)
- `this.scopes: string[]` — Available scope list

### Methods

#### `loadShortcuts(): void`
Loads shortcuts, merging defaults with localStorage user overrides.
- **Branch**: If `overrides[s.id]` exists, applies that override

#### `updateShortcut(id: string, newMapping: Object): void`
Updates and persists a specific shortcut mapping.
- Saves to localStorage
- Dispatches `shortcutsChanged` custom event

#### `resetToDefaults(): void`
Restores all shortcuts to defaults.
- Removes `user_shortcuts` from localStorage

#### `register(shortcut: Object): void`
Registers a shortcut at runtime.
- **Branch**: If same `cmd`+`scope` exists, updates `action`; otherwise adds new

#### `unregisterScope(scope: string): void`
Removes all shortcuts for the specified scope.

#### `setScope(scope: string): void`
Sets active scope.
- **Branch**: Only sets if scope is in valid scopes list

#### `setupListeners(): void`
Sets up keydown event listener and auto scope detection.

### Auto Scope Detection (focusin/mousedown)

| Target Element | Scope |
|---------------|-------|
| Inside `.visual-table-editor` | `MARKDOWN_TABLE` |
| Inside `#explorer-list-container` | `EXPLORER` |
| Inside `.csv-grid-virtual-container` (INPUT/TEXTAREA) | `CSV_EDIT` |
| Inside `.csv-grid-virtual-container` (other) | `CSV` |
| Inside `.md-block` (TEXTAREA/contentEditable) | `EDITOR` |
| Inside `.md-block` (other) | `MARKDOWN_BLOCK` |
| Inside `.plain-text-editor`/`.block-editor` | `EDITOR` (conditional) |
| Inside `#search-panel` | `SEARCH` |
| Inside `.ai-review-overlay` | `AI_REVIEW` |
| Inside `.node-source-editor`/`.structure-editor` | `STRUCTURE_EDIT` |
| Otherwise | `GLOBAL` (skip if transitioning from `AI_REVIEW`) |

#### `handleKeyDown(e: KeyboardEvent): void`
Processes keydown events.

**Branch Logic**:
1. Skip if `window._isRecordingShortcut` is `true` (settings recording mode)
2. In `SEARCH` scope: skip all except Ctrl+F/Ctrl+H
3. Find matching shortcuts by key, modifiers, and scope
4. Priority: current scope > GLOBAL
5. **Special handling**:
   - Clipboard ops (copy/paste/cut): delegated to browser in regular INPUT/TEXTAREA
   - `MARKDOWN_TABLE` scope: clipboard ops skipped
   - `app:toggle-view-mode`: skipped on key repeat
6. If `action` is function, executes directly; if `cmd` exists, dispatches `shortcutTriggered` event

## Export
- `shortcuts` — Singleton instance
