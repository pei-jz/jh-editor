# Explorer.js ドキュメント

## ファイルの目的

`Explorer.js` は JHEditor の**ファイルツリー探索モジュール**です。約1290行で、`VirtualScroll` を使用した高性能な仮想化ファイルツリーを実装しています。以下を担当します：
- 遅延読み込みとキャッシュによるファイル/ディレクトリツリーのレンダリング
- ファイルとディレクトリの操作（新規、名前変更、削除、コピー、カット、ペースト）
| キーボードナビゲーション（矢印キー、Enter、Delete、F2、Ctrl+N/C/X/V） |
- ディレクトリ間のファイル移動のドラッグ＆ドロップ
- コンテンツ検索オプション付きのファイル検索（進捗報告付き）
- ファイルとフォルダのGitステータスインジケータ
- ファイル操作用のコンテキストメニュー
- エクスプローラースコープのキーボードショートカット

## モジュールレベルの状態

| 変数 | 型 | 説明 |
|----------|------|-------------|
| `openFileCallback` | `function \| null` | エディタでファイルを開くためのコールバック |
| `closeFileCallback` | `function \| null` | パスでファイルタブを閉じるためのコールバック |
| `closeFilesUnderDirCallback` | `function \| null` | ディレクトリ配下のすべてのタブを閉じるためのコールバック |
| `clipboardAction` | `object \| null` | 現在のクリップボード状態 `{ type: 'copy'\|'cut', paths: string[] }` |
| `vExplorer` | `VirtualExplorer \| null` | シングルトンのVirtualExplorerインスタンス |
| `lastSearchTerm` | `string` | キャッシュ用の最後の検索語 |
| `lastSearchContentFlag` | `boolean` | キャッシュ用の最後のコンテンツ検索フラグ |
| `cachedMatches` | `array \| null` | キャッシュされた検索結果 |

## クラス

### `VirtualExplorer`

表示されている行のみをレンダリングする高性能な仮想化ツリービューアです。

**コンストラクタ：** `new VirtualExplorer(container)`

| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `container` | `HTMLElement` | ファイルツリーのDOMコンテナ |

**プロパティ：**
| プロパティ | 型 | 説明 |
|----------|------|-------------|
| `flatItems` | `Array` | フラット化された表示中ツリーアイテムのリスト |
| `dirCache` | `Map<string, Array>` | パスをキーとしたディレクトリエントリのキャッシュ |
| `selectedPaths` | `Set<string>` | 現在選択されているファイル/フォルダのパス |
| `focusedIndex` | `number` | キーボードフォーカス中のアイテムのインデックス |
| `lastClickedIndex` | `number` | 最後にマウスクリックされたアイテムのインデックス（Shift+クリック範囲用） |
| `rowHeight` | `number` | 固定行高（ピクセル単位、26px） |
| `gitStatus` | `object` | Gitステータスセット：`{ staged, modified, untracked, folderStaged, folderModified, folderUntracked }` |
| `scroller` | `VirtualScroll` | 仮想スクロールインスタンス |
| `contentHost` | `HTMLElement` | 仮想スクロール用の高さスペーサー |

**主要メソッド：**

#### `handleKeyDown(e)`
エクスプローラー内のキーボードナビゲーションを処理します：
| キー | アクション |
|-----|--------|
| `ArrowDown` | フォーカスを下に移動 |
| `ArrowUp` | フォーカスを上に移動 |
| `ArrowRight` | ディレクトリを展開するか最初の子要素に移動 |
| `ArrowLeft` | ディレクトリを折りたたむか親に移動 |
| `Enter` | ディレクトリ切替 / ファイルを開く |
| `Delete` | 選択されたアイテムを削除 |
| `Ctrl+C` | コピー |
| `Ctrl+X` | カット |
| `Ctrl+V` | ターゲットディレクトリにペースト |
| `Ctrl+N` | フォーカス中のディレクトリに新規ファイル |
| `Tab` / `Shift+Tab` | エディタにフォーカスを移動 |

#### `setFocus(index)`
特定のアイテムにキーボードフォーカスを設定します。アイテムがスクロールで表示されるよう確保します。

