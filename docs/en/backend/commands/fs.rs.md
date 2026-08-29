# commands/fs.rs — File System Commands

File system operations via Tauri commands (433 lines).

**Path**: `src-tauri/src/commands/fs.rs`

## State
`WorkspaceState { root_path: Arc<Mutex<Option<String>>> }`

## Commands

| Command | Description |
|---------|-------------|
| `set_workspace_root` | Set workspace root |
| `read_dir` | List directory |
| `read_file` | Read file |
| `write_file` | Write file (multi-encoding) |
| `create_dir` | Create directory |
| `remove_file` | Remove file/directory |
| `read_file_auto_detect` | Auto-detect encoding |
| `list_recursive` | Recursive file list |
| `parse_excel_to_markdown` | Excel→Markdown |

## Branch Logic

- `read_file_auto_detect`: chardetng auto-detect, reject binary (NUL in 1KB)
- `remove_file`: is_dir() check → recursive delete
- `list_recursive`: exclusions (.git, node_modules, etc.), priority folders, max 10,000 items