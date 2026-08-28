# jhai-adapter.js — JHAI MCP Client SDK

## Purpose
Client SDK for JHAI "AI Hub" MCP (Model Context Protocol) integration. Vendored SDK handling both MCP server role and task execution.

## File Info
- **Path**: `src/modules/ai/jhai-adapter.js` (338 lines)

## Class: `JhaiAdapter`

## Key Features

| Feature | Description |
|---------|-------------|
| MCP server role | Operates as MCP server via outbound WS |
| `registerTool()` | Register tools |
| `registerIntent()` | Register intents |
| `runIntentTask()` / `chatTask()` | Execute tasks |
| JSON-RPC handling | `initialize`, `tools/list`, `tools/call` |
| Reconnection backoff | Exponential backoff on disconnect |