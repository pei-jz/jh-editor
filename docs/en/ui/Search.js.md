# Search.js — Find & Replace System

## Purpose
In-file find & replace with regex, case sensitivity, word match, and regex templates.

## File Info
- **Path**: `src/modules/ui/Search.js` (921 lines)

## Key Features

| Feature | Description |
|---------|-------------|
| Search panel | Ctrl+F to open |
| Replace mode | Alt+P toggle |
| Regex | Alt+E toggle |
| Case sensitive | Alt+C toggle |
| Word match | Alt+W toggle |
| Replace all | Alt+A |
| Replace & next | Alt+Enter |

## Branch Logic

| Condition | Action |
|-----------|--------|
| 0 results | Show "Not found" |
| CSV grid mode | Switch to cell-level search |
| No file open | Disable search |