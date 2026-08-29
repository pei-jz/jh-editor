# ShortcutManager.js — ショートカット管理とスコープ検出

## 概要
`ShortcutManager.js`はキーボードショートカットのロード、スコープ検出、keydownイベント処理を担当するクラスです。ユーザーのカスタムショートカットオーバーライドに対応しています。

## ファイル情報
- **パス**: `src/modules/core/ShortcutManager.js`（207行）
- **依存**: `Store.js`(State), `ShortcutDefinitions.js`(SHORTCUTS)

## クラス: `ShortcutManager`

### コンストラクタ
```javascript
constructor()
```
- `this.shortcuts: Array` — マージ済みショートカットリスト
- `this.currentScope: string` — 現在のスコープ（デフォルト`'GLOBAL'`）
- `this.scopes: string[]` — 利用可能なスコープ一覧

### メソッド

#### `loadShortcuts(): void`
ショートカットをロードし、デフォルト値とlocalStorageのユーザーオーバーライドをマージします。
- **分岐**: `overrides[s.id]`が存在する場合、そのオーバーライドを適用

#### `updateShortcut(id: string, newMapping: Object): void`
特定のショートカットマッピングを更新し、永続化します。
- localStorageに保存
- `shortcutsChanged`カスタムイベントを発行

#### `resetToDefaults(): void`
すべてのショートカットをデフォルトに戻します。
- `user_shortcuts`をlocalStorageから削除

#### `register(shortcut: Object): void`
ランタイムでショートカットを登録します。
- **分岐**: 同一`cmd`+`scope`の既存ショートカットがあれば`action`を更新、なければ新規追加

#### `unregisterScope(scope: string): void`
指定スコープのすべてのショートカットを削除します。

#### `setScope(scope: string): void`
アクティブスコープを設定します。
- **分岐**: `scope`が有効なスコープリストに含まれる場合のみ設定

#### `setupListeners(): void`
keydownイベントリスナーとスコープ自動検出を設定します。

### スコープ自動検出ロジック（`focusin`/`mousedown`）

| ターゲット要素 | スコープ |
|---------------|----------|
| `.visual-table-editor`内 | `MARKDOWN_TABLE` |
| `#explorer-list-container`内 | `EXPLORER` |
| `.csv-grid-virtual-container`内（INPUT/TEXTAREA） | `CSV_EDIT` |
| `.csv-grid-virtual-container`内（その他） | `CSV` |
| `.md-block`内（TEXTAREA/contentEditable） | `EDITOR` |
| `.md-block`内（その他） | `MARKDOWN_BLOCK` |
| `.plain-text-editor`/`.block-editor`内 | `EDITOR`（条件付き） |
| `#search-panel`内 | `SEARCH` |
| `.ai-review-overlay`内 | `AI_REVIEW` |
| `.node-source-editor`/`.structure-editor`内 | `STRUCTURE_EDIT` |
| それ以外 | `GLOBAL`（`AI_REVIEW`から遷移した場合はスキップ） |

#### `handleKeyDown(e: KeyboardEvent): void`
キーダウンイベントを処理します。

**分岐ロジック**:
1. `window._isRecordingShortcut`が`true`ならスキップ（設定画面でのキー記録中）
2. `SEARCH`スコープの場合、Ctrl+F/Ctrl+H以外はすべてスキップ（検索パネルに処理を委譲）
3. キー、修飾子、スコープで一致するショートカットを検索
4. 優先順位: 現在のスコープ > GLOBAL
5. **特別処理**:
   - クリップボード系（copy/paste/cut）: INPUT/TEXTAREA内の通常入力時はブラウザに委譲
   - `MARKDOWN_TABLE`スコープ: クリップボード系はスキップ
   - `app:toggle-view-mode`: キーリピート時はスキップ
6. `action`が関数なら直接実行、`cmd`があるなら`shortcutTriggered`イベントを発行

## エクスポート
- `shortcuts` — シングルトンインスタンス
