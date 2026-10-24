# LSPモジュール — ドキュメント索引

Language Server Protocol（LSP）関連のコンポーネント群です。

| ファイル | 説明 |
|---------|------|
| [LspClient.js.md](./LspClient.js.md) | LSPクライアント（Rustバックエンドとの通信） |

## 概要

LSPクライアントはTauriコマンド経由でRustバックエンドと通信します。Rust側ではLanguage Serverプロセスを管理し、JSON-RPCメッセージを転送します。

```
Frontend (JS) ←→ Tauri IPC ←→ Rust Backend ←→ LSP Server Process
```