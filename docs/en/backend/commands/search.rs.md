# commands/search.rs — File/Content Search

File name and content search via Tauri commands (298 lines).

**Path**: `src-tauri/src/commands/search.rs`

## Commands

| Command | Description |
|---------|-------------|
| `search_files` | File name/content search |
| `list_all_files` | List all files |

## Branch Logic

- `search_files`: .gitignore support via ignore crate, skip binary files
- Performance: parallel traversal with crossbeam-channel