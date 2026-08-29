# CodeFormatter.js — 同期コードフォーマッタ

JSON/XML/HTML/SQL/Cスタイル言語の同期コードフォーマッタ。

**パス**: `src/modules/utils/CodeFormatter.js`（140行）

| メソッド | 説明 |
|---------|------|
| `format(content, type)` | タイプに応じてフォーマッタにルーティング |
| `formatJSON(content)` | JSONパース→2スペースインデント |
| `formatXML(content)` | 正規表現ベースXMLインデント |
| `formatSQL(content)` | SQLキーワード大文字化＋インデント |
| `formatCStyle(content)` | 文字列/コメントマスク→正規化→復元 |

分岐: json→formatJSON, xml/html→formatXML, sql→formatSQL, java/js/ts→formatCStyle, その他→そのまま返却