# jhai-adapter.js — JHAI MCPクライアントSDK

## 概要
JHAI「AI Hub」とのMCP（Model Context Protocol）統合クライアントSDKです。vendoredされたSDKで、MCPサーバー役とタスク実行の両方を担当します。

## ファイル情報
- **パス**: `src/modules/ai/jhai-adapter.js`（338行）

## クラス: `JhaiAdapter`

## 主要機能

| 機能 | 説明 |
|------|------|
| MCPサーバー役 | 送信WSでMCPサーバーとして動作 |
| `registerTool()` | ツールを登録 |
| `registerIntent()` | イントレントを登録 |
| `runIntentTask()` / `chatTask()` | タスク実行 |
| JSON-RPC処理 | `initialize`, `tools/list`, `tools/call` |
| 再接続バックオフ | 切断時の指数バックオフ再接続 |
