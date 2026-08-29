# commands/large_file.rs — 巨大ファイル処理コマンド

巨大ファイルの読み取り・検索・編集を提供するTauriコマンド群です（591行）。

**パス**: `src-tauri/src/commands/large_file.rs`

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `large_file_open` | 巨大ファイルを開く |
| `large_file_lines` | 指定範囲の行を取得 |
| `large_file_search` | ファイル内検索 |
| `large_file_close` | ファイルを閉じる |
| `editable_open` | 編集モードで開く |
| `editable_window` | ウィンドウ範囲の行を取得 |
| `editable_replace` | ウィンドウ内容を置換 |
| `editable_line_count` | 総行数取得 |
| `editable_search` | 編集モード検索 |
| `editable_save` | 保存 |
| `editable_close` | 編集モード終了 |

## 分岐ロジック

- `large_file_open`: メモリマップ使用でmmap開設
- `editable_window`: ropey Ropeから行範囲を取得、改行正規化
- `editable_replace`: 受信テキストをCRLF→LF正規化してRopeに適用