# LargeFileEditView.js — Large File Editing View

## Purpose
Editing view for huge files using a "sliding window over a rope" technique. Browser holds ~4000 lines; Rust `ropey::Rope` is source of truth.

## File Info
- **Path**: `src/modules/views/LargeFileEditView.js` (446 lines)
- **Dependencies**: `@tauri-apps/api/core` (invoke)

## Constants
- `WINDOW_LINES = 4000`, `RELOAD_MARGIN = 800`

## Key Methods

| Method | Description |
|--------|-------------|
| `render(file)` | Build DOM, load initial window |
| `save()` | Commit window → `editable_save` |
| `find(term, forward)` | Search via `editable_search` |
| `_loadWindow(startLine)` | Fetch lines from Rust rope |
| `_commit()` | Write textarea back to rope |
| `_maybeSlideWindow()` | Detect window edge → slide |
| `_onScroll()` | Sync gutter + slide window |
| `_onBlur()` | Auto-commit on blur |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Scroll near top edge | Slide window up |
| Scroll near bottom edge | Slide window down |
| `windowDirty` is true | Auto-commit before slide/blur |