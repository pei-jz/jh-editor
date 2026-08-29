# AIAgent.js — 外部LLMへのタスク委譲ファサード

## 概要
`AIAgent`はJHEditorからJ.H AI Agent（外部LLM）へのタスク委譲を実現するファサードクラスです。イテレーティブエージェントとシングルショットの2つの実行モードを提供します。

## ファイル情報
- **パス**: `src/modules/ai/AIAgent.js`（217行）
- **依存**: `ConnectionConfig.js`, `jhai-adapter.js`

## クラス: `AIAgentFacade`

### メソッド

| メソッド | パラメータ | 戻り値 | 説明 |
|---------|-----------|--------|------|
| `run` | `task, options` | `Promise` | イテレーティブエージェント実行（継続的LLM対話） |
| `runSingleShot` | `prompt, options` | `Promise` | シングルショットLLM呼び出し |
| `checkHealth` | — | `Promise<boolean>` | エージェントの到達可能性チェック |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| クライアント未初期化 | `ConnectionConfig`から接続情報を取得し遅延初期化 |
| `AbortSignal`提供時 | タスクキャンセル対応 |

## イベントルーティング

| イベント | 説明 |
|---------|------|
| `stream` | LLM出力のストリーミング |
| `status` | タスク状態変更 |
| `thought` | LLMの思考プロセス |
| `tool_call` | ツール呼び出し |
| `file_modified` | ファイル変更通知 |
