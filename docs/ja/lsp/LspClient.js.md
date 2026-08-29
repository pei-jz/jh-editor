# LspClient.js — LSPクライアント

## 概要
`LspClient`はRustバックエンド経由でLanguage Server Protocolと通信するクライアントです。

## ファイル情報
- **パス**: `src/modules/lsp/LspClient.js`（11.2KB）
- **依存**: `@tauri-apps/api/core`(invoke), `ConnectionConfig`

## 主要メソッド

| メソッド | 説明 |
|---------|------|
| `init()` | LSPクライアント初期化 |
| `getCompletion(params)` | 補完候補取得 |
| `getHover(params)` | ホバー情報取得 |
| `getDiagnostics(params)` | 診断情報取得 |
| `didOpen(params)` | ファイルオープン通知 |
| `didChange(params)` | ファイル変更通知 |
| `didClose(params)` | ファイルクローズ通知 |
| `startServer(lang)` | LSPサーバー起動 |
| `stopServer()` | LSPサーバー停止 |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| サーバー未起動 | `startServer()`を自動呼び出し |
| タイムアウト | エラーログ、空結果返却 |
| サポート対象外言語 | LSP無効、空結果返却 |
