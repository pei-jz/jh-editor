# TableEditor.js — Markdownテーブルビジュアルエディタ

## 概要
`TableEditor`はMarkdownテーブルの検出、解析、シリアライズ、インタラクティブなビジュアル編集を提供するシングルトンオブジェクトです。

## ファイル情報
- **パス**: `src/modules/editors/TableEditor.js`（466行）
- **依存**: なし（独立）

## エクスポート

### `TableEditor` シングルトンオブジェクト

## メソッド

### `isSeparatorLine(line: string): boolean`
行がMarkdownテーブルのセパレータ行かどうかを判定します。

### `isTable(text: string): boolean`
テキストがMarkdownテーブルかどうかを判定します。

**分岐ロジック**:
1. 2行未満なら`false`
2. 2行目がセパレータ行なら`true`
3. セパレータがなければ、すべての行にパイプ`|`が含まれるかチェック

### `parse(text: string): Array<Array<string>>`
Markdown文字列を2次元配列に変換します。
- セパレータ行をスキップ
- 先頭/末尾のパイプを除去して分割

### `serialize(data: Array<Array<string>>): string`
2次元配列をMarkdownテーブル文字列に変換します。
- カラム幅を自動計算
- ヘッダー、セパレータ、ボディを生成

### `focusCell(container, row, col, editMode?: boolean): void`
指定セルにフォーカスします。
- `editMode`が`true`なら入力フィールドを表示してフォーカス

### `render(container, data, onChange): void`
インタラクティブなテーブルUIを描画します。

**内部ロジック**:
- `updateSelection(r, c, edit, extend)`: セル選択状態を更新、CSSクラスを適用
- `createCellInstance(r, c, value, isHeader)`: セルDOMを生成
- `handleTableKey(e, r, c)`: キーボード操作処理
- `handleTableCopy/Paste`: クリップボード操作

**キーボード操作**:
| キー | 処理 |
|------|------|
| 矢印キー | セル移動 |
| `Shift+矢印` | 範囲選択 |
| `Alt+;` | 行追加 |
| `Alt+Shift+;` | 列追加 |
| `Alt+-` | 行削除 |
| `Alt+Shift+-` | 列削除 |
| `Ctrl+Space` | 行選択 |
| `Tab` | 右に移動（末尾なら次の行頭、最終行なら新行追加） |
| `Shift+Tab` | 左に移動 |
| `Enter` | 下に移動 |
| `F2` | 編集モード切替 |
| 任意文字 | 編集モードに遷移して入力 |

### `selectRow(container, rowIndex): void`
行を選択/選択解除します（`selected-row`クラスのトグル）。
