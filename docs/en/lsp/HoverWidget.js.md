# HoverWidget.js — LSP Hover Widget

## Purpose
Displays LSP hover information (type info, documentation) on mouse-over.

## File Info
- **Path**: `src/modules/lsp/HoverWidget.js` (2.5KB)
- **Dependencies**: `LspClient`

## Key Features

| Feature | Description |
|---------|-------------|
| Hover display | Type info and documentation |
| Markdown rendering | Render hover content as Markdown |
| Position adjustment | Keep within viewport |

## Branch Logic

| Condition | Action |
|-----------|--------|
| No hover info | Hide widget |
| Large documentation | Truncate |
| Near window edge | Flip position |