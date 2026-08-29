# Workers Module — Documentation Index

Web Worker-based background processing.

| File | Description |
|------|-------------|
| [CodeFormatter.worker.js.md](./CodeFormatter.worker.js.md) | Code formatting worker |
| [CsvParser.worker.js.md](./CsvParser.worker.js.md) | CSV parsing worker |
| [Parser.worker.js.md](./Parser.worker.js.md) | Structured data parsing worker |

## Overview

All workers follow a common pattern:
1. Message reception (`{id, type, content}`)
2. Processing
3. Result return (`{id, success, result/error}`)

Frontend wrappers `AsyncCsvParser`, `AsyncFormatter`, and `AsyncParser` provide the async interface.