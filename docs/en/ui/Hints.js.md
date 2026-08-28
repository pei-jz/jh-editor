# Hints.js — Vimium-style Link Hints

## Purpose
Displays Vimium-style link hints for keyboard-driven element interaction.

## File Info
- **Path**: `src/modules/ui/Hints.js` (265 lines)

## Key Features

| Feature | Description |
|---------|-------------|
| `showHints()` | Show hint labels on interactive elements |
| Keyboard selection | Type hint label to select element |
| ESC cancel | Hide all hints |

## Target Elements

`a`, `button`, `input`, `textarea`, `[tabindex]`, `[onclick]`

## Branch Logic

| Condition | Action |
|-----------|--------|
| Element off-screen | Hide hint |
| Element `display:none` | Skip |
| Key matches hint label | Click that element |