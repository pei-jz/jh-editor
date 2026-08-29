# CompletionWidget.js — LSP Completion Widget UI

## Purpose
UI widget for displaying LSP completion candidates.

## File Info
- **Path**: `src/modules/lsp/CompletionWidget.js` (3.2KB)
- **Dependencies**: `LspClient`

## Key Features

| Feature | Description |
|---------|-------------|
| Candidate display | Dropdown candidate list |
| Keyboard navigation | Arrow key navigation |
| Selection | Enter to apply |
| Cancel | Escape to hide |

## Branch Logic

| Condition | Action |
|-----------|--------|
| 0 candidates | Hide widget |
| 1 candidate with prefix match | Auto-apply |
| Input change | Re-filter candidates |