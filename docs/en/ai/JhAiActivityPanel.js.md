# JhAiActivityPanel.js — JHAI Activity Panel

## Purpose
Lightweight bottom-right dock panel for streaming JHAI task status.

## File Info
- **Path**: `src/modules/ai/JhAiActivityPanel.js` (223 lines)

## Class: `ActivityPanel`

## Key Methods

| Method | Description |
|--------|-------------|
| `addTask(taskInfo)` | Add task, return `EntryHandle` |
| `setStatus(handle, status)` | Update task status |
| `setResult(handle, result)` | Set task result |
| `setError(handle, error)` | Set error |
| `onAbort(handle)` | Abort task |

## Task Card Lifecycle

`running` → `done` / `error` / `aborted`

## Features
- Markdown rendering
- Action buttons
- Max history: 20 (prune oldest when exceeded)