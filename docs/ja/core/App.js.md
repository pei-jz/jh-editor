# App.js ドキュメント

## ファイルの目的

`App.js` は JHEditor の**アプリケーションエントリーポイント**です。アプリケーション全体のライフサイクルを管理します：
- すべてのUIコンポーネント（レイアウト、エクスプローラー、検索、設定）を初期化
- カスタムTauriタイトルバーのコントロールを設定
- グローバルキーボードショートカットを登録
- ファイルのドラッグ＆ドロップと単一インスタンス処理を管理
- ワークスペース/プロジェクトの切り替えを処理
- ファイルウォッチャー、Gitパネル、LSP、シンタックスハイライト、MCP統合を設定
- ウェルカムスクリーンと初期起動ロジックを管理

## エクスポート

このファイルは名前付き関数やクラスをエクスポートしません。`DOMContentLoaded` で実行される副作用モジュールです。

## 主要内部関数

### `switchProject(path)`

**目的：** アクティブなワークスペースを新しいディレクトリパスに切り替えます。

**パラメータ：**
| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `path` | `string` | 新しいワークスペースルートの絶対パス |

**戻り値：** `Promise<boolean>` — 切り替えが成功した場合は `true`、ユーザーがキャンセルした場合は `false`。

**ロジック：**
1. すべての開いているタブを閉じる（未保存ファイルのプロンプト付き）
2. `State.currentDir` を設定し、Tauriバックエンド `set_workspace_root` を呼び出す
3. エクスプローラーツリーを再読み込み
4. ターミナルを再起動
5. ワークスペース内のGitリポジトリを検出
6. `app:project-switched` カスタムイベントをディスパッチ

### `checkLaunchArgs()`

**目的：** CLI起動引数にファイルパスが含まれていないかチェックし、直接開く（ウェルカムスクリーンをスキップ）。

**戻り値：** `Promise<boolean>` — 引数からファイルが開かれた場合は `true`。

**ロジック：**
- Tauriバックエンド `get_launch_args` を呼び出す
- 引数に有効なファイルパスが見つかった場合、エクスプローラーを非表示にし、ファイルを開き、メインレイアウトを表示

### `setupCloseListener()`

**目的：** 未保存の変更がある場合にユーザーに確認を求めるために、ウィンドウの閉じるイベントを傍受します。

**ロジック：**
- 開いているファイルのいずれかが `isDirty === true` の場合、デフォルトの閉じる操作を防止
- 確認ダイアログを表示（日本語）
- 確認時、`appWindow.destroy()` で強制終了

## イベントハンドラ

| イベント | ハンドラ | 説明 |
|-------|---------|-------------|
| `DOMContentLoaded` | メイン初期化 | アプリの完全なブートストラップシーケンス |
| タイトルバーボタンの `click` | `appWindow.minimize/maximize/close` | カスタムウィンドウコントロール |
| `newFileBtn`/`newTabBtn` の `click` | `createNewFileAction` | 新しい無題タブを作成 |
| `saveBtn` の `click` | `saveCurrentFile` | アクティブファイルを保存 |
| `openFolderBtn` の `click` | `open()` ダイアログ → `switchProject` | 新しいワークスペースフォルダを開く |
| エクスプローラータブの `click` | `switchExplorerPanel` | ファイルとGitパネルを切り替え |
| `tauri://file-drop` | 各ドロップファイルに対して `openFile()` | ファイルのドラッグ＆ドロップ処理 |
| `single-instance` | CLI引数からファイルを開く | 単一インスタンスプロトコル |
| `git-status-updated` | ステータスバーのブランチラベルを更新 | Gitステータス表示 |
| `shortcutTriggered` | `globalActions` にディスパッチ | ビューからトリガーされたショートカットのカスタムイベント |
| `contextmenu` | `preventDefault()` | ブラウザのデフォルトコンテキストメニューを無効化 |
| `app:save-shortcut` | `saveCurrentFile` | 他のモジュールから委任された保存 |

## グローバルアクション（ショートカットマッピング）

`SHORTCUTS.GLOBAL` を通じて以下のショートカットがグローバルに登録されます：

| コマンド | アクション |
|---------|--------|
| `app:diff` | アクティブファイルをディスクバージョンと比較 |
| `app:open-compare` | フリーフォーム比較エディタを開く |
| `app:toggle-whitespace` | CR/LF/TABマーカーの表示切替 |
| `app:save` | 現在のファイルを保存 |
| `app:search` | 検索パネルの表示切替 |
| `app:file-search` | ファイル検索モーダルを開く |
| `app:format` | 現在のファイルをフォーマット |
| `app:outline-modal` | アウトラインナビゲーションを開く |
| `app:new-file` | 新しい無題タブを作成 |
| `app:close-tab` | アクティブタブを閉じる |
| `app:find-next` / `app:find-prev` | 検索ナビゲーション |
| `app:replace-next` | 次の一致を置換 |
| `app:refresh-explorer` | ファイルツリーを再読み込み |
| `app:shortcut-guide` | ショートカットガイドオーバーレイの切替 |
| `app:focus-explorer` | エクスプローラーパネルにフォーカス |
| `app:focus-editor` | エディタにフォーカス（先頭から） |
| `app:copy` / `app:cut` / `app:paste` | クリップボード操作 |
| `app:undo` / `app:redo` | アクティブビューの取り消し/やり直し |
| `app:inline-ai` | 現在のビューでインラインAIをトリガー |
| `app:toggle-view-mode` | テキスト/構造ビューの切替 |
| `app:init-lsp-syntax` | LSPとシンタックスハイライトの初期化 |

非グローバルショートカット（EDITOR、MARKDOWN_BLOCK、EXPLORERなど）は`delegateToView()`を通じてアクティブなビューに委任されます。

## 依存関係

| モジュール | 目的 |
|--------|---------|
| `Store.js` | アプリケーション状態（`State`） |
| `Constants.js` | DOM要素参照（`EL`） |
| `Markdown.js` | Markdown設定とMermaid初期化 |
| `Layout.js` | UIレイアウトの初期化 |
| `Explorer.js` | ファイルツリー探索 |
| `Editor.js` | エディタ、タブ、ファイル操作 |
| `ShortcutManager.js` | キーボードショートカット登録 |
| `ShortcutDefinitions.js` | ショートカット定義 |
| `Search.js` | 検索パネル |
| `Vim.js` | Vimモード |
| `WelcomeScreen.js` | ウェルカムスクリーン |
| `TabSearch.js` | タブ検索 |
| `SettingsModal.js` | 設定UI |
| `ShortcutGuide.js` | ショートカットガイドオーバーレイ |
| `OutlineModal.js` | アウトラインナビゲーション |
| `FileSearchModal.js` | ファイル検索 |
| `TerminalManager.js` | 統合ターミナル |
| `GitPanel.js` | Git操作パネル |
| `LspClient.js` | Language Server Protocolクライアント |
| `SyntaxHighlighter.js` | Shikiベースのシンタックスハイライト |
| `JhAiMcp.js` | JHAI MCP AI統合 |
| `@tauri-apps/api/core` | Tauri invoke |
| `@tauri-apps/api/window` | ウィンドウコントロール |
| `@tauri-apps/plugin-dialog` | ネイティブダイアログ |
| `@tauri-apps/api/event` | Tauriイベントリスナー |
