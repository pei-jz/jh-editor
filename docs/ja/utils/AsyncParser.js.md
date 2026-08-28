# AsyncParser.js — 非同期構造化データ解析

Web Worker経由の非同期XML/JSON/HTML解析。

**パス**: `src/modules/utils/AsyncParser.js`（70行）

| 関数 | 説明 |
|------|------|
| `parseAsync(content, type)` | Workerで非同期解析（'xml'/'json'/'html'） |

Worker不可用時は即reject（同期フォールバックなし）。