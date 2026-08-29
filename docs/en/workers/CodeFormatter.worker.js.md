# CodeFormatter.worker.js — Code Formatting Worker

Runs code formatting in a Web Worker.

**Path**: `src/modules/workers/CodeFormatter.worker.js` (592B)

Message receive → CodeFormatter.format() → result return. Common Worker pattern (id, success, result/error).