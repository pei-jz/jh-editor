# commands/app.rs — Application Commands

Application/system commands (106 lines).

**Path**: `src-tauri/src/commands/app.rs`

## Commands

| Command | Description |
|---------|-------------|
| `get_launch_args` | Get CLI args |
| `run_command` | Execute shell command |
| `expand_env_path` | Expand env path |

## Branch Logic

- `run_command`: Windows→`cmd /C`, Unix→`sh -c`, Windows uses `CREATE_NO_WINDOW`
- `expand_env_path`: Expand `%NAME%` (Windows), `$NAME`/`${NAME}` (Unix)