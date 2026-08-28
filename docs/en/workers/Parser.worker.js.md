# Parser.worker.js — Structured Data Parsing Worker

Runs XML/JSON/HTML parsing in a Web Worker.

**Path**: `src/modules/workers/Parser.worker.js` (942B)

Message receive → call XmlParser/JsonParser/HtmlParser by type → result return. Common Worker pattern.