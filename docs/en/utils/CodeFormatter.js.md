# CodeFormatter.js — Synchronous Code Formatter

JSON/XML/HTML/SQL/C-style code formatter.

**Path**: `src/modules/utils/CodeFormatter.js` (140 lines)

| Method | Description |
|--------|-------------|
| `format(content, type)` | Route to appropriate formatter |
| `formatJSON(content)` | Parse → 2-space indent |
| `formatXML(content)` | Regex-based XML indent |
| `formatSQL(content)` | Uppercase keywords + indent |
| `formatCStyle(content)` | Mask strings/comments → normalize → restore |

Branch: json→formatJSON, xml/html→formatXML, sql→formatSQL, java/js/ts→formatCStyle, default→return as-is