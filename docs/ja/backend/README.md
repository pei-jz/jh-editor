# バックエンドモジュール — ドキュメント索引

Rust/Tauriバックエンドのコンポーネント群です。

| ファイル | 説明 |
|---------|------|
| [lib.rs.md](./lib.rs.md) | Tauriビューダー、プラグイン登録、コマンド/状態管理 |
| [main.rs.md](./main.rs.md) | バイナリエントリポイント |
| [models.rs.md](./models.rs.md) | 共有データモデル |
| [commands/mod.rs.md](./commands/mod.rs.md) | コマンドモジュール宣言 |
| [commands/app.rs.md](./commands/app.rs.md) | アプリケーション/システムコマンド |
| [commands/fs.rs.md](./commands/fs.rs.md) | ファイルシステム操作 |
| [commands/git.rs.md](./commands/git.rs.md) | Git統合 |
| [commands/large_file.rs.md](./commands/large_file.rs.md) | 巨大ファイル処理 |
| [commands/lsp.rs.md](./commands/lsp.rs.md) | Language Server Protocol |
| [commands/parser.rs.md](./commands/parser.rs.md) | JSON/XML/HTMLパーサー |
| [commands/pty.rs.md](./commands/pty.rs.md) | 擬似ターミナル |
| [commands/search.rs.md](./commands/search.rs.md) | ファイル/コンテンツ検索 |
| [Cargo.toml.md](./Cargo.toml.md) | 依存関係定義 |
| [tauri.conf.json.md](./tauri.conf.json.md) | Tauri設定 |

## アーキテクチャ

```
┌─────────────────────────────────┐
│     Frontend (JS/HTML)          │
│  invoke('command_name', args)   │
└──────────┬──────────────────────┘
           │ Tauri IPC
┌──────────▼──────────────────────┐
│     lib.rs (Tauri Builder)      │
│  ├─ commands/fs.rs    (FS)     │
│  ├─ commands/git.rs   (Git)    │
│  ├─ commands/lsp.rs   (LSP)    │
│  ├─ commands/parser.rs (Parse) │
│  ├─ commands/pty.rs   (PTY)    │
│  ├─ commands/search.rs (Search)│
│  ├─ commands/app.rs   (App)    │
│  └─ commands/large_file.rs     │
└─────────────────────────────────┘
```

## 状態管理

| State | 構造体 | 説明 |
|-------|--------|------|
| WorkspaceState | `{ root_path: Arc<Mutex<Option<String>>> }` | ワークスペースルート |
| PtyState | `{ pty_master, pty_writer }` | PTY接続 |
| LspState | LSPサーバー管理 |
| LargeFileState | 巨大ファイルハンドル |
| EditableState | 編集可能巨大ファイル |

## 登録済みコマンド数: 53個