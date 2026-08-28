# SyntaxHighlighter.js — 統合シンタックスハイライト入口

Shiki/CMHighlighterへの統合エントリポイント。

**パス**: `src/modules/utils/SyntaxHighlighter.js`（715B）

| 関数 | 説明 |
|------|------|
| `init()` | Shiki初期化 |
| `highlight(code, lang)` | 言語に応じて最適なハイライターを選択 |

分岐: Shiki初期化済み→Shiki使用、未初期化→CMHighlighterにフォールバック