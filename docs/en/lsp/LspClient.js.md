# LspClient.js — Language Server Protocol Client

## Purpose
Communicates with LSP via Rust backend for completion, hover, diagnostics.

## File Info
- **Path**: `src/modules/lsp/LspClient.js` (11.2KB)
- **Dependencies**: `@tauri-apps/api/core` (invoke), `ConnectionConfig`

## Key Methods

| Method | Description |
|--------|-------------|
| `init()` | Initialize LSP client |
| `getCompletion(params)` | Get completion candidates |
| `getHover(params)` | Get hover info |
| `getDiagnostics(params)` | Get diagnostics |
| `didOpen/Change/Close(params)` | File notifications |
| `startServer(lang)` | Start LSP server |
| `stopServer()` | Stop LSP server |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Server not running | Auto-call `startServer()` |
| Timeout | Log error, return empty |
| Unsupported language | Disable LSP, return empty |