6件すべて対応・検証完了しました。

## 対応結果

**P0-1 split右ペインのdirty検出**
- `setupCloseListener`（App.js）は既に両ペイン対応済みと確認。
- `closeAllTabs`（Editor.js）は未修正だったため、dirty判定とsaveループを `State.openFiles`＋`State.rightOpenFiles` の両方対象に修正。path重複（両ペインで同一ファイルを開くシャロークローン）は1回だけ保存するよう dedup を追加。

**P0-2 typo修正**
- `index.html` の `<title>J.H Editer` → `J.H Editor`、`tauri.conf.json` の `identifier: com.jh-editer.app` → `com.jh-editor.app` を修正。

**P1 vendor.js分割 + shiki要否**
- **shikiは必要**と判定：エディタ本体（CodeMirror）は自前ハイライト（CMHighlighter/syntaxHighlighting）で shiki 不使用だが、**Markdownプレビュー／Diff／構造ビュー／インラインAIのHTMLコードブロック**で使われており削除不可。
- `ShikiHighlighter.js` を動的 import 化し、`vite.config.js` の manualChunks を修正（`@shikijs/*`/`shiki`/`oniguruma`/`vscode-textmate`/`katex` を vendor に固めない）。
- 結果：**vendor.js 11.3MB → 1.49MB（約87%削減）**、shiki の29言語グラマーは個別の遅延チャンクに分離。

**P1 e2e実挙動テスト化**
- 従来の（存在しない）`__TEST_MODE__`・モックDOM注入・アサーション無し空テストを廃止し、実 DOM を実イベントハンドラで駆動する5テストに書き直し（welcome表示／テーマ切替／言語切替／新規ファイルモーダル／ショートカットガイド）。
- フレーク源の VRT スナップショット2枚を削除。**5件全パス**。
- README の「Views/editorsはPlaywrightでカバー」を現状に合う表現へ修正。

**P2 孤立CSS削除 + README同期**
- 未参照の `src/styles.css`（83KB）を削除。
- README のテーマ数を「8」→「11」（実装値）、カバレッジ記述を「npm test は gate なし、test:coverage で enforcement」と実態に同期。

**P2 UI言語設定機能（i18n、デフォルト英語、日/中/韓）**
- 新規 `src/modules/utils/I18n.js`：英語をデフォルト（キー＝英語原文）とし、日/中/韓の辞書を同梱。`data-i18n`/`data-i18n-title`/`data-i18n-placeholder` で静的chromeをローカライズ。
- Settings の General に「Language」セレクタを追加（English／日本語／中文／한국어）、即時反映＋localStorage永続化。
- index.html のタイトルバー／エクスプローラー／検索／設定／ステータスバー／ウェルカム等に data-i18n を配線。

## 検証
- `npm run build` 成功（vendor 1.49MB 維持）
- `npm test` → **913件全パス**
- `npx playwright test` → **5件全パス**
- `cargo check --locked` → **成功**（"Finished"、PowerShellのstderr表示は無害）
- 編集した .js は全て `verify_syntax` で構文確認済み

## 未対応（指示通りスコープ外）
- `public/`・`docs/` の git 追跡：ユーザー側で検討・commitするため未対応。
- コミットはしていません（確認いただければ commit します）。