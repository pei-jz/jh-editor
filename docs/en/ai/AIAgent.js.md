# AIAgent.js — Facade for External LLM Task Delegation

## Purpose
`AIAgentFacade` enables task delegation from JHEditor to J.H AI Agent (external LLM). Supports iterative agent and single-shot execution modes.

## File Info
- **Path**: `src/modules/ai/AIAgent.js` (217 lines)
- **Dependencies**: `ConnectionConfig.js`, `jhai-adapter.js`

## Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `run` | `task, options` | `Promise` | Iterative agent execution |
| `runSingleShot` | `prompt, options` | `Promise` | Single-shot LLM call |
| `checkHealth` | — | `Promise<boolean>` | Agent reachability check |

## Branch Logic

| Condition | Action |
|-----------|--------|
| Client not initialized | Lazy init via `ConnectionConfig` |
| `AbortSignal` provided | Task cancellation support |

## Event Routing

| Event | Description |
|-------|-------------|
| `stream` | LLM output streaming |
| `status` | Task state changes |
| `thought` | LLM thinking process |
| `tool_call` | Tool invocation |
| `file_modified` | File change notification |