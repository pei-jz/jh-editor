# ShortcutDefinitions.js — キーボードショートカット定義

## 概要
`ShortcutDefinitions.js`はJHEditorのすべてのキーボードショートカットを定義する単一の情報源（Single Source of Truth）です。各ショートカットの実際の関数マッピングは、それぞれのモジュールまたはcentral dispatcherで処理されます。

## ファイル情報
- **パス**: `src/modules/core/ShortcutDefinitions.js`（182行）
- **依存**: なし

## エクスポート

### `SHORTCUTS` オブジェクト

スコープごとのショートカット配列を含みます。

## ショートカットスコープ一覧

### GLOBAL（グローバル）
| キー | 修飾子 | コマンド | 説明 |
|------|--------|----------|------|
| `s` | Ctrl | `app:save` | 保存 |
| `f` | Ctrl | `app:search` | 検索 |
| `f` | Shift+Alt | `app:format` | フォーマット |
| `o` | Ctrl | `app:outline-modal` | アウトラインナビゲーション |
| `p` | Ctrl | `app:file-search` | ファイル検索 |
| `r` | Ctrl+Shift | `app:file-search` | ファイル検索 |
| `n` | Ctrl | `app:new-file` | 新規ファイル |
| `w` | Ctrl | `app:close-tab` | タブを閉じる |
| `F3` | — | `app:find-next` | 次を検索 |
| `k` | Ctrl | `app:find-next` | 次を検索 |
| `F3` | Shift | `app:find-prev` | 前を検索 |
| `k` | Ctrl+Shift | `app:find-prev` | 前を検索 |
| `Enter` | Alt | `app:replace-next` | 置換して次へ |
| `F5` | — | `app:refresh-explorer` | エクスプローラー更新 |
| `F1` | — | `app:shortcut-guide` | ショートカットガイド |
| `?` | Ctrl | `app:shortcut-guide` | ショートカットガイド |
| `/` | Ctrl | `app:shortcut-guide` | ショートカットガイド |
| `t` | Ctrl | `app:tab-search` | タブ検索 |
| `e` | Ctrl+Shift | `app:toggle-view-mode` | ビューモード切替 |
| `c` | Ctrl | `app:copy` | コピー |
| `x` | Ctrl | `app:cut` | 切り取り |
| `v` | Ctrl | `app:paste` | 貼り付け |
| `z` | Ctrl | `app:undo` | 元に戻す |
| `y` | Ctrl | `app:redo` | やり直し |
| `z` | Ctrl+Shift | `app:redo` | やり直し |
| `1` | Ctrl | `app:focus-explorer` | エクスプローラーにフォーカス |
| `2` | Ctrl | `app:focus-editor` | エディタにフォーカス |
| `Space` | Ctrl | `app:inline-ai` | インラインAI編集 |
| `d` | Ctrl+Shift | `app:diff` | ファイル比較 |
| `d` | Ctrl+Alt | `app:open-compare` | テキスト比較 |
| `w` | Ctrl+Alt | `app:toggle-whitespace` | 空白文字表示切替 |

### EXPLORER（エクスプローラー）
| キー | コマンド | 説明 |
|------|----------|------|
| `ArrowDown/Up/Right/Left` | `explorer:nav` | ナビゲーション |
| `Enter` | `explorer:nav` | 選択を開く |
| `Delete` | `explorer:nav` | 選択を削除 |
| `Ctrl+C/X/V` | `explorer:nav` | パス操作 |
| `Tab/Shift+Tab` | `explorer:nav` | フォーカス切替 |
| `F2` | `explorer:rename` | 名前変更 |
| `Ctrl+N` | `explorer:new-file` | 新規ファイル作成 |

### EDITOR（エディタ）
| キー | コマンド | 説明 |
|------|----------|------|
| `Ctrl+Tab` | `editor:next-tab` | 次タブ |
| `Ctrl+Shift+Tab` | `editor:prev-tab` | 前タブ |
| `F12` | `editor:go-to-definition` | 定義へ移動 |
| `Shift+F12` | `editor:find-references` | 参照検索 |
| `Ctrl+\\` | `editor:split-right` | 右に分割 |
| `Ctrl+Shift+W` | `editor:close-split` | 分割ペインを閉じる |

### CSV / CSV_EDIT
CSVナビゲーション、セル編集、行/列操作のショートカット群。

### SEARCH（検索）
検索パネル固有のショートカット（Alt+E: 正規表現、Alt+C: 大文字小文字等）。

### MARKDOWN / MARKDOWN_TABLE / MARKDOWN_BLOCK
Markdown固有のショートカット（Bold、Italic、Link、リスト等）。

### AI_REVIEW
AI差分レビューのショートカット（Alt+A: 受入、Alt=R: 拒否等）。

### STRUCTURE_EDIT
構造化データエディタのショートカット（Ctrl+S: 保存）。
