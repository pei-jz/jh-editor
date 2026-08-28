# JhAiMcp.js — JHEditor ↔ JHAI MCP統合

## 概要
`JhAiMcp.js`はJHEditorをMCPサーバーとしてJHAIに公開する統合モジュールです。AIAgent.jsの逆方向：JHEditorからJHAIへのツール提供を実現します。

## ファイル情報
- **パス**: `src/modules/ai/JhAiMcp.js`（513行）
- **依存**: `ConnectionConfig.js`, `jhai-adapter.js`, `window.app`

## エクスポート関数

| 関数 | 説明 |
|------|------|
| `initJhEditorMcp()` | MCP接続を初期化 |
| `runJhaiIntent(intent, payload)` | JHAIイントレントを実行 |
| `runJhaiFreeform(prompt)` | フリーフォームプロンプトを実行 |
| `waitForConnection()` | 接続完了を待機 |

## 登録MCPツール

| ツール名 | 説明 |
|---------|------|
| `get_buffer` | 現在のエディタバッファを取得 |
| `get_selection` | 現在の選択テキストを取得 |
| `list_open_files` | オープン済みファイル一覧を取得 |
| `read_workspace_file` | ワークスペースファイルを読み込み |
| `get_diagnostics` | LSP診断情報を取得 |

## 登録イントレント

| イントレント | 説明 |
|-------------|------|
| `summarize_logs` | ログの要約 |
| `explain_selection` | 選択テキストの説明 |
| `freeform` | フリーフォーム質問 |

## アクションハンドラ

| アクション | 説明 |
|-----------|------|
| `insertMarkdown` | エディタにMarkdown挿入 |
| `applyEdit` | エディタに編集適用 |
| `openFile` | ファイルを開く |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| パストラバーサル検出 | `..`を含むパスを拒否 |
| 接続未確立 | `waitForConnection()`で待機 |
| `window.app`未定義 | エラーログ出力 |