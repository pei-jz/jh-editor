# CsvParser.worker.js — CSV解析ワーカー

Web WorkerでCSV解析を実行します。

**パス**: `src/modules/workers/CsvParser.worker.js`（1.7KB）

メッセージ受信→CSV文字列を2次元配列に解析→結果返却。共通Workerパターン使用。