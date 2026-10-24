# LSP Module — Documentation Index

Language Server Protocol components.

| File | Description |
|------|-------------|
| [LspClient.js.md](./LspClient.js.md) | LSP client (communication with Rust backend) |

## Overview

The LSP client communicates with the Rust backend via Tauri IPC commands. The Rust side manages Language Server processes and relays JSON-RPC messages.

```
Frontend (JS) ←→ Tauri IPC ←→ Rust Backend ←→ LSP Server Process
```