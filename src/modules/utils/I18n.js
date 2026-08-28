// Lightweight UI localisation. English is the default: dictionary keys are the
// English source strings, so an untranslated key simply renders as English and
// no key ever renders blank. Japanese, Chinese and Korean dictionaries cover
// the static chrome (title bar, explorer, settings, search, status bar, welcome
// screen); strings generated in JS keep their existing wording unless a key is
// added below.
//
// Two mechanisms:
//   * data-i18n            — replace the element's text content with t(key)
//   * data-i18n-placeholder / data-i18n-title — localise placeholder / title
// Applying is idempotent; call it again after any language change or dynamic
// DOM rebuild to pick up new nodes.

const SUPPORTED = ['en', 'ja', 'zh', 'ko'];

const DICTIONARIES = {
    en: {},

    ja: {
        // Welcome
        'Select a workspace to start': 'ワークスペースを選択して開始',
        'Open a folder to work in, or just start writing': 'フォルダーを開く、またはそのまま書き始める',
        'Open Folder': 'フォルダーを開く',
        'Open File': 'ファイルを開く',
        'New File': '新規ファイル',
        'Recent Workspaces': '最近使ったワークスペース',
        'No recent workspaces': '最近使ったワークスペースはありません',
        // Title bar
        'Toggle Explorer': 'エクスプローラーを切り替え',
        'Toggle Terminal': 'ターミナルを切り替え',
        'No file selected': 'ファイルが選択されていません',
        'Notes (Quick Notes / Daily Note)': 'ノート（クイックノート / デイリーノート）',
        'Settings': '設定',
        'Minimize': '最小化',
        'Maximize': '最大化',
        'Close': '閉じる',
        // Explorer
        'Files': 'ファイル',
        'Git': 'Git',
        'Filter files...': 'ファイルを絞り込み…',
        'Open Workspace': 'ワークスペースを開く',
        // Search
        'Search…': '検索…',
        'Regular Expression': '正規表現',
        'Match Case': '大文字小文字を区別',
        'Whole Word': '単語単位',
        'Regex Templates': '正規表現テンプレート',
        'Toggle Replace Mode': '置換モードを切り替え',
        'Replace with…': '置換後の文字列…',
        'Replace': '置換',
        'Replace All': 'すべて置換',
        'Close (Esc)': '閉じる (Esc)',
        // Status bar
        'Commands': 'コマンド',
        'All commands and shortcuts (Ctrl+? or F1)': 'すべてのコマンドとショートカット (Ctrl+? / F1)',
        // About
        'Platform': 'プラットフォーム',
        'Tauri': 'Tauri',
        'License': 'ライセンス',
        'Copy version info': 'バージョン情報をコピー',
        'Include this information when reporting a problem.': '不具合を報告する際は、この情報を添えてください。',
        // Settings
        'General': '一般',
        'Agent': 'エージェント',
        'Keybindings': 'キーバインド',
        'MD Templates': 'MD テンプレート',
        'Snippets': 'スニペット',
        'Regex Samples': '正規表現サンプル',
        'Theme': 'テーマ',
        'Light': 'ライト',
        'Dark': 'ダーク',
        'Midnight': 'ミッドナイト',
        'Latte': 'ラテ',
        'Solarized Dark': 'ソラライズド ダーク',
        'Solarized Light': 'ソラライズド ライト',
        'Paper': '紙',
        'Bamboo Slip': '竹簡',
        'Ink Brush': '水墨',
        'Nord': 'ノード',
        'Hanging Scroll': '掛け軸',
        'View Mode': '表示モード',
        'Normal': '通常',
        'Compact (Full Width)': 'コンパクト（全幅）',
        'Editor Font (Monospace)': 'エディターフォント（等幅）',
        'Font Size (pt)': 'フォントサイズ (pt)',
        'Open read-only above (MB)': '読み取り専用で開くサイズ (MB)',
        'Language': '言語',
        'Save & Apply': '保存して適用',
        'Search shortcuts...': 'ショートカットを検索…',
        // Misc
        'New File': '新規ファイル',
        'Input': '入力',
        'Cancel': 'キャンセル',
        'OK': 'OK',
        'Edit': '編集',
        'Live Preview': 'ライブプレビュー',
        'Switch to tab...': 'タブを切り替え…',
        'Keyboard Shortcuts': 'キーボードショートカット',
        // AI chat / selection actions
        'AI Chat': 'AI チャット',
        'Clear history': '履歴を消去',
        'Clear': '消去',
        'Ask a question… (Shift+Enter for a new line)': '質問を入力…（Shift+Enter で改行）',
        'Send': '送信',
        'Sending…': '送信中…',
        'Context scope: {label} — {hint}': 'コンテキスト範囲: {label} — {hint}',
        'Change it in Settings → Agent Integration.': '設定 → エージェント連携で変更できます。',
        'Select some text first.': '先にテキストを選択してください。',
        'Summarize': '要約',
        'Translate': '翻訳',
        'Rephrase': '言い換え',
        '{title}…': '{title}…',
        '{title} returned nothing.': '{title} は結果を返しませんでした。',
        '{title} applied.': '{title} を適用しました。',
        'Could not open the result.': '結果を開けませんでした。',
        'Cannot reach J.H AI Agent. Start the agent and try again.': 'J.H AI エージェントに接続できません。エージェントを起動して再試行してください。',
        '{title} failed: {msg}': '{title} に失敗しました: {msg}',
        'Select a file from the explorer to start editing.': 'エクスプローラーからファイルを選択して編集を開始してください。',
    },

    zh: {
        // Welcome
        'Select a workspace to start': '选择工作区以开始',
        'Open a folder to work in, or just start writing': '打开文件夹，或直接开始写作',
        'Open Folder': '打开文件夹',
        'Open File': '打开文件',
        'New File': '新建文件',
        'Recent Workspaces': '最近使用的工作区',
        'No recent workspaces': '暂无最近使用的工作区',
        // Title bar
        'Toggle Explorer': '切换资源管理器',
        'Toggle Terminal': '切换终端',
        'No file selected': '未选择文件',
        'Notes (Quick Notes / Daily Note)': '笔记（快速笔记 / 每日笔记）',
        'Settings': '设置',
        'Minimize': '最小化',
        'Maximize': '最大化',
        'Close': '关闭',
        // Explorer
        'Files': '文件',
        'Git': 'Git',
        'Filter files...': '筛选文件…',
        'Open Workspace': '打开工作区',
        // Search
        'Search…': '搜索…',
        'Regular Expression': '正则表达式',
        'Match Case': '区分大小写',
        'Whole Word': '全字匹配',
        'Regex Templates': '正则模板',
        'Toggle Replace Mode': '切换替换模式',
        'Replace with…': '替换为…',
        'Replace': '替换',
        'Replace All': '全部替换',
        'Close (Esc)': '关闭 (Esc)',
        // Status bar
        'Commands': '命令',
        'All commands and shortcuts (Ctrl+? or F1)': '所有命令和快捷键 (Ctrl+? 或 F1)',
        // About
        'Platform': '平台',
        'Tauri': 'Tauri',
        'License': '许可证',
        'Copy version info': '复制版本信息',
        'Include this information when reporting a problem.': '报告问题时请附上这些信息。',
        // Settings
        'General': '常规',
        'Agent': '代理',
        'Keybindings': '按键绑定',
        'MD Templates': 'MD 模板',
        'Snippets': '代码片段',
        'Regex Samples': '正则示例',
        'Theme': '主题',
        'Light': '浅色',
        'Dark': '深色',
        'Midnight': '午夜',
        'Latte': '拿铁',
        'Solarized Dark': 'Solarized 深色',
        'Solarized Light': 'Solarized 浅色',
        'Paper': '纸张',
        'Bamboo Slip': '竹简',
        'Ink Brush': '水墨',
        'Nord': 'Nord',
        'Hanging Scroll': '挂轴',
        'View Mode': '视图模式',
        'Normal': '普通',
        'Compact (Full Width)': '紧凑（全宽）',
        'Editor Font (Monospace)': '编辑器字体（等宽）',
        'Font Size (pt)': '字号 (pt)',
        'Open read-only above (MB)': '超过此大小以只读打开 (MB)',
        'Language': '语言',
        'Save & Apply': '保存并应用',
        'Search shortcuts...': '搜索快捷键…',
        // Misc
        'New File': '新建文件',
        'Input': '输入',
        'Cancel': '取消',
        'OK': '确定',
        'Edit': '编辑',
        'Live Preview': '实时预览',
        'Switch to tab...': '切换到标签页…',
        'Keyboard Shortcuts': '键盘快捷键',
        // AI chat / selection actions
        'AI Chat': 'AI 聊天',
        'Clear history': '清除历史',
        'Clear': '清除',
        'Ask a question… (Shift+Enter for a new line)': '输入问题…（Shift+Enter 换行）',
        'Send': '发送',
        'Sending…': '发送中…',
        'Context scope: {label} — {hint}': '上下文范围: {label} — {hint}',
        'Change it in Settings → Agent Integration.': '可在 设置 → 代理集成 中更改。',
        'Select some text first.': '请先选择文本。',
        'Summarize': '摘要',
        'Translate': '翻译',
        'Rephrase': '改写',
        '{title}…': '{title}…',
        '{title} returned nothing.': '{title} 未返回结果。',
        '{title} applied.': '已应用 {title}。',
        'Could not open the result.': '无法打开结果。',
        'Cannot reach J.H AI Agent. Start the agent and try again.': '无法连接到 J.H AI 代理。请启动代理后重试。',
        '{title} failed: {msg}': '{title} 失败: {msg}',
        'Select a file from the explorer to start editing.': '从资源管理器中选择文件以开始编辑。',
    },

    ko: {
        // Welcome
        'Select a workspace to start': '시작할 작업 영역을 선택하세요',
        'Open a folder to work in, or just start writing': '폴더를 열거나 바로 작성을 시작하세요',
        'Open Folder': '폴더 열기',
        'Open File': '파일 열기',
        'New File': '새 파일',
        'Recent Workspaces': '최근 작업 영역',
        'No recent workspaces': '최근 작업 영역 없음',
        // Title bar
        'Toggle Explorer': '탐색기 전환',
        'Toggle Terminal': '터미널 전환',
        'No file selected': '선택된 파일 없음',
        'Notes (Quick Notes / Daily Note)': '노트 (빠른 노트 / 데일리 노트)',
        'Settings': '설정',
        'Minimize': '최소화',
        'Maximize': '최대화',
        'Close': '닫기',
        // Explorer
        'Files': '파일',
        'Git': 'Git',
        'Filter files...': '파일 필터…',
        'Open Workspace': '작업 영역 열기',
        // Search
        'Search…': '검색…',
        'Regular Expression': '정규식',
        'Match Case': '대/소문자 구분',
        'Whole Word': '단어 단위',
        'Regex Templates': '정규식 템플릿',
        'Toggle Replace Mode': '바꾸기 모드 전환',
        'Replace with…': '바꿀 내용…',
        'Replace': '바꾸기',
        'Replace All': '모두 바꾸기',
        'Close (Esc)': '닫기 (Esc)',
        // Status bar
        'Commands': '명령',
        'All commands and shortcuts (Ctrl+? or F1)': '모든 명령 및 단축키 (Ctrl+? 또는 F1)',
        // About
        'Platform': '플랫폼',
        'Tauri': 'Tauri',
        'License': '라이선스',
        'Copy version info': '버전 정보 복사',
        'Include this information when reporting a problem.': '문제를 보고할 때 이 정보를 함께 알려주세요.',
        // Settings
        'General': '일반',
        'Agent': '에이전트',
        'Keybindings': '키 바인딩',
        'MD Templates': 'MD 템플릿',
        'Snippets': '스니펫',
        'Regex Samples': '정규식 샘플',
        'Theme': '테마',
        'Light': '라이트',
        'Dark': '다크',
        'Midnight': '미드나이트',
        'Latte': '라떼',
        'Solarized Dark': 'Solarized 다크',
        'Solarized Light': 'Solarized 라이트',
        'Paper': '종이',
        'Bamboo Slip': '죽간',
        'Ink Brush': '수묵',
        'Nord': 'Nord',
        'Hanging Scroll': '족자',
        'View Mode': '보기 모드',
        'Normal': '일반',
        'Compact (Full Width)': '컴팩트 (전체 너비)',
        'Editor Font (Monospace)': '편집기 글꼴 (고정폭)',
        'Font Size (pt)': '글꼴 크기 (pt)',
        'Open read-only above (MB)': '이 크기 이상 읽기 전용으로 열기 (MB)',
        'Language': '언어',
        'Save & Apply': '저장 및 적용',
        'Search shortcuts...': '단축키 검색…',
        // Misc
        'New File': '새 파일',
        'Input': '입력',
        'Cancel': '취소',
        'OK': '확인',
        'Edit': '편집',
        'Live Preview': '실시간 미리보기',
        'Switch to tab...': '탭으로 전환…',
        'Keyboard Shortcuts': '키보드 단축키',
        // AI chat / selection actions
        'AI Chat': 'AI 채팅',
        'Clear history': '기록 지우기',
        'Clear': '지우기',
        'Ask a question… (Shift+Enter for a new line)': '질문을 입력… (Shift+Enter로 줄 바꿈)',
        'Send': '보내기',
        'Sending…': '전송 중…',
        'Context scope: {label} — {hint}': '컨텍스트 범위: {label} — {hint}',
        'Change it in Settings → Agent Integration.': '설정 → 에이전트 통합에서 변경할 수 있습니다.',
        'Select some text first.': '먼저 텍스트를 선택하세요.',
        'Summarize': '요약',
        'Translate': '번역',
        'Rephrase': '바꿔 쓰기',
        '{title}…': '{title}…',
        '{title} returned nothing.': '{title} 결과가 없습니다.',
        '{title} applied.': '{title} 적용됨.',
        'Could not open the result.': '결과를 열 수 없습니다.',
        'Cannot reach J.H AI Agent. Start the agent and try again.': 'J.H AI 에이전트에 연결할 수 없습니다. 에이전트를 시작하고 다시 시도하세요.',
        '{title} failed: {msg}': '{title} 실패: {msg}',
        'Select a file from the explorer to start editing.': '탐색기에서 파일을 선택하여 편집을 시작하세요.',
    },
};

