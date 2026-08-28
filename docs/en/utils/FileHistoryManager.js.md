# FileHistoryManager.js — Per-file Undo History

Manages undo history snapshots per file path (max 20).

**Path**: `src/modules/utils/FileHistoryManager.js` (53 lines)

| Method | Description |
|--------|-------------|
| `push(path, content)` | Save snapshot |
| `pop(path)` | Get latest snapshot |
| `canUndo(path)` | Check if undoable |
| `clear(path)` | Clear history |