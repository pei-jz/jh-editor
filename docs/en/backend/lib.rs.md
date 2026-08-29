# lib.rs — Tauri Builder and App Configuration

## Purpose
Tauri application entry point. Defines plugin registration, command handlers, and state management.

## File Info
- **Path**: `src-tauri/src/lib.rs` (93 lines)

## Plugins

| Plugin | Description |
|--------|-------------|
| `single_instance` | Single instance control |
| `http` | HTTP communication |
| `clipboard_manager` | Clipboard |
| `fs` | File system (with watch) |
| `dialog` | Native dialogs |
| `os` | OS info |
| `shell` | Shell commands |
| `log` | Logging (Info level) |

## Registered Commands (53)

8 command modules: fs, search, parser, app, pty, git, large_file, lsp

## State Management

| State | Description |
|-------|-------------|
| `PtyState` | PTY connection |
| `WorkspaceState` | Workspace root |
| `LspState` | LSP server |
| `LargeFileState` | Large file handles |
| `EditableState` | Editable large files |