# Toast.js — Toast通知

## 概要
一時的な通知メッセージを表示するToastコンポーネントです。

## ファイル情報
- **パス**: `src/modules/ui/Toast.js`（105行）

## クラス: `Toast`（シングルトン）

## 主要メソッド

| メソッド | 説明 |
|---------|------|
| `show(message, type, duration)` | 通知を表示 |
| `success(message)` | 成功通知 |
| `error(message)` | エラー通知 |
| `info(message)` | 情報通知 |
| `warning(message)` | 警告通知 |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| `type === 'success'` | 緑色アイコン |
| `type === 'error'` | 赤色アイコン |
| `type === 'warning'` | 黄色アイコン |
| `type === 'info'` | 青色アイコン |
| 表示時間経過 | フェードアウトして非表示 |
| 複数通知同時 | 縦に積み上げ表示 |
