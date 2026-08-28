# LargeFileView.js — Large File Read-only Viewer

## Purpose
Read-only viewer for 100MB+ text files with search, statistics, and virtualized line rendering.

## File Info
- **Path**: `src/modules/views/LargeFileView.js` (559 lines)
- **Dependencies**: `@tauri-apps/api/core` (invoke)

## Key Features

| Feature | Description |
|---------|-------------|
| Memory mode | Whole file as JS string |
| Backend mode | Rust mmap, lines fetched on demand |
| Virtualized rendering | Off-screen lines hidden |
| Search | Backend search |
| Statistics | Line/char/byte count |
| Edit mode switch | Transition to LargeFileEditView |

## Branch Logic

| Condition | Action |
|-----------|--------|
| File < safe threshold | Memory mode |
| File >= safe threshold | Backend mode |
| Line cache exceeded | Prune old cache |