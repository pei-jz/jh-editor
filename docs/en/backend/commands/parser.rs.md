# commands/parser.rs — JSON/XML/HTML Parser

Structured data parsing via Tauri commands (328 lines).

**Path**: `src-tauri/src/commands/parser.rs`

## Commands

| Command | Description |
|---------|-------------|
| `parse_structured_data` | Parse JSON/XML/HTML to StructuredNode tree |
| `get_node_children` | Lazy-load children of a node |

## Branch Logic

- `parse_structured_data`: Detect JSON/XML/HTML by extension or content
- `get_node_children`: Generate children for `lazy: true` nodes