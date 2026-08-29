# ShikiHighlighter.js — Shikiシンタックスハイライト

Shikiを使用したシンタックスハイライトを提供します。DiffEditor等で使用されます。

**パス**: `src/modules/utils/ShikiHighlighter.js`（3.9KB）

| 関数 | 説明 |
|------|------|
| `highlight(code, lang)` | Shikiでシンタックスハイライト |
| `escapeHtml(text)` | HTMLエスケープ |

分岐: ハイライト失敗→`escapeHtml()`でフォールバック