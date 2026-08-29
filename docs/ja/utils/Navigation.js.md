# Navigation.js — ファイル内ナビゲーション

## 概要
`Navigation`は定義ジャンプ、参照検索などのファイル内ナビゲーション機能を提供します。

## ファイル情報
- **パス**: `src/modules/utils/Navigation.js`（8.2KB）
- **依存**: `@tauri-apps/api/core`(invoke), `Store.js`, `Editor.js`

## 主要関数

| 関数 | 説明 |
|------|------|
| `handleNavigation(type, params)` | ナビゲーション操作のディスパッチャ |
| `goToDefinition(file, position)` | 定義へジャンプ |
| `findReferences(file, position)` | 参照検索 |
