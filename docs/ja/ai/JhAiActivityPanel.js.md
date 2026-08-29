# JhAiActivityPanel.js — JHAIアクティビティパネル

## 概要
JHAIタスクのストリーミングステータスを右下ドックに表示するパネルです。

## ファイル情報
- **パス**: `src/modules/ai/JhAiActivityPanel.js`（223行）

## クラス: `ActivityPanel`

## 主要メソッド

| メソッド | 説明 |
|---------|------|
| `addTask(taskInfo)` | タスクを追加し`EntryHandle`を返す |
| `setStatus(handle, status)` | タスクステータスを更新 |
| `setResult(handle, result)` | タスク結果を設定 |
| `setError(handle, error)` | エラーを設定 |
| `onAbort(handle)` | タスク中止 |

## タスクカードライフサイクル

`running` → `done` / `error` / `aborted`

## 特徴
- Markdownレンダリング対応
- アクションボタン
- 最大履歴数: 20（超過時古いものから削除）