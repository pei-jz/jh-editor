# Parser.worker.js — 構造化データ解析ワーカー

Web WorkerでXML/JSON/HTML解析を実行します。

**パス**: `src/modules/workers/Parser.worker.js`（942B）

メッセージ受信→typeに応じてXmlParser/JsonParser/HtmlParser呼び出し→結果返却。共通Workerパターン使用。