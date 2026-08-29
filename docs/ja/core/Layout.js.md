# Layout.js — レイアウト初期化と設定管理

## 概要
`Layout.js`はアプリケーションのレイアウトを初期化し、リサイザー操作、テーマ適用、フォントサイズ管理を担当します。

## ファイル情報
- **パス**: `src/modules/core/Layout.js`（116行）
- **依存**: `Constants.js`(EL), `Store.js`(State), `SettingsModal.js`(applyTheme)

## エクスポート関数

### `setCompactMode(isCompact: boolean): void`
コンパクト表示モードを切り替えます。
- **分岐**: `isCompact`が`true`なら`display-mode-compact`クラス追加、`false`なら削除
- 設定をlocalStorageに保存

### `initLayout(): void`
レイアウトを初期化します。
1. `loadSettings()`でテーマ/フォント/コンパクト設定を復元
2. エクスプローラートグルボタンのイベントリスナー設定
3. `setupResizers()`でリサイザーを初期化
4. Ctrl+マウスホイールでズーム（フォントサイズ変更）を設定

### `saveFontSize(size: string): void`
フォントサイズを保存し、CSSカスタムプロパティを更新します。
- フォントサイズからline-heightを計算：`Math.round(sizePt * 1.33333 * 1.5)`
- `fontSettingsChanged`カスタムイベントを発行

## 内部関数

### `setupResizers(): void`
左ペインリサイザーのドラッグ操作を設定。
- **マウスダウン**: リサイジング開始、カーソル変更
- **マウスムーブ**: 幅を150px〜600pxの範囲で調整
- **マウスアップ**: リサイジング終了

### `loadSettings(): void`
localStorageから設定を読み込み、DOMに適用。
1. テーマ適用（`applyTheme()`）
2. コンパクトモード適用
3. フォントサイズ適用（不正値チェック: 範囲外ならデフォルト`10.5`pt）
4. line-height計算・設定

### `saveSettings(): void`
コンパクトモードの状態をlocalStorageに保存。

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| `isCompact === true` | `display-mode-compact`クラス追加 |
| `isCompact === false` | `display-mode-compact`クラス削除 |
| フォントサイズが不正（NaN, >18, <8） | デフォルト値`10.5`にリセット |
| `e.deltaY < 0`（ホイール上方向） | フォントサイズ+0.5pt（最大30pt） |
| `e.deltaY > 0`（ホイール下方向） | フォントサイズ-0.5pt（最小8pt） |
| リサイザー幅 < 150px | 調整無効 |
| リサイザー幅 > 600px | 調整無効 |
