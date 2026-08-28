# Constants.js — DOM要素参照の集中管理

## 概要
`Constants.js`はアプリケーションで使用されるすべてのDOM要素参照を集中的にキャッシュするオブジェクト`EL`を提供します。モジュールロード時にDOMから直接取得します。

## ファイル情報
- **パス**: `src/modules/core/Constants.js`（99行）
- **依存**: なし

## エクスポート

### `EL` オブジェクト

#### ファイルエクスプローラー
| プロパティ | DOM ID | 説明 |
|-----------|--------|------|
| `explorer` | `#explorer` | メインエクスプローラーパネル |
| `explorerList` | `#file-list` | 仮想スクロールファイルリスト |

#### エディタ（左ペイン）
| プロパティ | DOM ID | 説明 |
|-----------|--------|------|
| `editorContainer` | `#editor-container` | 左エディタペインラッパー |
| `editorContent` | `#editor-content` | 左エディタコンテンツ領域 |
| `tabsContainer` | `#tabs-container` | 左タブバー |
| `newTabBtn` | `#new-tab-btn` | 新規タブボタン |
| `currentFileLabel` | `#current-file` | 現在のファイル名表示 |
| `fileDirectoryLabel` | `#file-directory` | 現在のファイルディレクトリ表示 |

#### エディタ（右ペイン）
| プロパティ | DOM ID | 説明 |
|-----------|--------|------|
| `editorContainerRight` | `#editor-container-right` | 右ペインラッパー |
| `editorContentRight` | `#editor-content-right` | 右コンテンツ領域 |
| `tabsContainerRight` | `#tabs-container-right` | 右タブバー |
| `newTabBtnRight` | `#new-tab-btn-right` | 右新規タブボタン |
| `editorSplitResizer` | `#editor-split-resizer` | 分割リサイザーバー |

#### レイザー
| プロパティ | DOM ID | 説明 |
|-----------|--------|------|
| `resizerLeft` | `#resizer-left` | 左リサイザー |
| `resizerRight` | `#resizer-right` | 右リサイザー |

#### ステータスバー
| プロパティ | DOM ID | 説明 |
|-----------|--------|------|
| `statusSizeType` | `#status-file-type` | ファイルタイプ |
| `statusSize` | `#status-size` | ファイルサイズ |
| `statusLastModified` | `#status-last-modified` | 最終更新日時 |
| `statusEncoding` | `#status-encoding` | エンコーディング |
| `statusSelection` | `#status-selection` | カーソル/選択情報 |

#### 検索パネル
| プロパティ | DOM ID | 説明 |
|-----------|--------|------|
| `searchPanel` | `#search-panel` | 検索パネルコンテナ |
| `findInput` | `#find-input` | 検索テキスト入力 |
| `replaceInput` | `#replace-input` | 置換テキスト入力 |
| `regexToggle` | `#regex-toggle` | 正規表現トグル |
| `caseToggle` | `#case-toggle` | 大文字小文字区別トグル |
| `findPrevBtn` | `#find-prev-btn` | 前へボタン |
| `findNextBtn` | `#find-next-btn` | 次へボタン |
| `replaceBtn` | `#replace-btn` | 置換ボタン |
| `replaceAllBtn` | `#replace-all-btn` | 全置換ボタン |
| `closeSearchBtn` | `#close-search-btn` | 閉じるボタン |
| `searchStatusBar` | `#search-status-bar` | 検索ステータスバー |

#### ボタン
| プロパティ | DOM ID | 説明 |
|-----------|--------|------|
| `toggleExplorerBtn` | `#toggle-explorer-btn` | エクスプローラー切替ボタン |
| `openFolderBtn` | `#open-folder-btn` | フォルダを開くボタン |

#### モーダル（入力）
`EL.inputModal`オブジェクトとして以下を含む：
- `overlay`, `title`, `message`, `input`, `okBtn`, `cancelBtn`

#### モーダル（プレビュー）
`EL.previewModal`オブジェクトとして以下を含む：
- `overlay`, `content`, `closeBtn`

#### ターミナル
`EL.terminal`オブジェクトとして以下を含む：
- `toggleBtn`, `panel`, `header`, `container`, `closeBtn`, `clearBtn`, `resizer`

#### 設定
`EL.settingsBtn`と`EL.settingsModal`オブジェクト：
- `overlay`, `closeBtn`, `themeSelector`, `tabs`, `panes`

#### ショートカット
`EL.shortcutGuide`オブジェクト：
- `container`, `list`
