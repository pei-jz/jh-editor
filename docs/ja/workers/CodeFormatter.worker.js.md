# CodeFormatter.worker.js — コードフォーマットワーカー

Web Workerでコードフォーマットを実行します。

**パス**: `src/modules/workers/CodeFormatter.worker.js`（592B）

メッセージ受信→CodeFormatter.format()実行→結果返却。共通Workerパターン（id, success, result/error）。