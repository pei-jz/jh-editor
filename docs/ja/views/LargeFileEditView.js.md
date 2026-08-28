# LargeFileEditView.js — 巨大ファイル編集ビュー

## 概要
巨大ファイルの編集を実現するビューです。「ロープ上のスライディングウィンドウ」手法を使用し、ブラウザには約4000行のウィンドウのみ保持し、Rust側の`ropey::Rope`がソースオブトゥルースとなります。

## ファイル情報
- **パス**: `src/modules/views/LargeFileEditView.js`（446行）
- **依存**: `@tauri-apps/api/core`(invoke)

## 定数
- `WINDOW_LINES = 4000` — ウィンドウ行数
- `RELOAD_MARGIN = 800` — スライド開始マージン

## 主要メソッド

| メソッド | 説明 |
|---------|------|
| `render(file)` | DOM構築、初期ウィンドウ読み込み |
| `save()` | ウィンドウコミット→`editable_save` |
| `find(term, forward)` | `editable_search`で検索 |
| `_loadWindow(startLine)` | `editable_window`で行取得 |
| `_commit()` | `editable_replace`でTextarea内容を書き戻し |
| `_maybeSlideWindow()` | ウィンドウ端検出→スライド |
| `_slideTo(newStart, keepAbsLine)` | ウィンドウ再読み込み |
| `_onScroll()` | スクロール→ゴミター同期＋ウィンドウスライド |
| `_onBlur()` | ブラー時自動コミット |

## 使用Tauriコマンド

`editable_window`, `editable_replace`, `editable_save`, `editable_search`

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| スクロールがウィンドウ上端に近い | 上方向にウィンドウスライド |
| スクロールがウィンドウ下端に近い | 下方向にウィンドウスライド |
| `windowDirty`がtrue | ブラー時またはスライド前に自動コミット |
