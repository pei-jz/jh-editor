# commands/app.rs — アプリケーションコマンド

アプリケーション/システム関連コマンドです（106行）。

**パス**: `src-tauri/src/commands/app.rs`

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `get_launch_args` | CLI起動引数取得 |
| `run_command` | シェルコマンド実行 |
| `expand_env_path` | 環境変数パス展開 |

## 分岐ロジック

- `run_command`: Windows→`cmd /C`、Unix→`sh -c`、Windowsは`CREATE_NO_WINDOW`フラグ
- `expand_env_path`: `%NAME%`（Windows）、`$NAME`/`${NAME}`（Unix）を展開