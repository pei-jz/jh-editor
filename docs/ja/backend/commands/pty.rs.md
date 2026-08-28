# commands/pty.rs — 擬似ターミナル

portable-ptyを使用した擬似ターミナルを提供するコマンド群です（119行）。

**パス**: `src-tauri/src/commands/pty.rs`

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `spawn_pty` | PTY起動 |
| `stop_pty` | PTY停止 |
| `write_to_pty` | PTYに書き込み |
| `resize_pty` | PTYリサイズ |

## 状態
`PtyState { pty_master, pty_writer }` — Arc<Mutex>でスレッドセーフに管理