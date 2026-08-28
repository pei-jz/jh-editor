# Modal.js — モーダルダイアログコレクション

## 概要
入力モーダル、確認モーダルなど、共通のモーダルダイアログユーティリティを提供します。

## ファイル情報
- **パス**: `src/modules/ui/Modal.js`（401行）

## 主要関数

| 関数 | 説明 |
|------|------|
| `showInputModal(title, message, defaultValue)` | 入力モーダル表示 |
| `showConfirmModal(title, message)` | 確認モーダル表示 |
| `closeInputModal()` | 入力モーダルを閉じる |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| ユーザーキャンセル | `null`返却 |
| 入力値が空 | デフォルト値返却 |
| Escapeキー | モーダル閉じる |
