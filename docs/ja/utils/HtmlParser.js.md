# HtmlParser.js — HTML構造解析

HTMLをツリー構造に解析します。

**パス**: `src/modules/utils/HtmlParser.js`（5.1KB）

| 関数 | 説明 |
|------|------|
| `parseHtml(content)` | HTML文字列をStructuredNodeツリーに変換 |

構造化データツリー（`{id, key, value, type, children}`）を生成。StructureViewで使用。