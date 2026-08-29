# commands/pty.rs — Pseudo-terminal

PTY via portable-pty (119 lines).

**Path**: `src-tauri/src/commands/pty.rs`

## Commands

| Command | Description |
|---------|-------------|
| `spawn_pty` | Start PTY |
| `stop_pty` | Stop PTY |
| `write_to_pty` | Write to PTY |
| `resize_pty` | Resize PTY |

## State
`PtyState { pty_master, pty_writer }` — Thread-safe via Arc<Mutex>