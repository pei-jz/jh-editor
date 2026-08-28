# ワーカーモジュール — ドキュメント索引

Web Workerベースのバックグラウンド処理群です。

| ファイル | 説明 |
|---------|------|
| [CodeFormatter.worker.js.md](./CodeFormatter.worker.js.md) | コードフォーマットワーカー |
| [CsvParser.worker.js.md](./CsvParser.worker.js.md) | CSV解析ワーカー |
| [Parser.worker.js.md](./Parser.worker.js.md) | 構造化データ解析ワーカー |

## 概要

すべてのワーカーは共通のパターンを使用しています：
1. メッセージ受信（`{id, type, content}`）
2. 処理実行
3. 結果返却（`{id, success, result/error}`）

フロントエンド側の`AsyncCsvParser`、`AsyncFormatter`、`AsyncParser`がラッパーとして機能します。