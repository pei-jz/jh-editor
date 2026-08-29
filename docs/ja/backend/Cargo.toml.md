# Cargo.toml — パッケージマニフェスト

Rustバックエンドの依存関係を定義します（53行）。

**パス**: `src-tauri/Cargo.toml`

## 主要依存

| クレート | バージョン | 説明 |
|---------|-----------|------|
| `tauri` | 2.2.0 | Tauriフレームワーク |
| `tokio` | 1.x | 非同期ランタイム |
| `portable-pty` | 0.9.0 | 擬似ターミナル |
| `chardetng` | 0.1.17 | エンコーディング検出 |
| `ignore` | 0.4 | .gitignore対応走査 |
| `ropey` | 1.6 | テキストロープ |
| `calamine` | 0.25.0 | Excel読み込み |

リリースプロファイル: LTO有効、strip有効、opt-level "s"