#### `setRoot(rootPath)`
ルートディレクトリを設定し、ツリーをリフレッシュします。

#### `destroy()`
リスナーを破棄してコンテナを空にします。`initExplorer()` が再実行される際に呼ばれ、**古いインスタンスの VirtualScroll が同じコンテナを監視し続けてツリーが二重表示になる問題**を防ぎます。

#### `setData(flatItems)`
フラットアイテムリスト全体を置換し、フォーカスをリセットします。検索モードで使用されます。

#### `refresh()`
ルートパスと展開状態からフラット化されたツリーを再構築します。リフレッシュ中にフォーカスを保持します。

**世代ガード（generation guard）:** `refresh()` は非同期（ディレクトリ読み込みを await）のため、素早い展開/折りたたみ・Gitステータス更新・複数選択クリックが重なると、`buildFlatList` の push が同じ `flatItems` 配列に**インターリーブされて行が二重になる**ことがありました。現在は `_refreshGen` カウンタで古いビルドを無効化し、新しいリフレッシュに追い越された場合は即座に中断します。

#### `buildFlatList(dirPath, level, gen)`
ディレクトリを読み取り、`State.expandedFolders` のフォルダのみ展開して、フラット化されたツリーを再帰的に構築します。`gen` が現在の世代と一致しない場合は中断して `false` を返します（二重push防止）。

#### `sortEntries(entries)`
ディレクトリエントリをソートします：ディレクトリが先、その後アルファベット順（大文字小文字区別なし）。

#### `render({ startIndex, endIndex, offsetY, totalHeight })`
表示されている行のみをレンダリングします。スクロールイベント時にVirtualScrollから呼び出されます。**contentHost はコンストラクタで一度だけアタッチされ、render() 内では再アタッチしません**（古いインスタンスがダングリングホストを再アタッチして二重表示になるのを防ぐため）。

#### `toggle(item)`
ディレクトリを展開または折りたたみます。`State.expandedFolders` を更新し、ツリーをリフレッシュします。

#### `startRenaming(div, item, labelSpan)`
インライン名前変更：ラベルを入力フィールドに置き換えます。Enter/blurで：`FS.rename()` で名前変更を確定。Escapeで：キャンセル。

#### `attachEvents(div, item)`
ツリーロウにドラッグ、コンテキストメニュー、ドロップイベントハンドラをアタッチします。

#### `showMessage(text)` / `showProgress(scanned, total, found, path, percent)` / `clearMessage()`
エクスプローラーパネルにステータスメッセージとプログレスバーを表示します。

#### `createRow(item, index)`
以下の内容を含むツリーアイテムの単一DOM行を作成します：
- ディレクトリ用の矢印トグル
- ファイル/フォルダアイコン
- GitステータスCSSクラス（staged、modified、untracked）
- 選択およびフォーカスのスタイリング
- クリックハンドラ（単一、Ctrl+、Shift+）
- ドラッグ＆ドロップ設定

## エクスポート関数

### `initExplorer(openCallback, cbObj)`
**目的：** エクスプローラーモジュールを初期化します。

**パラメータ：**
| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `openCallback` | `function` | エディタでファイルを開くためのコールバック |
| `cbObj` | `object` | `{ closeFileByPath, closeFilesUnderDir }` コールバック |

**ロジック：**
1. コールバックを保存
2. `#file-list` コンテナに `VirtualExplorer` インスタンスを作成（**既存インスタンスがあれば先に `destroy()`**）
3. EXPLORERスコープのショートカットを登録
4. 800msデバウンス付きの検索入力を設定
5. 空白エリアのコンテキストメニューを設定

### `loadExplorer(forceRefresh?)`
**目的：** エクスプローラーツリーを再読み込みします。

**パラメータ：**
| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `forceRefresh` | `boolean` | trueの場合、ディレクトリキャッシュをクリア |

**ロジック：**
- 検索語がアクティブな場合は、フィルターされたツリーをレンダリング
- それ以外は、メッセージをクリアし `vExplorer.setRoot()` を呼び出す

### `focusExplorer()`
**目的：** キーボードフォーカスをエクスプローラーリストコンテナに移動します。

