# ContextMenu.js — Right-click Context Menu

## Purpose
Right-click context menu with submenus support. Singleton object.

## File Info
- **Path**: `src/modules/ui/ContextMenu.js` (135 lines)

## Key Features

| Feature | Description |
|---------|-------------|
| `show(items, x, y)` | Show menu |
| `hide()` | Hide menu |
| Submenus | Nested submenu display |
| Disabled items | Grayed-out display |

## Branch Logic

| Condition | Action |
|-----------|--------|
| `disabled: true` | Gray out, block click |
| Has `children` | Show submenu arrow |
| Menu overflows viewport | Reposition |