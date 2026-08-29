# TaskNotificationPanel.js — タスク管理コントロールパネル

## 概要
J.H AI Agentとのタスク管理を包括的に行うUIパネルです。タスク送信、WebSocket通信、承認フロー、ダッシュボード表示を実装します。

## ファイル情報
- **パス**: `src/modules/ai/TaskNotificationPanel.js`（817行）
- **依存**: `ConnectionConfig.js`

## クラス: `TaskNotificationPanel`

## 主要機能

| 機能 | 説明 |
|------|------|
| タスク送信 | POST `/api/tasks`でタスクを送信 |
| WebSocket接続 | タスクごとのWebSocket接続 |
| ログ処理 | `_processLogs()`でイベントを解析 |
| 承認UI | WS経由でconfirm/deny |
| ダッシュボード | 進捗バー、思考表示、変更ファイル、アクティビティログ |
| デスクトップ通知 | タスク完了時に通知 |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| タスク実行中 | プログレスバー表示 |
| 承認待ち | 承認/拒否ボタン表示 |
| タスク完了 | 結果表示、デスクトップ通知 |
| タスクエラー | エラー詳細表示 |
