# CMHighlighter.js — CodeMirror Lezerシンタックスハイライト

CodeMirror 6のLezerパーサーと`highlightTree`を使用したシンタックスハイライトエンジンです。

**パス**: `src/modules/utils/CMHighlighter.js`（191行）

| 関数 | 説明 |
|------|------|
| `highlightCode(code, langExt)` | コードをHTMLにシンタックスハイライト |

対応言語: JS/TS, HTML/CSS, JSON/XML/YAML, Java, Python, SQL, C/C++, Rust, Markdown

分岐: 言語サポートなし→`escapeHtml()`でプレーンテキスト返却