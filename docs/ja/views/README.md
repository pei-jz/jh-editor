# ビューモジュール — ドキュメント索引

ファイル表示・編集ビューのコンポーネント群です。

| ファイル | 説明 |
|---------|------|
| [BaseView.js.md](./BaseView.js.md) | 抽象基底クラス（ビューインターフェース定義） |
| [CodeMirrorView.js.md](./CodeMirrorView.js.md) | CodeMirror 6使用メインコードエディタ |
| [CsvView.js.md](./CsvView.js.md) | CSVファイル表示ビュー（CsvEditorへの委譲） |
| [LargeFileEditView.js.md](./LargeFileEditView.js.md) | 巨大ファイル編集ビュー（ロープ+スライディングウィンドウ） |
| [LargeFileView.js.md](./LargeFileView.js.md) | 巨大ファイル専用表示・検索・集計ビューア |
| [MarkdownView.js.md](./MarkdownView.js.md) | Markdownライブプレビュービュー |
| [StructureView.js.md](./StructureView.js.md) | 構造化データツリービュー |

## ビュー階層

```
BaseView (抽象基底クラス)
  ├─ CodeMirrorView (CodeMirror 6エディタ)
  ├─ CsvView (→ CsvEditor委譲)
  ├─ MarkdownView (ライブプレビュー)
  ├─ StructureView (ツリー表示)
  └─ (独立)
      ├─ LargeFileView (巨大ファイル読み取り専用)
      └─ LargeFileEditView (巨大ファイル編集)
```