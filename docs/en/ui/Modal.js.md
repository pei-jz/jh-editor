# Modal.js — Modal Dialog Collection

## Purpose
Common modal dialog utilities for input and confirmation dialogs.

## File Info
- **Path**: `src/modules/ui/Modal.js` (401 lines)

## Key Functions

| Function | Description |
|----------|-------------|
| `showInputModal(title, message, defaultValue)` | Show input modal |
| `showConfirmModal(title, message)` | Show confirmation modal |
| `closeInputModal()` | Close input modal |

## Branch Logic

| Condition | Action |
|-----------|--------|
| User cancel | Return `null` |
| Empty input | Return default value |
| Escape key | Close modal |