# commands/git.rs — Git統合コマンド

Git操作を提供するTauriコマンド群です（約520行）。

**パス**: `src-tauri/src/commands/git.rs`

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `git_status` | ブランチ、ステージド、修正、**削除**、追跡未設定ファイル |
| `git_add` / `git_unstage` | ステージング/アンステージ |
| `git_commit` | コミット |
| `git_log` | コミット履歴 |
| `git_diff` | 差分表示 |
| `git_push` / `git_pull` / `git_fetch` | リモート操作 |
| `git_show` | コミット詳細 |
| `git_discard` | 変更破棄（削除ファイルは復元） |
| `git_ignore` | .gitignore追加 |
| `git_init` | リポジトリ初期化 |
| `find_git_repos` | 複数Gitリポジトリ検出 |
| `git_diff_files` | 2リビジョン間の変更ファイル一覧 |
| `git_commit_files` | コミットの変更ファイル一覧 |
| `git_file_diff` | 単一ファイルのリビジョン間差分 |

## ヘルパー関数

| 関数 | 説明 |
|------|------|
| `decode_git_bytes` | chardetng使用の自動エンコーディング検出 |
| `git_command` | `core.quotepath=false`付きgitコマンド作成 |

## 分岐ロジック

- `git_status`: `git status --porcelain -b -uall` 出力を解析。`M `/`A `/`D `→staged、` M`→modified、` D`→**deleted**、`??`→untracked
  - `-uall` により untracked ディレクトリ内の全ファイルを個別に列挙し、Gitパネルでフォルダを展開できる
- `GitStatus` 構造体に `deleted` フィールドを追加し、作業ツリーで削除されたファイルを明示