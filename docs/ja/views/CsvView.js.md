# CsvView.js — CSVファイル表示ビュー

## 概要
CSVファイルの表示ビューです。CsvEditorへの委譲で動作します。

## ファイル情報
- **パス**: `src/modules/views/CsvView.js`（95行）
- **依存**: `BaseView`, `CsvEditor`

## クラス: `CsvView extends BaseView`

## メソッド

| メソッド | 説明 |
|---------|------|
| `render(content, file)` | CsvEditor.render()に委譲 |
| `copy/cut/paste()` | CsvEditor.activeInstanceに委譲 |
| `handleShortcut(command, e)` | CsvEditorに委譲 |
| `isCsvGridMode()` | CSVエディタがグリッドモードか |
| `undo()/redo()` | CsvEditor.modelの履歴を使用 |
| `destroy()` | CsvEditorインスタンス破棄 |
| `getDiagnostics()` | 空配列返却 |
