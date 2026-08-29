# FileHistoryManager.js — ファイル単位アンドゥ履歴

ファイルパスごとのアンドゥ履歴スナップショットを管理します（最大20件）。

**パス**: `src/modules/utils/FileHistoryManager.js`（53行）

| メソッド | 説明 |
|---------|------|
| `push(path, content)` | スナップショット保存 |
| `pop(path)` | 最新スナップショット取得 |
| `canUndo(path)` | アンドゥ可能か |
| `clear(path)` | 履歴クリア |