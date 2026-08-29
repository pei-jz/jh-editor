# AsyncFormatter.js — 非同期コードフォーマット

Web Worker経由の非同期コードフォーマット。

**パス**: `src/modules/utils/AsyncFormatter.js`（79行）

| 関数 | 説明 |
|------|------|
| `formatAsync(content, type)` | Workerで非同期フォーマット、失敗時は同期フォールバック |

Worker不可用時は`CodeFormatter.js`にダイナミックimportでフォールバック。