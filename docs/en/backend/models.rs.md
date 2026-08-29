# models.rs — Shared Data Models

Defines shared data structures for the Rust backend.

**Path**: `src-tauri/src/models.rs` (35 lines)

| Struct | Fields | Description |
|--------|--------|-------------|
| `FileEntry` | `name, is_directory, path` | File/directory |
| `SearchProgress` | `scanned, found, current_path, total, search_id` | Search progress |
| `FileContent` | `content, encoding` | Decoded file content |
| `StructuredNode` | `id, node_type, key, value, children, lazy` | Recursive tree node |

All derive `Debug, Clone, Serialize, Deserialize`. `node_type` renamed to `type` in JSON.