# Editor.js ドキュメント

## ファイルの目的

`Editor.js` は JHEditor の**エディタオーケストレーションモジュール**です。1641行と最大のコアモジュールであり、以下を担当します：
- ファイルの開閉・保存ロジック
- タブ管理（作成、切替、閉じる、並べ替え、分割ペイン）
- ビューのレンダリング — ファイルごとに正しいビュータイプを選択（CodeMirror、Markdown、CSV、Diff、Compare、LargeFile、Agent）
- 分割エディタ（サイドバイサイド）サポート
- ファイルウォッチャー統合（ネイティブTauriイベント）
- クリップボード委任（コピー/カット/ペースト）
- ステータスバー更新、コンテキストメニュー設定
- エディタ固有コマンドのキーボードショートカット登録
- フォーマット、取り消し/やり直しの委任、LSP統合フック

## 定数

| 名前 | 値 | 説明 |
|------|-------|-------------|
| `LARGE_FILE_VIEW_THRESHOLD` | `500 * 1024 * 1024`（500MB） | このサイズを超えるファイルは読み取り専用の仮想化LargeFileViewで開く |

## モジュールレベルの状態

| 変数 | 型 | 説明 |
|----------|------|-------------|
| `leftView` | `object \| null` | 左エディタペインの現在のビューインスタンス |
| `rightView` | `object \| null` | 右エディタペインの現在のビューインスタンス（分割モード） |
| `activeUnwatch` | `function \| null` | 現在のネイティブファイルウォッチャーのクリーンアップ関数 |
| `pendingOpens` | `Set<string>` | 現在開処理中のファイルパスを追跡し、重複呼び出しを防止 |

## エクスポート関数

### `getCurrentView()`
**戻り値：** `State.activePane` に基づいてアクティブなビューインスタンス（`leftView` または `rightView`）を返します。

### `toggleWhitespace()`
**目的：** すべての開いているエディタペインでCR/LF/TABホワイトスペースマーカーを切り替えます。選択をlocalStorageに保存します。ステータスバーのインジケータを更新します。

### `openDiffEditor(original, modified, filePath, onApply, onChange, onSave, diffOptions)`
**パラメータ：**
| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `original` | `string` | 元のテキスト（diffの左側） |
| `modified` | `string` | 変更されたテキスト（diffの右側） |
| `filePath` | `string` | 元のファイルパス |
| `onApply` | `function` | ユーザーが「適用して保存」をクリックした時のコールバック |
| `onChange` | `function` | 各ハンクの受け入れ/拒否時のコールバック |
| `onSave` | `function` | diffビューでCtrl+S時のコールバック |
| `diffOptions` | `object` | 追加オプション（compareMode、ラベルなど） |

**ロジック：**
- このファイルのdiffタブが既に存在する場合は、その場で更新
- それ以外は `type: 'diff'` の新しい仮想タブを作成
- `makeApply()` ラッパーでファイルをクリーンにしdiffタブを閉じる

### `openCompareEditor()`
**目的：** 空のサイドバイサイドテキスト比較タブを開きます（ディスクファイルに紐付きません）。既存の比較タブがあれば再利用します。

### `openAgentTasksTab(taskId?)`
**目的：** AIエージェントタスクパネルをタブとして開きます。`taskId` が指定された場合、その特定のタスクにフォーカスします。

### `closeAllTabs(action = 'prompt')`
**パラメータ：**
| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `action` | `string \| boolean` | `'prompt'`、`'save'`/`true`、`'force'`/`false` |

**戻り値：** `Promise<boolean>` — タブが閉じられた場合は `true`、ユーザーがキャンセルした場合は `false`。

**ロジック：**
- `'save'`：すべての未保存ファイルを保存してから閉じる
- `'prompt'`：未保存ファイルがある場合にダイアログを表示
- `'force'`：すべての変更を破棄
- Rust側のハンドルを解放（大きなファイルのmmap、ropeエディタ）
- すべての状態をリセットし再レンダリング

### `renderEditor(targetPane?)`
**目的：** コアのビューレンダリング関数です。各ペインのアクティブファイルに対して正しいビュータイプを選択します。

**パラメータ：**
| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `targetPane` | `'left' \| 'right' \| null` | レンダリングするペイン（null = アクティブな全ペイン） |

