# ViewPlugins.js — 組み込みビュープラグイン登録

## 概要
`ViewPlugins.js`はJHEditorのすべての組み込みビュープラグインを`PluginManager`に登録します。

## ファイル情報
- **パス**: `src/modules/core/ViewPlugins.js`（55行）
- **依存**: `PluginManager.js`, `CodeMirrorView.js`, `MarkdownView.js`, `StructureView.js`, `CsvView.js`

## エクスポート関数

### `initDefaultPlugins(context: Object): void`
デフォルトのビュープラグインを登録します。

## 登録プラグイン一覧

| ID | ビュークラス | 対応拡張子 | モード | 優先度 |
|----|-------------|-----------|--------|--------|
| `markdown` | `MarkdownView` | `md`, `markdown` | `structure` | 10 |
| `csv` | `CsvView` | `csv` | `structure` | 10 |
| `structure` | `StructureView` | `xml`, `json`, `html`, `xsd`, `wsdl`, `htm` | `structure` | 10 |
| `plain` | `CodeMirrorView` | `txt`, `log`, `java`, `js`, `javascript`, `ts`, `typescript`, `sql`, `css`, `json`, `xml`, `html`, `md`, `markdown`, `''` | `text` | 1 |

## 分岐ロジック

### `structure`プラグインの`getStructureType()`

| 条件 | 戻り値 |
|------|--------|
| `.xml`, `.xsd`, `.wsdl` | `'xml'` |
| `.html`, `.htm` | `'html'` |
| それ以外 | `'json'` |

### 解決の優先度

- `priority: 10`（structure, markdown, csv） > `priority: 1`（plain）
- 同一優先度の場合、登録順で`markdown` → `csv` → `structure` → `plain`の順にマッチ
- `plain`は最低優先度のフォールバックとして機能し、ほぼすべてのファイル拡張子をカバー