const STORAGE_KEY = 'settings_language';

let currentLang = null;

function normalize(lang) {
    if (SUPPORTED.includes(lang)) return lang;
    const prefix = String(lang || '').split('-')[0].toLowerCase();
    return SUPPORTED.includes(prefix) ? prefix : 'en';
}

export function getLanguage() {
    if (currentLang) return currentLang;
    try {
        currentLang = normalize(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
        currentLang = 'en';
    }
    return currentLang;
}

export function setLanguage(lang) {
    currentLang = normalize(lang);
    try {
        localStorage.setItem(STORAGE_KEY, currentLang);
    } catch (_) {
        /* localStorage may be unavailable; in-memory still works */
    }
    applyI18n();
    return currentLang;
}

export function translate(key) {
    const dict = DICTIONARIES[getLanguage()] || DICTIONARIES.en;
    return dict[key] ?? key ?? '';
}

/**
 * Translate with optional `{placeholder}` substitution. `t('{n} files', { n: 3 })`.
 * Falls back to the key itself when no dictionary entry exists (same as `translate`).
 */
export function t(key, vars = null) {
    let s = translate(key);
    if (vars && typeof vars === 'object') {
        for (const k of Object.keys(vars)) {
            s = s.split('{' + k + '}').join(String(vars[k]));
        }
    }
    return s;
}

/**
 * Human language name for LLM system prompts, matched to the configured UI
 * language. The model is told to answer in this language.
 */
export function promptLanguageName(lang = getLanguage()) {
    switch (lang) {
        case 'ja': return 'Japanese';
        case 'zh': return 'Chinese';
        case 'ko': return 'Korean';
        default: return 'English';
    }
}

export function applyI18n(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = translate(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.setAttribute('placeholder', translate(el.getAttribute('data-i18n-placeholder')));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.setAttribute('title', translate(el.getAttribute('data-i18n-title')));
    });
}

export { SUPPORTED };