**ビュー選択ロジック（優先度順）：**
1. **Diff**（`file.type === 'diff'`）→ `DiffEditor`
2. **Compare**（`file.type === 'compare'`）→ `CompareView`
3. **Agent Tasks**（`file.type === 'agent'`）→ `TaskNotificationPanel`
4. **巨大ファイル編集モード**（`file.isEditing && file.editId`）→ `LargeFileEditView`
5. **巨大ファイル読み取り専用**（`file.isLarge` またはコンテンツ > 500MB）→ `LargeFileView`
6. **プラグインベースビュー**（CSV、XML、JSON、HTML、Markdown）→ `pluginManager` で解決
7. **デフォルト** → `CodeMirrorView`

### `renderTabs(targetPane?)`
**目的：** 1つまたは両方のペインのタブバーをレンダリングします。各タブはファイル名、未保存インジケータ、閉じるボタンを表示します。右クリックコンテキストメニューをサポート：コピー、パスの比較、反対ペインに移動、すべて閉じる、他を閉じる。

### `setActiveTab(index, pane?)`
**目的：** アクティブなタブを切り替えます。検索状態をクリーンアップし、タブとエディタを再レンダリングし、ツールバーを更新し、ファイルウォッチャーを設定し、タブをスクロールして表示します。

### `closeTab(index, pane?)`
**目的：** 単一タブを閉じます。未保存ファイルのプロンプトを表示します（仮想diff/compare/agentタブを除く）。Rust側のハンドルを解放します。アクティブタブインデックスを調整します。

### `closeFileByPath(path)`
**目的：** ファイルパスでタブを検索して閉じます。

### `closeFilesUnderDir(dirPath)`
**目的：** パスが指定されたディレクトリで始まるすべてのタブを閉じます。安全な削除のために逆方向に反復処理します。

### `openFile(path, forceEncoding?)`
**目的：** ファイルを新しいまたは既存のタブで開きます。

**パラメータ：**
| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `path` | `string` | 開くファイルパス |
| `forceEncoding` | `boolean \| string` | 特定のエンコーディングで再開 |

**ロジック：**
- パスを正規化（UNC、相対パスを解決）
- `pendingOpens` Setで重複排除
- 500MB超のファイル：Rust mmapバックエンド（`large_file_open`）で開く
- それ以外：`FS.readFileAutoDetect` で読み込み
- タブの重複排除とエンコーディング変更を処理

### `createNewFileAction()`
**目的：** 空の内容で新しい無題タブ（`Untitled.txt`、`Untitled-1.txt`など）を作成します。

### `saveCurrentFile()`
**目的：** アクティブファイルを保存します。複数のケースを処理します：
- 仮想スクラッチタブ（compare）→ ノーオプ
- diffタブ → `onSave`コールバックに委任
- rope対応の巨大ファイル → ビューのsaveメソッドに委任
- 読み取り専用の大きなファイル → エラートーストを表示
- 無題ファイル → 保存ダイアログを表示
- 通常のファイル → EOL変換付きで書き込み、統計を更新、エクスプローラーとgitを更新

### `formatCurrentFile()`
**目的：** 非同期フォーマッターを使用してアクティブファイルをフォーマットします。サポート：JSON、XML、SQL、HTML、Java、JavaScript、TypeScript。

### `splitEditor()` / `closeSplit()`
**目的：** 水平分割エディタモードの有効/無効を切り替えます。分割時、アクティブファイルを右ペインにクローンします。

### `moveTabToOtherPane(index, sourcePane)`
**目的：** タブをあるペインから別のペインに移動します。まだアクティブでない場合は分割モードを有効にします。

### `setupWatcher(file)`
**目的：** 指定されたファイルにネイティブTauriファイルウォッチャーを設定します。外部からの変更時にユーザーに再読み込みを促します（自己トリガーを回避するために1秒のデバウンス付き）。

### `updateToolbar()`
**目的：** 現在のファイルのディレクトリとファイル名でツールバーを更新します。

### `updateStatusBar()`
**目的：** ステータスバーを更新します：ファイルタイプ、ファイルサイズ、最終更新日、エンコーディング、行/列位置、選択範囲の長さ。

### `compareWithDisk(file)`
**目的：** メモリ上の内容をディスク上のバージョンと比較するdiffエディタを開きます。ディスク読み取りに同じエンコーディングを使用します。

### `compareWithFile(file)`
**目的：** ファイルダイアログで別のファイルを選択し、2つのdiffエディタを開きます。

### `focusEditor(options?)`
**目的：** 現在のビューのエディタにフォーカスします。`{ toStart: true }` でカーソルを位置0に移動します。

