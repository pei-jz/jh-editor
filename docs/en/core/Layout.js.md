# Layout.js — Layout Initialization and Settings Management

## Purpose
`Layout.js` initializes the application layout, manages resizer operations, theme application, and font size management.

## File Info
- **Path**: `src/modules/core/Layout.js` (116 lines)
- **Dependencies**: `Constants.js` (EL), `Store.js` (State), `SettingsModal.js` (applyTheme)

## Exported Functions

### `setCompactMode(isCompact: boolean): void`
Toggles compact display mode.
- **Branch**: If `isCompact` is `true`, adds `display-mode-compact` class; if `false`, removes it
- Saves setting to localStorage

### `initLayout(): void`
Initializes the layout.
1. Restores theme/font/compact settings via `loadSettings()`
2. Sets up explorer toggle button event listener
3. Initializes resizers via `setupResizers()`
4. Sets up Ctrl+mouse wheel zoom (font size change)

### `saveFontSize(size: string): void`
Saves font size and updates CSS custom properties.
- Calculates line-height from font size: `Math.round(sizePt * 1.33333 * 1.5)`
- Dispatches `fontSettingsChanged` custom event

## Internal Functions

### `setupResizers(): void`
Sets up left pane resizer drag operation.
- **mousedown**: Begin resizing, change cursor
- **mousemove**: Adjust width between 150px–600px range
- **mouseup**: End resizing

### `loadSettings(): void`
Reads settings from localStorage and applies to DOM.
1. Theme application (`applyTheme()`)
2. Compact mode application
3. Font size application (invalid value check: out-of-range → default `10.5`pt)
4. Line-height calculation and setting

### `saveSettings(): void`
Saves compact mode state to localStorage.

## Branch Logic

| Condition | Action |
|-----------|--------|
| `isCompact === true` | Add `display-mode-compact` class |
| `isCompact === false` | Remove `display-mode-compact` class |
| Font size invalid (NaN, >18, <8) | Reset to default `10.5`pt |
| `e.deltaY < 0` (wheel up) | Font size +0.5pt (max 30pt) |
| `e.deltaY > 0` (wheel down) | Font size -0.5pt (min 8pt) |
| Resizer width < 150px | Adjustment disabled |
| Resizer width > 600px | Adjustment disabled |