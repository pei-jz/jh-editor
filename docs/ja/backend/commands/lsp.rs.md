# commands/lsp.rs — Language Server Protocol

LSPサーバー管理を提供するTauriコマンド群です（474行）。

**パス**: `src-tauri/src/commands/lsp.rs`

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `start_lsp` | LSPサーバー起動 |
| `stop_lsp` | LSPサーバー停止 |
| `lsp_did_open` | ファイルオープン通知 |
| `lsp_did_change` | ファイル変更通知 |
| `lsp_did_close` | ファイルクローズ通知 |
| `lsp_request` | JSON-RPCリクエスト転送 |

## 分岐ロジック

- `start_lsp`: 言語に応じてLSPサーバーコマンドを決定、tokioで非同期起動
- `lsp_request`: メソッド名に応じて補完/ホバー/診断リクエストを処理