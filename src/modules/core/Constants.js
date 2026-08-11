
// DOM Elements
export const EL = {
    explorer: document.getElementById('explorer'),
    explorerList: document.getElementById('file-list'),
    editorContainer: document.getElementById('editor-container'),
    editorContent: document.getElementById('editor-content'),
    
    // Right Pane Elements
    editorContainerRight: document.getElementById('editor-container-right'),
    editorContentRight: document.getElementById('editor-content-right'),
    tabsContainerRight: document.getElementById('tabs-container-right'),
    newTabBtnRight: document.getElementById('new-tab-btn-right'),
    editorSplitResizer: document.getElementById('editor-split-resizer'),
    resizerLeft: document.getElementById('resizer-left'),
    resizerRight: document.getElementById('resizer-right'),
    tabsContainer: document.getElementById('tabs-container'),
    newTabBtn: document.getElementById('new-tab-btn'),
    currentFileLabel: document.getElementById('current-file'),
    fileDirectoryLabel: document.getElementById('file-directory'),

    // Status Bar
    statusSizeType: document.getElementById('status-file-type'), // Existing ID in HTML
    statusSize: document.getElementById('status-size'),
    statusLastModified: document.getElementById('status-last-modified'),
    statusEncoding: document.getElementById('status-encoding'),
    statusSelection: document.getElementById('status-selection'),

    // Search
    searchPanel: document.getElementById('search-panel'),
    findInput: document.getElementById('find-input'),
    replaceInput: document.getElementById('replace-input'),
    regexToggle: document.getElementById('regex-toggle'),
    caseToggle: document.getElementById('case-toggle'),
    findPrevBtn: document.getElementById('find-prev-btn'),
    findNextBtn: document.getElementById('find-next-btn'),
    replaceBtn: document.getElementById('replace-btn'),
    replaceAllBtn: document.getElementById('replace-all-btn'),
    closeSearchBtn: document.getElementById('close-search-btn'),
    searchLaunchBtn: document.getElementById('search-btn'), // Toolbar btn
    searchStatusBar: document.getElementById('search-status-bar'),
    searchStatusQuery: document.getElementById('search-status-query'),
    searchStatusCount: document.getElementById('search-status-count'),

    // Buttons
    toggleExplorerBtn: document.getElementById('toggle-explorer-btn'),
    newFileBtn: document.getElementById('new-file-btn'),
    openFolderBtn: document.getElementById('open-folder-btn'),
    saveBtn: document.getElementById('save-btn'),

    // Modals
    inputModal: {
        overlay: document.getElementById('input-modal-overlay'),
        title: document.getElementById('input-title'),
        message: document.getElementById('input-message'),
        input: document.getElementById('input-value'),
        okBtn: document.getElementById('input-ok'),
        cancelBtn: document.getElementById('input-cancel')
    },
    previewModal: {
        overlay: document.getElementById('preview-modal'),
        content: document.getElementById('preview-content'),
        closeBtn: document.querySelector('.close-preview') // Assuming class
    },
    // Terminal
    terminal: {
        toggleBtn: document.getElementById('toggle-terminal-btn'),
        panel: document.getElementById('terminal-panel'),
        header: document.getElementById('terminal-header'),
        container: document.getElementById('terminal-container'),
        closeBtn: document.getElementById('close-terminal-btn'),
        clearBtn: document.getElementById('clear-terminal-btn'),
        resizer: document.getElementById('resizer-bottom')
    },

    // Settings
    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: {
        overlay: document.getElementById('settings-modal'),
        closeBtn: document.getElementById('close-settings-btn'),
        themeSelector: document.getElementById('theme-selector'),
        tabs: document.querySelectorAll('.settings-tab'),
        panes: {
            general: document.getElementById('settings-general'),
            agent: document.getElementById('settings-agent'),
            keybindings: document.getElementById('settings-keybindings'),
            templates: document.getElementById('settings-templates')
        },
        agent: {
            container: document.getElementById('agent-settings-container')
        }
    },

    // Shortcuts
    shortcutGuide: {
        container: document.getElementById('shortcut-guide'),
        list: document.getElementById('shortcut-list')
    }
};
