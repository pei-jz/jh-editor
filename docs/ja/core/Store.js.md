# Store.js — グローバルアプリケーション状態

## 概要
`Store.js`はJHEditorのグローバル可変状態（単一のStateオブジェクト）を定義します。すべてのモジュールがこの`State`をインポートして、アプリケーション全体の状態を共有します。

## ファイル情報
- **パス**: `src/modules/core/Store.js`（32行）
- **依存**: なし

## エクスポート

### `State` オブジェクト

| プロパティ | 型 | 初期値 | 説明 |
|-----------|-----|--------|------|
| `currentDir` | `string` | `'.'` | 現在のワークスペースルートディレクトリ |
| `gitRoot` | `string` | `'.'` | Gitリポジトリルート |
| `gitRepos` | `Array<{name, path}>` | `[]` | ワークスペース内の複数Gitリポジトリ |
| `splitMode` | `boolean\|string` | `false` | 分割ペインモード（`false`または`'horizontal'`） |
| `activePane` | `string` | `'left'` | アクティブペイン（`'left'`または`'right'`） |
| `openFiles` | `Array<{path, content, isDirty}>` | `[]` | 左ペインの開いたファイル一覧 |
| `activeTabIndex` | `number` | `-1` | 左ペインのアクティブタブインデックス |
| `rightOpenFiles` | `Array` | `[]` | 右ペインの開いたファイル一覧 |
| `rightActiveTabIndex` | `number` | `-1` | 右ペインのアクティブタブインデックス |
| `isExplorerVisible` | `boolean` | `true` | エクスプローラー表示状態 |
| `isOutlineVisible` | `boolean` | `false` | アウトライン表示状態 |
| `searchMatches` | `Array` | `[]` | 検索一致結果 |
| `currentMatchIndex` | `number` | `-1` | 現在の一致インデックス |
| `vimState` | `object` | `{mode: 'normal', selectedIndex: -1}` | Vimモード状態 |
| `expandedFolders` | `Set` | `new Set()` | エクスプローラーで展開されたフォルダ |
| `explorerSearchTerm` | `string` | `''` | エクスプローラー検索語 |
| `explorerSearchContent` | `boolean` | `false` | コンテンツ検索モード |
| `aiShowDetailedLogs` | `boolean` | `localStorageから読み込み` | AI詳細ログ表示設定 |
| `ragModelSize` | `string` | `localStorageから読み込み` | RAGモデルサイズ |
| `markdownViewMode` | `string` | `'scroll'` | Markdownビューモード（`'scroll'`または`'book'`） |
| `plainTextViewMode` | `string` | `'edit'` | プレーンテキストビューモード（`'edit'`または`'book'`） |
| `showWhitespace` | `boolean` | `localStorageから読み込み` | CR/LF/TABマーカー表示 |

## 分岐ロジック

- 特に分岐ロジックなし。静的なプロパティ定義のみ。
- localStorageからの初期値読み込みはモジュールロード時に実行。
