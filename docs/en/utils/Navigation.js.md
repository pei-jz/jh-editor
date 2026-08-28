# Navigation.js — In-file Navigation

## Purpose
Provides go-to-definition, find references, and other in-file navigation features.

## File Info
- **Path**: `src/modules/utils/Navigation.js` (8.2KB)
- **Dependencies**: `@tauri-apps/api/core` (invoke), `Store.js`, `Editor.js`

## Key Functions

| Function | Description |
|----------|-------------|
| `handleNavigation(type, params)` | Navigation dispatcher |
| `goToDefinition(file, position)` | Jump to definition |
| `findReferences(file, position)` | Find references |