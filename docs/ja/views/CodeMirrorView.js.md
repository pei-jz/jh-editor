# CodeMirrorView.js — CodeMirror 6メインコードエディタ

## 概要
JHEditorのメインコードエディタビュー。CodeMirror 6を使用し、12以上の言語のシンタックスハイライト、LSP補完/ホバー/診断、検索/置換、ブックモード、空白文字可視化を提供します。

## ファイル情報
- **パス**: `src/modules/views/CodeMirrorView.js`（1177行）
- **依存**: `@codemirror/*`, `page-flip`, `Store.js`, `SyntaxHighlighter.js`, `CMHighlighter.js`, `LspClient.js`, `InlineAI.js`, `Navigation.js`

## クラス: `CodeMirrorView`

## 主要メソッド

| メソッド | 説明 |
|---------|------|
| `render(content, file)` | CM6エディタまたはブックモードを描画 |
| `_renderEditor(content)` | CM6エディタの全拡張機能セットアップ |
| `_renderBookMode(content)` | page-flipライブラリ使用のページフリッパー |
| `_getLanguageExtension(path)` | ファイル拡張子→CM6言語パックマッピング |
| `_lspCompletionSource(ctx)` | LSP補完ソース |
| `_lspHoverTooltip()` | LSPホバーツールチップ |
| `_updateDiagnostics(diagnostics)` | LSP診断をCM6形式に変換 |
| `performSearch(query, ...)` | 検索統合 |
| `replaceNext/ReplaceAll(...)` | 置換操作 |
| `undo()/redo()` | CM6履歴による元に戻す/やり直し |
| `copy()/cut()/paste()` | クリップボード操作 |
| `getStatusInfo()` | `{line, col, selectionLength}` 返却 |
| `jumpToLine(lineIndex)` | 行にジャンプ |
| `setWhitespace()` | 空白文字マーカートグル |
| `destroy()` | CM6状態を`file._cmStateJSON`に保存 |

## 対応言語（言語マッピング）

`js`, `jsx`, `ts`, `tsx`, `html`, `css`, `scss`, `less`, `json`, `xml`, `xsd`, `wsdl`, `svg`, `java`, `py`, `md`, `sql`, `c`, `cpp`, `h`, `hpp`, `rs`, `yaml`, `yml`

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| `State.plainTextViewMode === 'book'` | ブックモード（page-flip）で描画 |
| `State.plainTextViewMode === 'edit'` | 通常のCM6エディタで描画 |
| Ctrl+クリック | `Navigation.handleNavigation()`で定義ジャンプ |
| ファイルに保存済みCM6状態あり | 状態復元 |
| ファイルサイズ > 閾値 | 診断を制限 |
