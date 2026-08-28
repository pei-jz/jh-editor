# AsyncCsvParser.js — Async CSV Parsing

Async CSV parsing via Web Worker.

**Path**: `src/modules/utils/AsyncCsvParser.js` (65 lines)

| Function | Description |
|----------|-------------|
| `parseCsvAsync(content)` | Delegate CSV parsing to Worker, return Promise |

Singleton Worker pattern. Correlates requests via `requestId`. On Worker error, rejects all pending requests.