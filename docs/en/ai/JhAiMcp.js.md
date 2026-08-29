# JhAiMcp.js — JHEditor ↔ JHAI MCP Integration

## Purpose
`JhAiMcp.js` exposes JHEditor as an MCP server to JHAI. Reverse direction of AIAgent.js: provides editor tools to JHAI's LLM.

## File Info
- **Path**: `src/modules/ai/JhAiMcp.js` (513 lines)
- **Dependencies**: `ConnectionConfig.js`, `jhai-adapter.js`, `window.app`

## Exported Functions

| Function | Description |
|----------|-------------|
| `initJhEditorMcp()` | Initialize MCP connection |
| `runJhaiIntent(intent, payload)` | Execute JHAI intent |
| `runJhaiFreeform(prompt)` | Execute freeform prompt |
| `waitForConnection()` | Wait for connection |

## Registered MCP Tools

| Tool Name | Description |
|-----------|-------------|
| `get_buffer` | Get current editor buffer |
| `get_selection` | Get selected text |
| `list_open_files` | List open files |
| `read_workspace_file` | Read workspace file |
| `get_diagnostics` | Get LSP diagnostics |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Path traversal detected | Reject paths containing `..` |
| Connection not established | Wait via `waitForConnection()` |
| `window.app` undefined | Log error |