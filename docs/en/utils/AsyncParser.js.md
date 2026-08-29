# AsyncParser.js — Async Structured Data Parsing

Async XML/JSON/HTML parsing via Web Worker.

**Path**: `src/modules/utils/AsyncParser.js` (70 lines)

| Function | Description |
|----------|-------------|
| `parseAsync(content, type)` | Async parse via Worker ('xml'/'json'/'html') |

No sync fallback — rejects immediately when Worker unavailable.