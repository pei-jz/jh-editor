# TabSearch.js — Tab Search/Switcher

## Purpose
Ctrl+T modal for searching and switching open tabs.

## File Info
- **Path**: `src/modules/ui/TabSearch.js` (95 lines)
- **Dependencies**: `Store.js`

## Key Features

| Feature | Description |
|---------|-------------|
| Tab listing | All open tabs |
| Real-time filter | Filter while typing |
| Select to switch | Enter to switch |

## Branch Logic

| Condition | Action |
|-----------|--------|
| No tabs | Empty list |
| 0 filter results | Show "No matches" |
| Escape | Close modal |