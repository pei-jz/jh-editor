# InlineAI.js — Inline AI Assistant

## Purpose
Inline AI assistant popup for selected text editing. Triggered by Ctrl+Space.

## File Info
- **Path**: `src/modules/ui/InlineAI.js` (503 lines)
- **Dependencies**: `AIAgent`, `DiffEditor`

## Key Features

| Feature | Description |
|---------|-------------|
| AI suggestions | Edit proposals for selected text |
| Diff display | Show changes via DiffEditor |
| Accept/Reject | Apply or cancel proposals |
| Context | Send surrounding text as context |

## Branch Logic

| Condition | Action |
|-----------|--------|
| No text selected | Use full buffer as context |
| AI response error | Show error message |
| No changes in response | Show "No changes" message |