### `getSelectedText()` / `replaceSelectedText(text)`
**目的：** テキストの選択/置換を現在のビューに委任します。

### `triggerCopy()` / `triggerCut()` / `triggerPaste()`
**目的：** 複数のコンテキストをチェックするクリップボード操作：アクティブなinput/textarea、ブラウザ選択、ビュー固有メソッドにフォールバック。

### Markdownブロックメソッド
- `selectBlock(index)` — インデックスでMarkdownブロックを選択
- `activateBlock(index)` — Markdownブロックを編集用にアクティブ化
- `saveBlock(index, newText)` — 編集されたブロック内容を保存

## エディタショートカットアクション

### グローバルスコープ
| コマンド | アクション |
|---------|--------|
| `save` | 現在のファイルを保存 |
| `app:tab-search` | タブ検索モーダルを開く |
| `app:toggle-view-mode` | テキスト ↔ 構造ビューの切替（構造は5MB制限付き） |
| `md-block:nav` | Markdownブロックをナビゲート（ArrowUp/Down） |
| `md-block:edit` | 選択されたMarkdownブロックを編集 |

### エディタスコープ
| コマンド | アクション |
|---------|--------|
| `editor:next-tab` | 次のタブに切替 |
| `editor:prev-tab` | 前のタブに切替 |
| `editor:go-to-definition` | LSP定義への移動 |
| `editor:find-references` | LSP参照の検索 |
| `editor:split-right` | エディタを分割 |
| `editor:close-split` | 分割ペインを閉じる |

## window.app で公開されるメソッド

| メソッド | 説明 |
|--------|-------------|
| `createNewTab(proposedPath, content)` | AIパネルや外部ソースからタブを作成 |
| `openFile` | エクスポートされた `openFile` への参照 |
| `openDiffEditor` | エクスポートされた `openDiffEditor` への参照 |
| `openCompareEditor` | エクスポートされた `openCompareEditor` への参照 |
| `openAgentTasksTab` | エクスポートされた `openAgentTasksTab` への参照 |
| `openMarkdownResult(title, md)` | AI結果をMarkdownタブとして開く |
| `getCurrentView` | エクスポートされた `getCurrentView` への参照 |
| `refreshExplorer` | ファイルツリーを強制更新 |
| `toggleViewMode` | ビューモードの切替 |
| `getDiagnostics` | 現在のビューから診断情報を取得 |
| `reloadFileSilently(path, newContent)` | ウォッチャーをトリガーせずにファイル内容を再読み込み |

## window.Editor で公開されるメソッド

`formatCurrentFile`、`renderEditor`、`renderTabs`、`openFile`、`saveCurrentFile`、`compareWithFile`、`compareWithDisk`

## 依存関係

| モジュール | 目的 |
|--------|---------|
| `Constants.js` | DOM要素参照（`EL`） |
| `Store.js` | アプリケーション状態（`State`） |
| `FileSystem.js` | ファイル読み書き、統計、パスユーティリティ |
| `Explorer.js` | ツリー更新のための `loadExplorer` |
| `ContextMenu.js` | 右クリックコンテキストメニュー |
| `CodeFormatter.js` / `AsyncFormatter.js` | コードフォーマット |
| `TabSearch.js` | タブ検索モーダル |
| `ShortcutManager.js` | ショートカット登録 |
| `ShortcutDefinitions.js` | ショートカット定義 |
| `PluginManager.js` | ビュープラグイン解決 |
| `ViewPlugins.js` | デフォルトプラグイン初期化 |
| `CodeMirrorView.js` | CodeMirror 6エディタビュー |
| `LargeFileEditView.js` | 巨大ファイルのrope対応編集 |
| `MarkdownView.js` | Markdownエディタ/プレビュー |
| `StructureView.js` | 構造（ツリー）ビュー |
| `CsvView.js` | CSVテーブルビュー |
| `DiffEditor.js` | サイドバイサイドdiffエディタ |
| `CompareView.js` | フリーフォームテキスト比較 |
| `TaskNotificationPanel.js` | AIタスクパネル |
| `@tauri-apps/api/core` | Tauri invoke |
| `@tauri-apps/plugin-clipboard-manager` | システムクリップボードアクセス |
| `@tauri-apps/plugin-dialog` | ネイティブ保存/開くダイアログ |
| `@tauri-apps/plugin-fs` | ファイルシステムウォッチャー |
