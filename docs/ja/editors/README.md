# エディタモジュール — ドキュメント索引

特殊ファイル形式向けのエディタコンポーネント群です。

| ファイル | 説明 |
|---------|------|
| [CompareView.js.md](./CompareView.js.md) | ファイル非依存テキスト比較ワークスペース |
| [CsvEditor.js.md](./CsvEditor.js.md) | 仮想化CSV/スプレッドシートエディタ（MVCアーキテクチャ） |
| [DiffEditor.js.md](./DiffEditor.js.md) | 分割/インライン差分ビューア（accept/reject付き） |
| [StructureEditor.js.md](./StructureEditor.js.md) | 汎用ツリーエディタ（XML/JSON向け） |
| [TableEditor.js.md](./TableEditor.js.md) | Markdownテーブルビジュアルエディタ |
| [Vim.js.md](./Vim.js.md) | Markdownブロック向けVim風モーダル編集 |

## モジュール間依存関係

```
CompareView → DiffEditor
DiffEditor → ShikiHighlighter, diff (npm)
CsvEditor → VirtualScroll, ShortcutManager, ContextMenu, AsyncCsvParser
StructureEditor → clipboard (Tauri)
TableEditor → (なし)
Vim → Store, Editor, Explorer, Hints
```