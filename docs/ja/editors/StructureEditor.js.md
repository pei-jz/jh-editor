# StructureEditor.js — 汎用ツリーエディタ

## 概要
XML/JSONなどの構造化データに対する汎用ツリーベースエディタ。仮想化レンダリング、アンドゥ/リドゥ。

## ファイル情報
- **パス**: `src/modules/editors/StructureEditor.js`（699行）
- **依存**: `@tauri-apps/plugin-clipboard-manager`

## コンストラクタ
```javascript
constructor(container, model, onUpdate, onSelectionChange, options)
```

## ノード構造
```javascript
{ id, key, value, type, children, lazy }
```

## 主要メソッド

| メソッド | 説明 |
|---------|------|
| `mount()` | DOM構築、イベントバインド |
| `render()` | ツリー再描画 |
| `undo()/redo()` | アンドゥ/リドゥ（50ステップ） |
| `select(nodeId)` | ノード選択 |
| `startEditing(nodeId, field)` | 編集開始 |
| `toggleExpand(nodeId)` | 展開/折りたたみ |
| `navigateSelection(delta)` | 選択移動 |
| `copy()` | クリップボードコピー |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| ノードに`children`なし | 折りたたみボタン非表示 |
| `lazy: true` | 展開時に遅延ロード |
| 編集中フィールド=`'key'` | キー編集フィールド表示 |
| 編集中フィールド=`'value'` | バリュー編集フィールド表示 |

## イベントハンドラ

| イベント | 処理 |
|---------|------|
| `click` | ノード選択、展開トグル |
| `dblclick` | 編集開始 |
| `keydown` | 矢印ナビゲーション、Enter/F2で編集、Escapeでキャンセル |
