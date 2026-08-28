# CMHighlighter.js — CodeMirror Lezer Syntax Highlighting

Syntax highlighting engine using CodeMirror 6's Lezer parser and `highlightTree`.

**Path**: `src/modules/utils/CMHighlighter.js` (191 lines)

| Function | Description |
|----------|-------------|
| `highlightCode(code, langExt)` | Highlight code to HTML |

Supported: JS/TS, HTML/CSS, JSON/XML/YAML, Java, Python, SQL, C/C++, Rust, Markdown

Branch: No language support → return `escapeHtml()` plain text