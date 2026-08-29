# commands/parser.rs — JSON/XML/HTMLパーサー

構造化データの解析を提供するTauriコマンド群です（328行）。

**パス**: `src-tauri/src/commands/parser.rs`

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `parse_structured_data` | JSON/XML/HTMLをStructuredNodeツリーに解析 |
| `get_node_children` | 遅延読み込みノードの子ノードを取得 |

## 分岐ロジック

- `parse_structured_data`: ファイル拡張子または内容からJSON/XML/HTMLを判定
- `get_node_children`: `lazy: true`のノードの子を遅延生成