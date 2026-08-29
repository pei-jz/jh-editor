# FileSystem.js — ファイルシステム操作ラッパー

## 概要
`FileSystem`はTauriバックエンドのファイルシステムコマンドをラップするユーティリティモジュールです。

## ファイル情報
- **パス**: `src/modules/utils/FileSystem.js`（8.3KB）
- **依存**: `@tauri-apps/api/core`(invoke), `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`

## 主要関数

| 関数 | 説明 |
|------|------|
| `readFile(path)` | ファイル読み込み |
| `writeFile(path, content)` | ファイル書き込み |
| `readDir(path)` | ディレクトリ一覧 |
| `exists(path)` | パス存在確認 |
| `createDir(path)` | ディレクトリ作成 |
| `removeFile(path)` | ファイル/ディレクトリ削除 |
| `renameFile(old, new)` | 名前変更 |
| `openFolder()` | フォルダ選択ダイアログ |
| `readFileAutoDetect(path)` | エンコーディング自動検出で読み込み |
| `readFileWithEncoding(path, enc)` | 指定エンコーディングで読み込み |
| `pasteFiles()` | クリップボードからファイル貼り付け |
| `listRecursive(path)` | 再帰的ファイルリスト |
| `parseExcelToMarkdown(bytes, ext)` | Excel→Markdown変換 |
