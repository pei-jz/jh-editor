# ShortcutGuide.js — Keyboard Shortcut Reference

## Purpose
Displays a searchable reference panel for all keyboard shortcuts.

## File Info
- **Path**: `src/modules/ui/ShortcutGuide.js` (163 lines)
- **Dependencies**: `ShortcutManager`, `ShortcutDefinitions`

## Key Features

| Feature | Description |
|---------|-------------|
| Shortcut listing | Grouped by scope |
| Search filter | Keyword filtering |
| Toggle | F1 or Ctrl+? |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Filter text present | Show only matching |
| No filter | Show all shortcuts |
| User customization applied | Show changed marker |