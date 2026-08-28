# commands/search.rs — ファイル/コンテンツ検索

ファイル名・コンテンツ検索を提供するTauriコマンド群です（298行）。

**パス**: `src-tauri/src/commands/search.rs`

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `search_files` | ファイル名/コンテンツ検索 |
| `list_all_files` | 全ファイル一覧 |

## 分岐ロジック

- `search_files`: ignoreクレートで.gitignore対応、バイナリファイルスキップ
- パフォーマンス: crossbeam-channel使用の並列走査