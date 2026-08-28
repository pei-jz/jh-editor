# BaseView.js — 抽象基底クラス

## 概要
ビューインターフェースの契約を定義する抽象基底クラスです。

## ファイル情報
- **パス**: `src/modules/views/BaseView.js`（41行）
- **依存**: なし

## クラス: `BaseView`

## メソッド

| メソッド | 説明 |
|---------|------|
| `constructor(container)` | コンテナ要素を設定 |
| `render(content, file)` | 抽象メソッド。オーバーライドしないとエラー |
| `destroy()` | オプションのクリーンアップ（デフォルトno-op） |
| `focus()` | オプションのフォーカス（デフォルトno-op） |
| `getDiagnostics()` | デフォルトで空配列を返す |
