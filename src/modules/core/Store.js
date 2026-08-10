
export const State = {
    currentDir: '.',
    gitRoot: '.',
    gitRepos: [], // [{ name, path }] when the workspace has multiple git repos
    splitMode: false, // false | 'horizontal' (split right)
    activePane: 'left', // 'left' | 'right'
    openFiles: [], // Array of { path, content, isDirty } (Left/Primary Pane)
    activeTabIndex: -1,
    rightOpenFiles: [], // Right/Secondary Pane
    rightActiveTabIndex: -1,
    isExplorerVisible: true,
    isOutlineVisible: false,
    searchMatches: [],
    currentMatchIndex: -1,
    vimState: {
        mode: 'normal', // 'normal' | 'insert'
        selectedIndex: -1
    },
    expandedFolders: new Set(), // For Explorer Tree View
    explorerSearchTerm: '',
    explorerSearchContent: false,
    aiShowDetailedLogs: localStorage.getItem('settings_aiShowDetailedLogs') === 'true',
    ragModelSize: localStorage.getItem('settings_ragModelSize') || 'small',
    markdownViewMode: localStorage.getItem('settings_markdownViewMode') || 'scroll', // 'scroll' | 'book'
    plainTextViewMode: localStorage.getItem('settings_plainTextViewMode') || 'edit', // 'edit' | 'book'
    showWhitespace: localStorage.getItem('settings_showWhitespace') === 'true' // Render CR/LF/TAB markers (Sakura/Eclipse style)
};

// Helper methods to mutate state safely could go here,
// but for this refactor we'll keep it direct to minimize friction.
