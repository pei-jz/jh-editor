# Vim.js — Markdownブロック向けVim風モーダル編集

## 概要
`Vim.js`はMarkdownブロックエディタにVimスタイルのNormal/Insertモード編集を提供します。

## ファイル情報
- **パス**: `src/modules/editors/Vim.js`（249行）
- **依存**: `Store.js`(State), `Editor.js`(selectBlock, activateBlock), `Explorer.js`(focusExplorer), `Hints.js`(showHints)

## エクスポート関数

### `updateVimStatus(): void`
ステータスバーのVimモード表示を更新します。

**分岐ロジック**:
| 条件 | 処理 |
|------|------|
| `settings_vimMode`が`true`かつ`vimState`あり | ステータス表示、Insertなら緑色、Normalならプライマリカラー |
| Vim無効 | 非表示 |

### `initVimMode(): void`
Vimモードを初期化し、keydownイベントリスナーを設定します。

## キーボード操作

### Insert/Inputモード
| キー | 処理 |
|------|------|
| `Ctrl+Enter` | 保存ボタンクリック → Normalモードに遷移 |
| `Escape` | キャンセルボタンクリック → Normalモードに遷移 |

### Normalモード — エクスプローラー内
| キー | 処理 |
|------|------|
| `j` / `ArrowDown` | フォーカスを下に移動 |
| `k` / `ArrowUp` | フォーカスを上に移動 |
| `Enter` | アクティブ要素をクリック |
| `f` | Vimiumヒント表示 |

### Normalモード — エディタ内
| キー | 処理 |
|------|------|
| `j` / `ArrowDown` | ブロック選択を下に移動 |
| `k` / `ArrowUp` | ブロック選択を上に移動 |
| `ArrowLeft/Right` | キャレット移動 |
| `Shift+矢印` | テキスト選択拡張 |
| `Enter` | ブロックをアクティブ化（編集開始） |
| `f` | Vimiumヒント表示 |
| `i` | Insertモードに遷移、選択中ブロックをアクティブ化 |
| `o` | Insertモードに遷移、最後のブロックを選択してアクティブ化 |

## 内部関数

### `moveSelection(delta: number): void`
ブロック選択を`delta`分移動します。

### `moveFocusInExplorer(delta: number): void`
エクスプローラー内のファイル項目を`delta`分移動します。
- **分岐**: インデックスが範囲外にならないようクランプ

### `restoreFocus(): Promise<void>`
ウィンドウフォーカス時にNormalモードならアクティブブロックにフォーカスを復元します。
- 一時的なinput要素を作成してフォーカスを強制的に取得

## イベントリスナー

| イベント | ターゲット | 説明 |
|---------|-----------|------|
| `keydown` | `document` | Vimモードのキーボード操作 |
| `focus` | `window` | フォーカス復元 |
| `click` | `document` | 背景クリック時のフォーカス復元 |
