# Backend Module — Documentation Index

Rust/Tauri backend components.

| File | Description |
|------|-------------|
| [lib.rs.md](./lib.rs.md) | Tauri builder, plugin registration, command/state management |
| [main.rs.md](./main.rs.md) | Binary entry point |
| [models.rs.md](./models.rs.md) | Shared data models |
| [commands/mod.rs.md](./commands/mod.rs.md) | Command module declarations |
| [commands/app.rs.md](./commands/app.rs.md) | Application/system commands |
| [commands/fs.rs.md](./commands/fs.rs.md) | File system operations |
| [commands/git.rs.md](./commands/git.rs.md) | Git integration |
| [commands/large_file.rs.md](./commands/large_file.rs.md) | Large file handling |
| [commands/lsp.rs.md](./commands/lsp.rs.md) | Language Server Protocol |
| [commands/parser.rs.md](./commands/parser.rs.md) | JSON/XML/HTML parser |
| [commands/pty.rs.md](./commands/pty.rs.md) | Pseudo-terminal |
| [commands/search.rs.md](./commands/search.rs.md) | File/content search |
| [Cargo.toml.md](./Cargo.toml.md) | Dependency definitions |
| [tauri.conf.json.md](./tauri.conf.json.md) | Tauri configuration |

## Architecture

```
Frontend (JS/HTML) ─── invoke() ──→ Tauri IPC ──→ lib.rs (Tauri Builder)
                                            ├─ commands/fs.rs     (FS)
                                            ├─ commands/git.rs    (Git)
                                            ├─ commands/lsp.rs    (LSP)
                                            ├─ commands/parser.rs (Parse)
                                            ├─ commands/pty.rs    (PTY)
                                            ├─ commands/search.rs (Search)
                                            ├─ commands/app.rs    (App)
                                            └─ commands/large_file.rs
```

## State Management

| State | Struct | Description |
|-------|--------|-------------|
| WorkspaceState | `{ root_path }` | Workspace root path |
| PtyState | `{ pty_master, pty_writer }` | PTY connection |
| LspState | — | LSP server management |
| LargeFileState | — | Large file handles |
| EditableState | — | Editable large files |

## Registered Commands: 53