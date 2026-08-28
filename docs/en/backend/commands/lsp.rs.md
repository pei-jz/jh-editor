# commands/lsp.rs — Language Server Protocol

LSP server management via Tauri commands (474 lines).

**Path**: `src-tauri/src/commands/lsp.rs`

## Commands

| Command | Description |
|---------|-------------|
| `start_lsp` | Start LSP server |
| `stop_lsp` | Stop LSP server |
| `lsp_did_open` | File open notification |
| `lsp_did_change` | File change notification |
| `lsp_did_close` | File close notification |
| `lsp_request` | JSON-RPC request relay |

## Branch Logic

- `start_lsp`: Select LSP server command by language, async start with tokio
- `lsp_request`: Route by method name to completion/hover/diagnostics