### `showExplorerStatus(scanned, total, found, path, percent)`
**目的：** `vExplorer.showProgress()` に委任してスキャン進捗を表示します。

### `clearExplorerStatus()`
**目的：** `vExplorer.clearMessage()` に委任してステータスメッセージを非表示にします。

## 内部関数

### `renderFilteredTree(rootDir, term, searchContent?)`
**目的：** `term` に一致するファイルを検索し、フィルターされたツリーをレンダリングします。

**ロジック：**
1. 同一クエリの検索キャッシュを確認
2. `FS.onSearchProgress` Tauriイベントで進捗を表示
3. 実際の検索に `FS.searchFiles()` を呼び出す
4. フラットな検索結果からツリー構造を構築
5. 一致を含むすべてのディレクトリを自動展開
6. フィルターされたフラットアイテムでVirtualExplorerを更新

### `registerExplorerShortcuts()`
EXPLORERスコープのショートカットを登録します：
| コマンド | アクション |
|---------|--------|
| `explorer:nav` | `vExplorer.handleKeyDown()` に委任 |
| `explorer:rename` | フォーカス中のアイテムのインライン名前変更を開始 |
| `explorer:new-file` | フォーカス中のディレクトリに新規ファイルを作成 |

### ファイル操作ハンドラ

| 関数 | 説明 |
|----------|-------------|
| `handleNewFile(dir)` | 新規ファイルモーダルを表示、空ファイルを作成、ツリーを更新 |
| `handleNewFolder(dir)` | 入力ダイアログを表示、ディレクトリを作成 |
| `handleRename(path)` | 入力ダイアログを表示、ファイル/フォルダの名前を変更 |
| `handleDelete(pathOrPaths)` | 確認してファイルを削除、関連タブを閉じる |
| `handleCopy(paths)` | コピー操作をクリップボードに保存 |
| `handleCut(paths)` | カット操作をクリップボードに保存 |
| `handlePaste(targetDir)` | クリップボードからペースト（コピーまたはカット）またはシステムクリップボードから |
| `handleDropEvent(e, targetDir)` | 自己ドロップ防止付きのファイル移動を処理 |

## イベントハンドラ

| イベント | 場所 | 説明 |
|-------|----------|-------------|
| `git-status-updated` | VirtualExplorerコンストラクタ | Gitステータスセットを更新し再レンダリングをトリガー |
| コンテナの `keydown` | VirtualExplorer | キーボードナビゲーション |
| コンテナの `focus` / `blur` | VirtualExplorer | エクスプローラーヘッダーのアクティブ状態を更新 |
| 検索入力の `input` | initExplorer | 800msデバウンス検索 |
| 検索入力の `keydown` | initExplorer | ArrowDownでツリーにフォーカス移動 |
| エクスプローラーの `contextmenu` | initExplorer | 空白エリアのコンテキストメニュー |
| ツリーアイテムの `dragstart` | attachEvents | マルチアイテムドラッグの設定 |
| ツリーアイテムの `dragover` | attachEvents | ドロップターゲットの検証 |
| ツリーアイテムの `dragleave` | attachEvents | ドロップハイライトの解除 |
| ツリーアイテムの `drop` | attachEvents | ファイル移動の実行 |
| ツリーアイテムの `contextmenu` | attachEvents | ファイル操作付きのアイテムコンテキストメニュー |
| ツリーアイテムの `click` | createRow | 選択、展開、ファイルを開く |
| ツリーアイテムの `keydown` | createRow | F2で名前変更、Ctrl+Nで新規ファイル |

## 依存関係

| モジュール | 目的 |
|--------|---------|
| `Constants.js` | DOM要素参照（`EL`） |
| `Store.js` | アプリケーション状態（`State`） |
| `FileSystem.js` | ファイル操作、パスユーティリティ、検索 |
| `VirtualScroll.js` | 仮想スクロールエンジン |
| `ContextMenu.js` | 右クリックコンテキストメニュー |
| `Modal.js` | カスタム入力/確認/新規ファイルモーダル |
| `ShortcutManager.js` | ショートカット登録 |
| `ShortcutDefinitions.js` | ショートカット定義 |
| `@tauri-apps/plugin-dialog` | ネイティブ保存ダイアログ |
