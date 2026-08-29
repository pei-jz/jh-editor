# LSPモジュール — ドキュメント索引

Language Server Protocol（LSP）関連のコンポーネント群です。

| ファイル | 説明 |
|---------|------|
| [CompletionWidget.js.md](./CompletionWidget.js.md) | LSP補完ウィジェットUI |
| [DiagnosticsOverlay.js.md](./DiagnosticsOverlay.js.md) | LSP診断オーバーレイ（エラー/警告表示） |
| [HoverWidget.js.md](./HoverWidget.js.md) | LSPホバーウィジェット |
| [LspClient.js.md](./LspClient.js.md) | LSPクライアント（Rustバックエンドとの通信） |

## 概要

LSPクライアントはTauriコマンド経由でRustバックエンドと通信します。Rust側ではLanguage Serverプロセスを管理し、JSON-RPCメッセージを転送します。

```
Frontend (JS) ←→ Tauri IPC ←→ Rust Backend ←→ LSP Server Process
```