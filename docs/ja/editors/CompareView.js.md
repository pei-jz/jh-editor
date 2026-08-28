# CompareView.js — テキスト比較ワークスペース

## 概要
`CompareView`はファイル非依存の差分比較ワークスペースです。ユーザーが2つの全高ペインにテキストを貼り付けて比較できます。比較結果はDiffEditorで全画面表示されます。

## ファイル情報
- **パス**: `src/modules/editors/CompareView.js`（162行）
- **依存**: `DiffEditor`

## クラス: `CompareView`

### コンストラクタ
```javascript
constructor(container: HTMLElement, options?: Object)
```

### メソッド

| メソッド | パラメータ | 戻り値 | 説明 |
|---------|-----------|--------|------|
| `render` | `content, file` | `void` | 初期描画。ファイルに`compareLeft`/`compareRight`があれば結果モードで表示 |
| `renderEditMode` | — | `void` | 2つの全高テキストエリア＋ツールバーを描画 |
| `renderResultMode` | — | `void` | DiffEditorで全画面差分表示に切替 |
| `runCompare` | — | `void` | 比較を実行（両方空ならスキップ） |
| `applyChanges` | — | `void` | no-op（比較タブはディスク内容を持たない） |
| `destroy` | — | `void` | DiffEditor破棄、CSSクラス削除 |

## 分岐ロジック

| 条件 | 処理 |
|------|------|
| `file.compareLeft`/`compareRight`が存在 | 既に比較結果がある場合、結果モードで描画 |
| 両方のテキストが空 | 比較ボタンを押してもフォーカスのみ（結果モードに遷移しない） |
| `renderEditMode`実行時 | 既存のDiffEditorがあれば破棄してから再描画 |
