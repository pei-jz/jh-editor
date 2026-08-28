# SettingsModal.js — Settings Dialog

## Purpose
Application settings dialog managing theme, font, view mode, keybindings, and AI config.

## File Info
- **Path**: `src/modules/ui/SettingsModal.js` (578 lines)

## Key Functions

| Function | Description |
|----------|-------------|
| `initSettingsModal()` | Initialize settings modal |
| `applyTheme(theme)` | Apply theme |
| `show()` / `hide()` | Modal visibility |

## Settings Tabs

| Tab | Settings |
|-----|----------|
| General | Theme, view mode, font, font size |
| Agent | AI connection config |
| Keybindings | Shortcut customization |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Theme change | Update CSS custom properties |
| Font size change | Auto-calculate line height |
| Keybind recording | Coordinate with ShortcutManager via `_isRecordingShortcut` flag |
| Save button | Save all settings to localStorage |