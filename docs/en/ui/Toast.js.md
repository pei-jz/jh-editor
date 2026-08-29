# Toast.js — Toast Notifications

## Purpose
Temporary notification messages component.

## File Info
- **Path**: `src/modules/ui/Toast.js` (105 lines)

## Class: `Toast` (singleton)

## Key Methods

| Method | Description |
|--------|-------------|
| `show(message, type, duration)` | Show notification |
| `success(message)` | Success notification |
| `error(message)` | Error notification |
| `info(message)` | Info notification |
| `warning(message)` | Warning notification |

## Branch Logic

| Condition | Action |
|-----------|--------|
| `type === 'success'` | Green icon |
| `type === 'error'` | Red icon |
| `type === 'warning'` | Yellow icon |
| `type === 'info'` | Blue icon |
| Duration elapsed | Fade out and hide |
| Multiple notifications | Stack vertically |