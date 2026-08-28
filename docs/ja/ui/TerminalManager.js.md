# TerminalManager.js — ターミナルエミュレータ

## 概要
xterm.jsを使用した統合ターミナルエミュレータです。RustバックエンドのPTY（擬似ターミナル）と接続します。

## ファイル情報
- **パス**: `src/modules/ui/TerminalManager.js`（376行）
- **依存**: `@xterm/xterm`, `@xterm/addon-fit`, `@tauri-apps/api/core`(invoke)

## クラス: `TerminalManager`

## 主要メソッド

| メソッド | 説明 |
|---------|------|
| `init()` | xterm初期化、PTY起動 |
| `toggle()` | ターミナルパネルの表示/非表示切替 |
| `clear()` | ターミナルクリア |
| `write(data)` | PTYにデータ書き込み |
| `resize(cols, rows)` | ターミナルサイズ変更 |
| `destroy()` | PTY停止、xterm破棄 |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| PTY未起動 | 自動起動 |
| パネル非表示 | 表示に切替 |
| ウィンドウリサイズ | fit addonで自動リサイズ |
