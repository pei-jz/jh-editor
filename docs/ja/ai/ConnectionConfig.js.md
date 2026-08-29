# ConnectionConfig.js — 接続設定の自動ディスカバリー

## 概要
J.H AI Agentとの接続情報を3層解決戦略で自動的に検出します。

## ファイル情報
- **パス**: `src/modules/ai/ConnectionConfig.js`（145行）
- **依存**: なし（Tauriコマンド使用）

## エクスポート関数

| 関数 | 説明 |
|------|------|
| `getConnectionConfig()` | 接続設定を取得（キャッシュ付き） |
| `refreshConnectionConfig()` | 強制的に接続設定を再取得 |
| `isAgentReachable()` | エージェントの到達可能性をチェック |

## 3層解決戦略

1. **標準JHパス**: OS固有の設定ファイルパスを確認
2. **localStorage**: 保存済みのユーザー設定を確認
3. **フォールバック**: デフォルト値を使用

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| 標準パスに設定ファイル存在 | その設定を使用 |
| 標準パスなし、localStorageに設定あり | localStorage設定を使用 |
| どちらもなし | フォールバックデフォルト値 |
| OS判定 | Windows: `%APPDATA%`, macOS: `~/Library/Application Support`, Linux: `~/.config` |