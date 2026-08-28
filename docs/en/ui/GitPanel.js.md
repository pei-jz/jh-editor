# GitPanel.js — Full Git Integration Panel

## Purpose
Complete Git integration UI with status display, diff view, commit, push, pull, and all common Git operations.

## File Info
- **Path**: `src/modules/ui/GitPanel.js` (~1060 lines)
- **Dependencies**: `@tauri-apps/api/core` (invoke), `ContextMenu`

## Key Features

| Feature | Description |
|---------|-------------|
| `git_status` | Branch, staged, modified, **deleted**, untracked files |
| `git_diff` | File diff display |
| `git_add` / `git_unstage` | Stage/unstage |
| `git_commit` | Commit |
| `git_push` / `git_pull` / `git_fetch` | Remote operations |
| `git_log` | Commit history |
| `git_discard` | Discard changes (restores deleted files) |
| `git_ignore` | Add to .gitignore |
| `git_init` | Initialize repository |

## Status Display Details

### Changes list classification
- **M (Modified)**: files changed in the working tree
- **D (Deleted)**: files deleted in the working tree. The badge is red and the label gets a strikethrough to make "deleted" obvious
- **U (Untracked)**: newly added files/folders

### Untracked folder handling
- The Rust `git_status` uses `-uall` so every file inside an untracked directory is listed individually
- A new folder such as `docs/` therefore renders as a tree node that can be expanded to reveal its contents
- An empty untracked folder renders as a folder node that can be staged in one click

### Status badges
- `U` (green): new / untracked
- `M` (yellow/orange): modified
- `D` (red): deleted — with strikethrough
- `S` (green): staged

Hovering a badge shows a tooltip explaining what the letter means.

## Branch Logic

| Condition | Action |
|-----------|--------|
| No Git repo detected | Show "Init Git" button |
| No staged files | Disable commit button |
| Push/pull error | Show error message |
| Multi-repo | Show repo switcher UI |
| Deleted file diff | Show HEAD content (left) vs empty (right) |
| Untracked folder | Render as tree node; stageable |
