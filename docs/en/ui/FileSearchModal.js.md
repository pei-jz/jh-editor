# FileSearchModal.js — Global File Search

## Purpose
Global file search modal with glob pattern support.

## File Info
- **Path**: `src/modules/ui/FileSearchModal.js` (365 lines)
- **Dependencies**: `@tauri-apps/api/core` (invoke), `Store.js`

## Key Features

| Feature | Description |
|---------|-------------|
| File name search | Glob pattern support |
| File content search | Text grep |
| Real-time results | Update while typing |
| Open file | Open selected file |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Empty pattern | Show empty list |
| No workspace set | Prompt folder dialog |
| Results exceed limit | Truncate at max |