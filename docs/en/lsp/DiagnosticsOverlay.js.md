# DiagnosticsOverlay.js — LSP Diagnostics Overlay

## Purpose
Overlays LSP diagnostic info (errors, warnings) on the editor.

## File Info
- **Path**: `src/modules/lsp/DiagnosticsOverlay.js` (7.5KB)
- **Dependencies**: `LspClient`, CodeMirror

## Key Features

| Feature | Description |
|---------|-------------|
| Diagnostics display | Line-level error/warning icons |
| Hover details | Mouse-over diagnostic message |
| Underlines | Red/yellow error underlines |
| Auto-update | Refresh on file change |

## Branch Logic

| Condition | Action |
|-----------|--------|
| No diagnostics | Hide overlay |
| Error | Red icon + red underline |
| Warning | Yellow icon + yellow underline |
| Info | Blue underline |