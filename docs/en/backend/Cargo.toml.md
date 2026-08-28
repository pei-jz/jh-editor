# Cargo.toml — Package Manifest

Defines Rust backend dependencies (53 lines).

**Path**: `src-tauri/Cargo.toml`

## Key Dependencies

| Crate | Version | Description |
|-------|---------|-------------|
| `tauri` | 2.2.0 | Framework |
| `tokio` | 1.x | Async runtime |
| `portable-pty` | 0.9.0 | PTY |
| `chardetng` | 0.1.17 | Encoding detection |
| `ignore` | 0.4 | .gitignore traversal |
| `ropey` | 1.6 | Text rope |
| `calamine` | 0.25.0 | Excel reading |

Release: LTO, strip, opt-level "s"