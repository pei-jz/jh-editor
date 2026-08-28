# AsyncCsvParser.js — 非同期CSV解析

Web Worker経由の非同期CSV解析を提供します。

**パス**: `src/modules/utils/AsyncCsvParser.js`（65行）

| 関数 | 説明 |
|------|------|
| `parseCsvAsync(content)` | WorkerにCSV解析を委譲、Promise返却 |

単一Workerシングルトンパターン。`requestId`でリクエスト/レスポンスを関連付け。Workerエラー時は全pendingリクエストをreject。