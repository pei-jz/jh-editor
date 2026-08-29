# LSP Module — Documentation Index

Language Server Protocol components.

| File | Description |
|------|-------------|
| [CompletionWidget.js.md](./CompletionWidget.js.md) | LSP completion widget UI |
| [DiagnosticsOverlay.js.md](./DiagnosticsOverlay.js.md) | LSP diagnostics overlay (errors/warnings) |
| [HoverWidget.js.md](./HoverWidget.js.md) | LSP hover widget |
| [LspClient.js.md](./LspClient.js.md) | LSP client (communication with Rust backend) |

## Overview

The LSP client communicates with the Rust backend via Tauri IPC commands. The Rust side manages Language Server processes and relays JSON-RPC messages.

```
Frontend (JS) ←→ Tauri IPC ←→ Rust Backend ←→ LSP Server Process
```