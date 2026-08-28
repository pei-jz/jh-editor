# commands/large_file.rs — Large File Handling Commands

Large file read/search/edit via Tauri commands (591 lines).

**Path**: `src-tauri/src/commands/large_file.rs`

## Commands

| Command | Description |
|---------|-------------|
| `large_file_open` | Open large file |
| `large_file_lines` | Get line range |
| `large_file_search` | Search in file |
| `editable_open` | Open in edit mode |
| `editable_window` | Get window lines |
| `editable_replace` | Replace window content |
| `editable_save` | Save |
| `editable_search` | Search in edit mode |

## Branch Logic

- `large_file_open`: Memory-mapped file access
- `editable_window`: Fetch line range from ropey Rope
- `editable_replace`: Normalize CRLF→LF before applying to Rope