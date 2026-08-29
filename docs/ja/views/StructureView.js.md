# StructureView.js — 構造化データツリービュー

## 概要
XML/JSON/HTMLなどの構造化データをツリー形式で表示するビューです。StructureEditorとの統合と、非構造化データへのフォールバックを提供します。

## ファイル情報
- **パス**: `src/modules/views/StructureView.js`（38.6KB）
- **依存**: `StructureEditor`, `HtmlParser`, `JsonParser`, `XmlParser`

## 主要機能

| 機能 | 説明 |
|------|------|
| ツリー表示 | 構造化データのツリー描画 |
| ファイルタイプ検出 | XML/JSON/HTMLを自動判別 |
| 遅延ロード | 大規模データの遅延解析 |
| 編集モード | StructureEditorによる直接編集 |
| シリアライズ | ツリー→XML/JSON/HTML変換 |
| テキストモード切替 | プレーンテキスト表示への切替 |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| `getStructureType()`が`'xml'` | XmlParser使用 |
| `getStructureType()`が`'json'` | JsonParser使用 |
| `getStructureType()`が`'html'` | HtmlParser使用 |
| 解析エラー | テキストモードにフォールバック |
| データサイズ大 | 遅延ロード有効化 |
