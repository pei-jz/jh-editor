# TerminalManager.js — Terminal Emulator

## Purpose
Integrated terminal using xterm.js connected to Rust backend PTY.

## File Info
- **Path**: `src/modules/ui/TerminalManager.js` (376 lines)
- **Dependencies**: `@xterm/xterm`, `@xterm/addon-fit`, `@tauri-apps/api/core` (invoke)

## Class: `TerminalManager`

## Key Methods

| Method | Description |
|--------|-------------|
| `init()` | Initialize xterm, start PTY |
| `toggle()` | Toggle terminal panel |
| `clear()` | Clear terminal |
| `write(data)` | Write to PTY |
| `resize(cols, rows)` | Resize terminal |
| `destroy()` | Stop PTY, destroy xterm |

## Branch Logic

| Condition | Action |
|-----------|--------|
| PTY not running | Auto-start |
| Panel hidden | Toggle to visible |
| Window resize | Auto-resize via fit addon |