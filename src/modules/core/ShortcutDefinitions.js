/**
 * ShortcutDefinitions.js
 * Single source of truth for all keyboard shortcuts in JHEditor.
 * 
 * Logic to map these to actual functions is handled in the respective modules
 * or in a central dispatcher if preferred.
 */

export const SHORTCUTS = {
    GLOBAL: [
        { key: 's', ctrl: true, cmd: 'app:save', description: 'Save' },
        { key: 'f', ctrl: true, cmd: 'app:search', description: 'Search' },
        { key: 'f', shift: true, alt: true, cmd: 'app:format', description: 'Format' },
        { key: 'o', ctrl: true, cmd: 'app:outline-modal', description: 'Outline Navigation' },
        { key: 'p', ctrl: true, cmd: 'app:file-search', description: 'File Search' },
        { key: 'r', ctrl: true, shift: true, cmd: 'app:file-search', description: 'File Search' },
        { key: 'g', ctrl: true, cmd: 'app:grep', description: 'Workspace Grep' },
        { key: 'l', ctrl: true, cmd: 'app:goto-line', description: 'Go to Line' },
        { key: 'v', ctrl: true, alt: true, cmd: 'app:toggle-vim', description: 'Toggle Vim (vi) Mode' },
        { key: 'b', ctrl: true, alt: true, cmd: 'app:toggle-book-mode', description: 'Toggle Book Mode' },
        { key: 'n', ctrl: true, cmd: 'app:new-file', description: 'New File' },
        { key: 'w', ctrl: true, cmd: 'app:close-tab', description: 'Close Tab' },
        { key: 'F3', cmd: 'app:find-next', description: 'Find Next' },
        { key: 'k', ctrl: true, cmd: 'app:find-next', description: 'Find Next' },
        { key: 'F3', shift: true, cmd: 'app:find-prev', description: 'Find Previous' },
        { key: 'k', ctrl: true, shift: true, cmd: 'app:find-prev', description: 'Find Previous' },
        { key: 'Enter', alt: true, cmd: 'app:replace-next', description: 'Replace & Find Next' },
        { key: 'F5', cmd: 'app:refresh-explorer', description: 'Refresh Explorer' },
        { key: 'F1', cmd: 'app:shortcut-guide', description: 'Shortcut Guide' },
        { key: '?', ctrl: true, cmd: 'app:shortcut-guide', description: 'Shortcut Guide' },
        { key: '/', ctrl: true, cmd: 'app:shortcut-guide', description: 'Shortcut Guide' },
        { key: 't', ctrl: true, cmd: 'app:tab-search', description: 'Tab Search' },
        { key: 'e', ctrl: true, shift: true, cmd: 'app:toggle-view-mode', description: 'Toggle View Mode' },
        { key: 'p', ctrl: true, alt: true, cmd: 'app:toggle-preview', description: 'Toggle Preview' },
        // F2 anywhere opens the edit modal for the selected markdown block
        // (MarkdownView guards itself, so this is a no-op in other views).
        { key: 'F2', cmd: 'md-block:edit', description: 'Edit Block (Markdown)' },
        // Clipboard (Global)
        { key: 'c', ctrl: true, cmd: 'app:copy', description: 'Copy' },
        { key: 'x', ctrl: true, cmd: 'app:cut', description: 'Cut' },
        { key: 'v', ctrl: true, cmd: 'app:paste', description: 'Paste' },
        { key: 'z', ctrl: true, cmd: 'app:undo', description: 'Undo' },
        { key: 'y', ctrl: true, cmd: 'app:redo', description: 'Redo' },
        { key: 'z', ctrl: true, shift: true, cmd: 'app:redo', description: 'Redo' },
        // Vim-inspired global focus jumps
        { key: '1', ctrl: true, cmd: 'app:focus-explorer', description: 'Focus Explorer' },
        { key: '2', ctrl: true, cmd: 'app:focus-editor', description: 'Focus Editor' },
        { key: ' ', ctrl: true, cmd: 'app:inline-ai', description: 'Inline AI Edit' },
        { key: 'd', ctrl: true, shift: true, cmd: 'app:diff', description: 'Compare with File' },
        { key: 'd', ctrl: true, alt: true, cmd: 'app:open-compare', description: 'Compare Text (empty diff)' },
        { key: 'w', ctrl: true, alt: true, cmd: 'app:toggle-whitespace', description: 'Toggle Whitespace Markers' }
    ],

    EXPLORER: [
        { key: 'ArrowDown', cmd: 'explorer:nav', description: 'Select Next' },
        { key: 'ArrowUp', cmd: 'explorer:nav', description: 'Select Previous' },
        { key: 'ArrowRight', cmd: 'explorer:nav', description: 'Expand/Open' },
        { key: 'ArrowLeft', cmd: 'explorer:nav', description: 'Collapse' },
        { key: 'Enter', cmd: 'explorer:nav', description: 'Open Selected' },
        { key: 'Delete', cmd: 'explorer:nav', description: 'Delete Selected' },
        { key: 'c', ctrl: true, cmd: 'explorer:nav', description: 'Copy Path' },
        { key: 'x', ctrl: true, cmd: 'explorer:nav', description: 'Cut Path' },
        { key: 'v', ctrl: true, cmd: 'explorer:nav', description: 'Paste into Folder' },
        { key: 'Tab', cmd: 'explorer:nav', description: 'Focus Next' },
        { key: 'Tab', shift: true, cmd: 'explorer:nav', description: 'Focus Previous' },
        { key: 'F2', cmd: 'explorer:rename', description: 'Rename Item' },
        { key: 'n', ctrl: true, cmd: 'explorer:new-file', description: 'New File in Folder' }
    ],

    EDITOR: [
        { key: 'Tab', ctrl: true, cmd: 'editor:next-tab', description: 'Next Tab' },
        { key: 'Tab', ctrl: true, shift: true, cmd: 'editor:prev-tab', description: 'Previous Tab' },
        { key: 'F12', cmd: 'editor:go-to-definition', description: 'Go to Definition' },
        { key: 'F12', shift: true, cmd: 'editor:find-references', description: 'Find References' },
        { key: '\\', ctrl: true, cmd: 'editor:split-right', description: 'Split Editor Right' },
        { key: 'w', ctrl: true, shift: true, cmd: 'editor:close-split', description: 'Close Split Pane' },
        { key: '\\', ctrl: true, shift: true, cmd: 'editor:focus-other-pane', description: 'Focus Other Pane' },

        // ── Documentation-only ──────────────────────────────────────────────
        // No `cmd` on purpose: these keys are handled by CodeMirror's own keymap
        // (or a view's capture handler). Giving them a cmd would make
        // ShortcutManager preventDefault them and the real handler would never
        // run. They are listed here so they show up in the shortcut guide.
        { key: 'a', alt: true, description: 'Sort Selected Lines' },
        { key: 'm', alt: true, description: 'Remove Duplicate Lines' },
        { key: 'u', ctrl: true, alt: true, description: 'Toggle Word Wrap' },
        { key: 'Tab', description: 'Insert Tab / Indent Selection' },
        { key: 'Tab', shift: true, description: 'Outdent Selection' },
        { key: 'ArrowLeft', alt: true, description: 'Book Mode: Previous Page' },
        { key: 'ArrowRight', alt: true, description: 'Book Mode: Next Page' }
    ],

    CSV: [
        { key: 'e', ctrl: true, shift: true, cmd: 'app:toggle-view-mode', description: 'Toggle View Mode' },
        { key: ' ', shift: true, cmd: 'csv:select-row', description: 'Select Row' },
        // Excel-style column select. Without this CSV-scoped entry the key fell
        // through to the GLOBAL Ctrl+Space (Inline AI) and the column-select
        // branch in CsvEditor.onKeyDown was unreachable.
        { key: ' ', ctrl: true, cmd: 'csv:select-col', description: 'Select Column' },
        { key: 'j', cmd: 'csv:nav', description: 'Jump Mode' },
        { key: 'ArrowUp', cmd: 'csv:nav', description: 'Move Up' },
        { key: 'ArrowDown', cmd: 'csv:nav', description: 'Move Down' },
        { key: 'ArrowLeft', cmd: 'csv:nav', description: 'Move Left' },
        { key: 'ArrowRight', cmd: 'csv:nav', description: 'Move Right' },
        { key: 'ArrowUp', ctrl: true, cmd: 'csv:nav', description: 'Jump to Data Edge' },
        { key: 'ArrowDown', ctrl: true, cmd: 'csv:nav', description: 'Jump to Data Edge' },
        { key: 'ArrowLeft', ctrl: true, cmd: 'csv:nav', description: 'Jump to Data Edge' },
        { key: 'ArrowRight', ctrl: true, cmd: 'csv:nav', description: 'Jump to Data Edge' },
        { key: 'ArrowUp', shift: true, cmd: 'csv:nav', description: 'Select Up' },
        { key: 'ArrowDown', shift: true, cmd: 'csv:nav', description: 'Select Down' },
        { key: 'ArrowLeft', shift: true, cmd: 'csv:nav', description: 'Select Left' },
        { key: 'ArrowRight', shift: true, cmd: 'csv:nav', description: 'Select Right' },
        { key: 'Enter', cmd: 'csv:nav', description: 'Move Down' },
        { key: 'Enter', shift: true, cmd: 'csv:nav', description: 'Move Up' },
        { key: 'Tab', cmd: 'csv:nav', description: 'Move Right' },
        { key: 'Tab', shift: true, cmd: 'csv:nav', description: 'Move Left' },
        { key: 'PageUp', cmd: 'csv:nav', description: 'Page Up' },
        { key: 'PageDown', cmd: 'csv:nav', description: 'Page Down' },
        { key: 'Delete', cmd: 'csv:nav', description: 'Clear Selected Cells' },
        { key: 'Backspace', cmd: 'csv:nav', description: 'Clear Selected Cells' },
        { key: 'F2', cmd: 'csv:nav', description: 'Edit Cell' },
        // Row/Col Operations
        { key: ';', alt: true, cmd: 'csv:nav', description: 'Add Row' },
        { key: '+', alt: true, cmd: 'csv:nav' },
        { key: '-', alt: true, cmd: 'csv:nav', description: 'Delete Row' },
        { key: '=', alt: true, cmd: 'csv:nav' },
        { key: ';', alt: true, shift: true, cmd: 'csv:nav', description: 'Add Column' },
        { key: '+', alt: true, shift: true, cmd: 'csv:nav' },
        { key: '-', alt: true, shift: true, cmd: 'csv:nav', description: 'Delete Column' },
        { key: '=', alt: true, shift: true, cmd: 'csv:nav', description: 'Delete Column' },
        // Insert row / copied rows — Ctrl+Shift+; (Excel-style). Shift+; yields
        // '+' on a JIS keyboard and ':' on US, so match every variant.
        { key: ';', ctrl: true, shift: true, cmd: 'csv:insert-copied-rows', description: 'Insert Row / Copied Rows' },
        { key: '+', ctrl: true, shift: true, cmd: 'csv:insert-copied-rows' },
        { key: ':', ctrl: true, shift: true, cmd: 'csv:insert-copied-rows' },
        // Insert copied columns
        { key: 'v', ctrl: true, alt: true, cmd: 'csv:insert-copied-cols', description: 'Insert Copied Columns' }
    ],

    CSV_EDIT: [
        { key: 'e', ctrl: true, shift: true, cmd: 'app:toggle-view-mode', description: 'Toggle View Mode' },
        { key: 'Enter', cmd: 'csv:nav' },
        { key: 'Enter', shift: true, cmd: 'csv:nav' },
        { key: 'Tab', cmd: 'csv:nav' },
        { key: 'Tab', shift: true, cmd: 'csv:nav' },
        { key: 'Escape', cmd: 'csv:cancel' }
    ],

    SEARCH: [
        { key: 'e', alt: true, cmd: 'search:regex', description: 'Toggle Regex' },
        { key: 'c', alt: true, cmd: 'search:case', description: 'Toggle Case Sensitivity' },
        { key: 'w', alt: true, cmd: 'search:word', description: 'Toggle Word Match' },
        { key: 'p', alt: true, cmd: 'search:toggle-replace', description: 'Toggle Replace Mode' },
        { key: 'a', alt: true, cmd: 'search:replace-all', description: 'Replace All' },
        { key: 'Enter', cmd: 'search:execute', description: 'Search & Close' },
        { key: 'Enter', shift: true, cmd: 'search:prev', description: 'Find Previous' },
        { key: 'Escape', cmd: 'search:close', description: 'Close Search' }
    ],

    MARKDOWN: [
        { key: 'Enter', ctrl: true, cmd: 'md:save', description: 'Save & Close' },
        { key: 's', ctrl: true, cmd: 'md:save', description: 'Save & Close' },
        { key: 'e', ctrl: true, cmd: 'md:toggle-mode', description: 'Switch Table / Text Editor' },
        { key: 'Escape', cmd: 'md:cancel', description: 'Cancel & Close' },
        { key: '?', ctrl: true, cmd: 'md:shortcut-guide', description: 'Shortcut Guide' },
        { key: '/', ctrl: true, shift: true, cmd: 'md:shortcut-guide' },
        // Formatting — these map to the toolbar tools by key+shift
        // (see the `tools` array in MarkdownView.applyFormat).
        { key: 'b', ctrl: true, cmd: 'md:format', description: 'Bold' },
        { key: 'i', ctrl: true, cmd: 'md:format', description: 'Italic' },
        { key: 'k', ctrl: true, cmd: 'md:format', description: 'Link' },
        { key: 'u', ctrl: true, shift: true, cmd: 'md:format', description: 'List' },
        { key: 'o', ctrl: true, shift: true, cmd: 'md:format', description: 'Numbered List' },
        { key: 't', ctrl: true, shift: true, cmd: 'md:format', description: 'Task List' },
        { key: 'q', ctrl: true, shift: true, cmd: 'md:format', description: 'Quote' },
        { key: 'j', ctrl: true, shift: true, cmd: 'md:format', description: 'Code Block' },
        { key: '-', ctrl: true, shift: true, cmd: 'md:format', description: 'Horizontal Rule' },
        { key: 'e', ctrl: true, shift: true, cmd: 'app:toggle-view-mode', description: 'Toggle View Mode' },
        // Documentation-only (no cmd): holding Alt reveals a letter/number hint
        // on every toolbar button; pressing it applies that format.
        { key: 'Alt', description: 'Show toolbar format hints (hold)' }
    ],

    MARKDOWN_TABLE: [
        { key: 'Enter', ctrl: true, cmd: 'md:save', description: 'Save & Close' },
        { key: 's', ctrl: true, cmd: 'md:save', description: 'Save & Close' },
        { key: 'e', ctrl: true, cmd: 'md:toggle-mode', description: 'Toggle Mode' },
        { key: 'Escape', cmd: 'md:cancel', description: 'Cancel & Close' },
        { key: '?', ctrl: true, cmd: 'md:shortcut-guide', description: 'Shortcut Guide' },
        { key: '/', ctrl: true, shift: true, cmd: 'md:shortcut-guide' },
        // Table Ops (Handled locally by TableEditor for context awareness, 
        // but Ctrl+Space needs definition to override Global AI)
        { key: ' ', ctrl: true, cmd: 'md:table-row-select', description: 'Select Row' },
        // F2 starts cell editing, handled by TableEditor's own key handler.
        // Deliberately no `cmd`: giving it one would make ShortcutManager
        // preventDefault and block the cell handler (and the GLOBAL F2
        // md-block:edit is short-circuited for this scope in ShortcutManager).
        { key: 'F2', description: 'Edit Cell' },
        { key: 'e', ctrl: true, shift: true, cmd: 'app:toggle-view-mode', description: 'Toggle View Mode' }
    ],

    MARKDOWN_BLOCK: [
        { key: 'ArrowUp', cmd: 'md-block:nav', description: 'Previous Block' },
        { key: 'ArrowDown', cmd: 'md-block:nav', description: 'Next Block' },
        { key: 'ArrowUp', alt: true, cmd: 'md-block:move', description: 'Move Block Up' },
        { key: 'ArrowDown', alt: true, cmd: 'md-block:move', description: 'Move Block Down' },
        { key: 'Enter', cmd: 'md-block:edit', description: 'Edit Block' },
        { key: 'F2', cmd: 'md-block:edit', description: 'Edit Block' }
    ],
    AI_REVIEW: [
        { key: 'a', alt: true, cmd: 'ai-review:accept', description: 'Accept Change' },
        { key: 'r', alt: true, cmd: 'ai-review:reject', description: 'Reject Change' },
        { key: 'p', alt: true, cmd: 'ai-review:prev', description: 'Previous Change' },
        { key: 'n', alt: true, cmd: 'ai-review:next', description: 'Next Change' },
        { key: 'Escape', cmd: 'ai-review:cancel', description: 'Cancel Review' }
    ],

    STRUCTURE_EDIT: [
        { key: 's', ctrl: true, cmd: 'structure:save', description: 'Apply and Save' }
    ]
};
