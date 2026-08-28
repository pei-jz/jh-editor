# AsyncFormatter.js — Async Code Formatting

Async code formatting via Web Worker.

**Path**: `src/modules/utils/AsyncFormatter.js` (79 lines)

| Function | Description |
|----------|-------------|
| `formatAsync(content, type)` | Async format via Worker, sync fallback on failure |

Falls back to dynamic `import('./CodeFormatter.js')` when Worker unavailable.