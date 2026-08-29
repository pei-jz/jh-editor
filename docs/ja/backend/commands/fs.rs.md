# commands/fs.rs — ファイルシステム操作コマンド

ファイルシステム操作を提供するTauriコマンド群です（433行）。

**パス**: `src-tauri/src/commands/fs.rs`

## 状態
`WorkspaceState { root_path: Arc<Mutex<Option<String>>> }`

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `set_workspace_root` | ワークスペースルート設定 |
| `read_dir` | ディレクトリ一覧 |
| `read_file` | ファイル読み込み |
| `write_file` | ファイル書き込み（multi-encoding対応） |
| `create_dir` | ディレクトリ作成 |
| `remove_file` | ファイル/ディレクトリ削除 |
| `rename_file` | 名前変更 |
| `copy_file_cmd` | ファイルコピー |
| `exists` | 存在確認 |
| `read_file_auto_detect` | エンコーディング自動検出 |
| `read_file_with_encoding` | 指定エンコーディング |
| `paste_files` | クリップボードから貼り付け |
| `list_recursive` | 再帰的ファイルリスト |
| `parse_excel_to_markdown` | Excel→Markdown変換 |

## 分岐ロジック

- `read_file_auto_detect`: chardetngで自動検出、1KB以内にNULバイトがあればバイナリ拒否
- `remove_file`: `is_dir()`で判定し、ディレクトリなら再帰削除
- `list_recursive`: exclusions（.git, node_modules, target等）、優先フォルダ（src, lib等）で深度制限、最大10,000件