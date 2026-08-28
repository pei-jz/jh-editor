# ShikiHighlighter.js — Shiki Syntax Highlighting

Provides Shiki-based syntax highlighting used by DiffEditor etc.

**Path**: `src/modules/utils/ShikiHighlighter.js` (3.9KB)

| Function | Description |
|----------|-------------|
| `highlight(code, lang)` | Highlight via Shiki |
| `escapeHtml(text)` | HTML escape |

Branch: Highlight failure → fallback to `escapeHtml()`