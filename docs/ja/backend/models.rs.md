# models.rs — 共有データモデル

Rust側の共有データ構造体を定義します。

**パス**: `src-tauri/src/models.rs`（35行）

| 構造体 | フィールド | 説明 |
|--------|-----------|------|
| `FileEntry` | `name, is_directory, path` | ファイル/ディレクトリ |
| `SearchProgress` | `scanned, found, current_path, total, search_id` | 検索進捗 |
| `FileContent` | `content, encoding` | デコード済みファイル内容 |
| `StructuredNode` | `id, node_type, key, value, children, lazy` | 再帰ツリーノード |

すべて`Debug, Clone, Serialize, Deserialize`をderive。`StructuredNode`の`node_type`はJSONフィールド名`type`にリネーム。