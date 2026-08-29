# MarkdownView.js — Markdownライブプレビュービュー

## 概要
Markdownファイルのライブプレビュー表示ビューです。marked.jsとmermaid.jsを使用してMarkdownのリアルタイムプレビューを提供します。

## ファイル情報
- **パス**: `src/modules/views/MarkdownView.js`（51.4KB）

## 主要機能

| 機能 | 説明 |
|------|------|
| ライブプレビュー | Markdown→HTML変換 |
| ブックモード | ページフリッパー表示 |
| テーブル編集 | TableEditorとの統合 |
| ツリー表示 | 構造データとの切替 |
| Vimナビゲーション | ブロック単位ナビゲーション |
| ダークモード対応 | テーマ連動 |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| `markdownViewMode === 'scroll'` | スクロールプレビューモード |
| `markdownViewMode === 'book'` | ブックモード（page-flip） |
| テーブルブロック検出 | TableEditorに委譲 |
| ツリーブロック検出 | StructureEditorに委譲 |
| Mermaidコードブロック | mermaid.jsでレンダリング |
