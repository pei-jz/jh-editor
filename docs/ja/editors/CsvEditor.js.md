# CsvEditor.js — 仮想化CSV/スプレッドシートエディタ

## 概要
`CsvEditor.js`はMVCアーキテクチャのCSV/スプレッドシートエディタです。VirtualScrollによる仮想化、Excelライクなキーボードナビゲーション、行/列操作を提供します。

## ファイル情報
- **パス**: `src/modules/editors/CsvEditor.js`（1957行）
- **依存**: `VirtualScroll`, `ShortcutManager`, `ShortcutDefinitions`, `ContextMenu`, `AsyncCsvParser`, `@tauri-apps/plugin-clipboard-manager`

## クラス

### `CsvModel`
CSVデータの管理モデル。

| メソッド | 説明 |
|---------|------|
| `constructor(content, existingLineEnding)` | コンテンツ解析、行末文字検出 |
| `parse(content, detectLineEnding)` | CSV文字列を2次元配列に解析 |
| `serialize()` | 2次元配列をCSV文字列にシリアライズ |
| `getValue(r, c)` / `setValue(r, c, val)` | セル値の取得/設定 |
| `insertRow(index)` / `insertCol(index)` | 行/列挿入 |
| `insertRows(index, matrix)` / `insertCols(index, matrix)` | 複数行/列の貼り付け |
| `deleteRow(index)` / `deleteCol(index)` | 行/列削除 |
| `transpose()` | 行列転置 |
| `sort(colIndex, ascending)` | 列ソート |
| `undo()` / `redo()` | アンドゥ/リドゥ（履歴50ステップ） |

### `CsvController`
ユーザー入力と操作の制御。（内部クラス）

| メソッド | 説明 |
|---------|------|
| `handleCellDown/Over/DblClick()` | マウス操作 |
| `startEditing()` / `finishEditing()` | セル編集 |
| `moveSelection(dr, dc)` | 選択移動 |
| `copy/cut/paste()` | クリップボード操作 |
| `insertCopiedRows/Cols()` | コピー行/列の挿入 |
| `sortColumn()` | 列ソート |
| `handleShortcut()` | ショートカット処理 |
| `startJump()` / `executeJump()` | Vim風ジャンプ |
| `handleContextMenu()` | 右クリックメニュー |

### `CsvView`（内部）
仮想スクロール付きビューレイヤー。
- 行/列の仮想化
- カラム幅の自動計算
- リサイズ対応

### `CsvEditor`（シングルトン）
CSVエディタのグローバルインスタンス。
- `render(content, file)`: エディタを描画
- `activeInstance`: 現在アクティブなインスタンス

## キーボード操作

| キー | 処理 |
|------|------|
| 矢印キー | セル移動 |
| `Shift+矢印` | 範囲選択 |
| `Ctrl+矢印` | ジャンプ |
| `F2` / `Enter` | セル編集開始 |
| `Tab` / `Shift+Tab` | 次/前セル |
| `Delete` / `Backspace` | セル内容削除 |
| `Alt+;` / `Alt+-` | 行追加/削除 |
| `Alt+Shift+;` / `Alt+Shift+-` | 列追加/削除 |
| `Ctrl+Shift+;` | コピー行の貼り付け |
| `Ctrl+Alt+V` | コピー列の貼り付け |
| `j` | ジャンプモード開始 |
