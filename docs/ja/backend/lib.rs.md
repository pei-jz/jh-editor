# lib.rs — Tauriビューダーとアプリケーション構成

## 概要
Tauriアプリケーションのエントリポイント。プラグイン登録、コマンドハンドラ登録、状態管理を定義します。

## ファイル情報
- **パス**: `src-tauri/src/lib.rs`（93行）

## プラグイン一覧

| プラグイン                            | 説明                  |
| -------------------------------- | ------------------- |
| `tauri_plugin_single_instance`   | シングルインスタンス制御        |
| `tauri_plugin_http`              | HTTP通信              |
| `tauri_plugin_clipboard_manager` | クリップボード             |
| `tauri_plugin_fs`                | ファイルシステム（watch機能付き） |
| `tauri_plugin_dialog`            | ネイティブダイアログ          |
| `tauri_plugin_os`                | OS情報                |
| `tauri_plugin_shell`             | シェルコマンド             |
| `tauri_plugin_log`               | ログ（Infoレベル）         |

## 登録コマンド（53個）

8つのコマンドモジュールに分類：fs, search, parser, app, pty, git, large_file, lsp

## 状態管理

| State | 説明 |
|-------|------|
| `PtyState` | PTY接続状態 |
| `WorkspaceState` | ワークスペースルート |
| `LspState` | LSPサーバー状態 |
| `LargeFileState` | 巨大ファイルハンドル |
| `EditableState` | 編集可能巨大ファイル |