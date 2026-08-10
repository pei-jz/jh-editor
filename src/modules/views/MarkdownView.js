import { BaseView } from './BaseView.js';
import { State } from '../core/Store.js';
import { EL } from '../core/Constants.js';
import * as Markdown from '../utils/Markdown.js';
import { TableEditor } from '../editors/TableEditor.js';
import { open } from '@tauri-apps/plugin-shell';
import { showShortcutGuide, hideShortcutGuide, toggleShortcutGuide } from '../ui/ShortcutGuide.js';
import { setupDraggablePreview, confirmDiscardChange } from '../ui/Modal.js';
import { shortcuts } from '../core/ShortcutManager.js';
import { SHORTCUTS } from '../core/ShortcutDefinitions.js';
import { SyntaxHighlighter } from '../utils/SyntaxHighlighter.js';
import * as MdAssets from '../utils/MarkdownAssets.js';
import { MermaidHelper } from '../ui/MermaidHelper.js';
import { enableLightbox } from '../ui/Lightbox.js';
import { invoke } from '@tauri-apps/api/core';
import { PageFlip } from 'page-flip';
// CodeMirror 6 — powers the block editor (replacing the plain textarea).
import { EditorView, keymap, drawSelection, dropCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';

/* global marked */

/** Styles for the block-edit modal (source left, live preview right). */
function _injectBlockEditStyles() {
    if (document.getElementById('md-block-edit-styles')) return;
    const style = document.createElement('style');
    style.id = 'md-block-edit-styles';
    style.textContent = `
    #md-block-edit-overlay {
        position: fixed; inset: 0; z-index: 2500;
        background: rgba(0,0,0,0.40);
        display: flex; align-items: center; justify-content: center;
    }
    .mbe-box {
        width: min(1180px, 94vw); height: min(760px, 88vh);
        min-width: 640px; min-height: 360px; max-width: 99vw; max-height: 98vh;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 8px;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 12px 40px rgba(0,0,0,0.35);
        resize: both; position: relative;
    }
    .mbe-head {
        display: flex; align-items: center; gap: 8px;
        padding: 9px 14px; border-bottom: 1px solid var(--border-color);
        background: var(--header-bg); font-size: 12px;
    }
    .mbe-title { font-weight: 600; }
    .mbe-pos {
        font-size: 10px; opacity: 0.6; border: 1px solid currentColor;
        border-radius: 3px; padding: 0 5px;
        font-family: var(--editor-font-family, monospace);
    }
    .mbe-spacer { flex: 1; }
    .mbe-hint { font-size: 11px; opacity: 0.55; }

    .mbe-body { flex: 1; display: flex; min-height: 0; }
    .mbe-left { flex: 1 1 55%; min-width: 260px; display: flex; flex-direction: column; min-height: 0; }
    /* The editor container fills the pane instead of hugging a block. */
    .mbe-left .editor-block-container { flex: 1; min-height: 0; }
    .mbe-left .block-cm { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .mbe-left .block-cm .cm-editor { flex: 1; min-height: 0; max-height: none; }

    .mbe-split { flex: 0 0 5px; cursor: col-resize; transition: background .12s ease; }
    .mbe-split:hover, .mbe-split.dragging { background: var(--primary-color); opacity: 0.55; }

    .mbe-right { flex: 1 1 45%; min-width: 220px; display: flex; flex-direction: column; border-left: 1px solid var(--border-color); }
    .mbe-right-head {
        padding: 6px 12px; font-size: 11px; font-weight: 600; opacity: 0.7;
        border-bottom: 1px solid var(--border-color); background: var(--bg-color-secondary, var(--bg-color));
    }
    /* The shared preview node, re-homed into the modal. */
    .mbe-preview {
        flex: 1; overflow: auto; padding: 14px 16px;
        display: block; position: static; width: auto; height: auto;
        max-width: none; max-height: none; border: none; box-shadow: none;
        background: transparent;
    }
    .mbe-foot {
        padding: 10px 14px; border-top: 1px solid var(--border-color);
        background: var(--header-bg); flex-shrink: 0;
    }
    `;
    document.head.appendChild(style);
}

export class MarkdownView extends BaseView {
    constructor(container, callbacks = {}) {
        super(container);
        this.updateStatusBar = callbacks.updateStatusBar;
        this.renderEditor = callbacks.renderEditor;
        this.renderTabs = callbacks.renderTabs;
        this.updateOutline = callbacks.updateOutline;

        this._onFontChange = () => {
            if (State.markdownViewMode === 'book') {
                if (this.file) {
                    this.render(this.file.content, this.file);
                }
            }
        };
        window.addEventListener('fontSettingsChanged', this._onFontChange);
    }

    render(content, file) {
        if (this.pageFlipInstance) {
            try { this.pageFlipInstance.destroy(); } catch (e) { /* ignore */ }
            this.pageFlipInstance = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._keydownHandler) {
            window.removeEventListener('keydown', this._keydownHandler, true);
            this._keydownHandler = null;
        }
        if (this._navKeyHandler) {
            window.removeEventListener('keydown', this._navKeyHandler, true);
            this._navKeyHandler = null;
        }
        if (this._progressDragCleanup) {
            try { this._progressDragCleanup(); } catch (e) {}
            this._progressDragCleanup = null;
        }

        this.container.innerHTML = '';
        this.file = file;

        // Markdown Mode global listeners (mirroring Editor.js)
        const fileSize = new TextEncoder().encode(content).length;
        
        // Improve block splitting: don't split inside code blocks (```)
        const blocks = this._splitIntoBlocks(content);
        this.blocksData = blocks;

        // Toggle View Mode Button — unified `.cm-view-toolbar` look (same as the
        // plain-text editor's toolbar) instead of the old absolute-positioned
        // `.md-view-mode-toggle` pills, which overlapped each other.
        const toolbar = document.createElement('div');
        toolbar.className = 'cm-view-toolbar';
        this.container.appendChild(toolbar);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'cm-toolbar-btn';
        const _bookIcon = `<svg class="cm-tb-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/></svg>`;
        toggleBtn.innerHTML = `${_bookIcon}<span>${State.markdownViewMode === 'book' ? 'Scroll Mode' : 'Book Mode'}</span>`;
        toggleBtn.title = 'Toggle Book / Scroll view — Ctrl+Alt+B';
        toggleBtn.onclick = (e) => { e.stopPropagation(); this.toggleBookMode(); };
        toolbar.appendChild(toggleBtn);

        // Export to PDF (via the system print dialog → "Save as PDF").
        const exportBtn = document.createElement('button');
        exportBtn.className = 'cm-toolbar-btn';
        exportBtn.innerHTML = `<svg class="cm-tb-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg><span>PDF</span>`;
        exportBtn.title = 'Export as PDF';
        exportBtn.onclick = (e) => { e.stopPropagation(); this.exportToPdf(); };
        toolbar.appendChild(exportBtn);

        // Backlinks — which notes link here via [[wiki links]].
        const backlinkBtn = document.createElement('button');
        backlinkBtn.className = 'cm-toolbar-btn';
        backlinkBtn.innerHTML = `<svg class="cm-tb-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg><span>Backlinks</span>`;
        backlinkBtn.title = 'Find notes that [[link]] to this one';
        backlinkBtn.onclick = (e) => { e.stopPropagation(); this.showBacklinks(); };
        toolbar.appendChild(backlinkBtn);

        if (State.markdownViewMode === 'book') {
            this._renderBookMode(blocks);
            return;
        }

        // Intersection Observer for lazy rendering
        this.renderQueue = [];
        this.isProcessingQueue = false;

        const processQueue = () => {
            if (this.renderQueue.length === 0) {
                this.isProcessingQueue = false;
                return;
            }
            this.isProcessingQueue = true;

            // Process a few items or use requestIdleCallback
            const run = (deadline) => {
                while ((deadline.timeRemaining() > 5 || deadline.didTimeout) && this.renderQueue.length > 0) {
                    const div = this.renderQueue.shift();
                    this._renderBlockInternal(div);
                }

                if (this.renderQueue.length > 0) {
                    requestIdleCallback(run);
                } else {
                    this.isProcessingQueue = false;
                }
            };

            if (window.requestIdleCallback) {
                requestIdleCallback(run);
            } else {
                // Fallback for browsers without requestIdleCallback
                const fallback = () => {
                    const start = Date.now();
                    while (this.renderQueue.length > 0 && Date.now() - start < 16) {
                        const div = this.renderQueue.shift();
                        this._renderBlockInternal(div);
                    }
                    if (this.renderQueue.length > 0) setTimeout(fallback, 10);
                    else this.isProcessingQueue = false;
                };
                fallback();
            }
        };

        this.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const div = entry.target;
                    if (!div.dataset.rendered && !this.renderQueue.includes(div)) {
                        this.renderQueue.push(div);
                    }
                }
            });
            if (!this.isProcessingQueue && this.renderQueue.length > 0) {
                processQueue();
            }
        }, { rootMargin: '300px' });

        blocks.forEach((blockText, i) => {
            const div = document.createElement('div');
            div.className = 'md-block md-body';
            div.dataset.index = i;
            div.tabIndex = -1;
            div.style.minHeight = '1.5em'; // Slightly smaller placeholder

            if (State.vimState.selectedIndex === i) {
                div.classList.add('selected');
            }

            this.container.appendChild(div);
            this.observer.observe(div);

            // Add click listener for selection
            div.onclick = (e) => {
                if (div.classList.contains('editing')) return;
                this.selectBlock(i);
            };
        });

        const phantom = document.createElement('div');
        phantom.className = 'md-block phantom';
        phantom.textContent = '+ Add Block';
        phantom.onclick = () => this.enterEditMode(phantom, '', blocks.length);
        if (State.vimState.selectedIndex === blocks.length) {
            phantom.classList.add('selected');
        }
        this.container.appendChild(phantom);
        this._installBlockNavKeys();

        // Restore the previous scroll position (saved in destroy()). Block
        // placeholders reserve height up front, so the total is close enough
        // before lazy rendering fills them in.
        const savedTop = file && file._mdScrollTop;
        if (savedTop) {
            requestAnimationFrame(() => { if (this.container) this.container.scrollTop = savedTop; });
        }
    }

    _splitIntoBlocks(content) {
        if (!content) return [];
        const lines = content.split(/\r?\n/);
        const blocks = [];
        let currentBlock = [];
        let inCodeBlock = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Toggle code block state
            if (line.trim().startsWith('```')) {
                inCodeBlock = !inCodeBlock;
            }

            // If not in code block and line is empty (or whitespace only)
            // and we have content in current block, finish the block
            if (!inCodeBlock && line.trim() === '') {
                // Check if next lines are also empty to handle multiple empty lines
                if (currentBlock.length > 0) {
                    blocks.push(currentBlock.join('\n'));
                    currentBlock = [];
                }
            } else {
                currentBlock.push(line);
            }
        }

        if (currentBlock.length > 0) {
            blocks.push(currentBlock.join('\n'));
        }

        return blocks;
    }

    _renderBlockInternal(div) {
        const index = parseInt(div.dataset.index);
        const blockText = this.blocksData[index];

        if (!div.dataset.rendered && blockText) {
            try {
                if (typeof marked !== 'undefined') {
                    div.innerHTML = this._parseMarkdown(blockText);

                    // Delegate link clicks on this block
                    div.addEventListener('click', (e) => {
                        const link = e.target.closest('a[data-file-link], a[data-url-link]');
                        if (!link) return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (link.dataset.urlLink) {
                            this._openUrlInBrowser(link.dataset.urlLink);
                        } else if (link.dataset.fileLink) {
                            this._openFileFromLink(link.dataset.fileLink);
                        }
                    });
                    // Relative-file links get a hover preview popup (task: 相対参照のプレビュー).
                    div.querySelectorAll('a[data-file-link]').forEach((a) => {
                        if (a.dataset.fileLink) this._installLinkPreview(a, a.dataset.fileLink);
                    });
                } else {
                    div.textContent = blockText;
                }

                const icon = document.createElement('div');
                icon.className = 'edit-icon';
                icon.textContent = '✎';
                icon.onclick = (e) => {
                    e.stopPropagation();
                    this.enterEditMode(div, blockText, index);
                };
                div.appendChild(icon);
                div.ondblclick = (e) => {
                    e.stopPropagation();
                    this.enterEditMode(div, blockText, index);
                };

                div.dataset.rendered = "true";
                setTimeout(async () => {
                    if (!div.isConnected) return;
                    await Markdown.renderMermaid(div);
                    // KaTeX is loaded lazily and only when the block has math.
                    if (MdAssets.hasMath(blockText)) MdAssets.renderMath(div);
                    // Diagrams/images become click-to-zoom once they exist.
                    if (div.isConnected) enableLightbox(div);
                }, 50);
            } catch (e) {
                console.error('Markdown block render error', e);
            }
        }
    }

    enterEditMode(blockElement, originalText, blockIndex) {
        if (blockElement.classList.contains('editing')) return;

        State.vimState.mode = 'insert';

        const isPhantom = blockElement.classList.contains('phantom');
        if (isPhantom) {
            blockElement.classList.remove('phantom');
            blockElement.textContent = '';
        }

        const { overlay: previewModal, content: previewContent } = EL.previewModal;
        setupDraggablePreview();

        const runMermaidPreview = () => {
            if (typeof marked === 'undefined') return;
            Markdown.renderMermaid(previewContent).then(() => {
                if (MdAssets.hasMath(previewContent.textContent)) MdAssets.renderMath(previewContent);
                enableLightbox(previewContent);
            });
        };

        // The preview now lives inside the edit modal's right pane, so the old
        // floating preview window stays hidden (its content node is borrowed).
        previewModal.style.display = 'none';
        
        const closeBtn = document.querySelector('.close-preview');
        if (typeof marked !== 'undefined') {
            previewContent.innerHTML = this._parseMarkdown(originalText || '*(New Block)*');
            setTimeout(runMermaidPreview, 100);
        }

        // Handle link clicks in the preview modal
        previewContent.addEventListener('click', (e) => {
            const link = e.target.closest('a[data-file-link], a[data-url-link]');
            if (!link) return;
            e.preventDefault();
            e.stopPropagation();
            if (link.dataset.urlLink) {
                this._openUrlInBrowser(link.dataset.urlLink);
            } else if (link.dataset.fileLink) {
                this._openFileFromLink(link.dataset.fileLink);
            }
        }, true);

        let isTableMode = TableEditor.isTable(originalText || '');
        let tableData = isTableMode ? TableEditor.parse(originalText) : [];

        // Initial setup for shortcuts
        const scope = isTableMode ? 'MARKDOWN_TABLE' : 'MARKDOWN';
        shortcuts.unregisterScope('MARKDOWN');
        shortcuts.unregisterScope('MARKDOWN_TABLE');
        shortcuts.setScope(scope);

        blockElement.classList.add('editing');
        blockElement.innerHTML = '';
        hideShortcutGuide();

        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.height = '100%';
        container.classList.add('editor-block-container');

        // Block editor is a CodeMirror 6 instance (was a plain <textarea>).
        // A thin `textarea`-shaped shim keeps the rest of enterEditMode unchanged:
        // `.value` get/set, `.focus()`, `.style` (display toggle) and
        // addEventListener('input'|'focus') all proxy to the CM view.
        const cmParent = document.createElement('div');
        cmParent.className = 'block-editor block-cm';
        cmParent.style.minHeight = '150px';
        cmParent.style.display = isTableMode ? 'none' : 'block';

        const _cmInputHandlers = [];
        // Pick a highlight style that suits the active theme's background:
        // defaultHighlightStyle is tuned for light backgrounds and reads as
        // low-contrast on dark themes, so switch to the one-dark palette there.
        const _bgRgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
        const _isDarkTheme = _bgRgb
            ? (0.299 * +_bgRgb[0] + 0.587 * +_bgRgb[1] + 0.114 * +_bgRgb[2]) < 128
            : false;
        const cmView = new EditorView({
            doc: originalText || '',
            parent: cmParent,
            extensions: [
                history(),
                drawSelection(),
                dropCursor(),
                keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
                markdown(),
                EditorView.lineWrapping,
                syntaxHighlighting(_isDarkTheme ? oneDarkHighlightStyle : defaultHighlightStyle),
                EditorView.updateListener.of((u) => {
                    if (u.docChanged) _cmInputHandlers.forEach((h) => h());
                }),
                // Paste / drop an image → save it next to the document and
                // insert a relative Markdown image link.
                EditorView.domEventHandlers({
                    paste: (event, view) => this._handleImageDrop(event, view),
                    drop: (event, view) => this._handleImageDrop(event, view),
                }),
            ],
        });
        this._blockCM = cmView;

        // textarea-compatible shim over the CM view.
        const textarea = {
            get value() { return cmView.state.doc.toString(); },
            set value(v) {
                cmView.dispatch({
                    changes: { from: 0, to: cmView.state.doc.length, insert: v || '' },
                });
            },
            focus() { cmView.focus(); },
            setSelectionRange(from, to) {
                const len = cmView.state.doc.length;
                cmView.dispatch({ selection: { anchor: Math.min(from, len), head: Math.min(to, len) } });
            },
            style: cmParent.style,
            addEventListener(type, cb) {
                if (type === 'input') _cmInputHandlers.push(cb);
                else if (type === 'focus') cmView.contentDOM.addEventListener('focus', cb);
                else if (type === 'keydown') cmView.contentDOM.addEventListener('keydown', cb);
            },
            dispatchEvent() { _cmInputHandlers.forEach((h) => h()); },
        };

        const tableContainer = document.createElement('div');
        tableContainer.style.overflow = 'auto';
        tableContainer.style.display = isTableMode ? 'block' : 'none';

        const syncTableToText = () => {
            textarea.value = TableEditor.serialize(tableData);
            if (typeof marked !== 'undefined') {
                previewContent.innerHTML = this._parseMarkdown(textarea.value);
                runMermaidPreview();
            }
        };

        // Initial render for table if in table mode
        if (isTableMode) {
            TableEditor.render(tableContainer, tableData, syncTableToText);
        }

        const toggleMode = () => {
            isTableMode = !isTableMode;
            if (isTableMode) {
                const currentText = textarea.value;
                if (TableEditor.isTable(currentText) || currentText.trim() === '') {
                    if (currentText.trim() === '') {
                        tableData = [['Header 1', 'Header 2'], ['Row 1', 'Row 2']];
                    } else {
                        tableData = TableEditor.parse(currentText);
                    }
                    TableEditor.render(tableContainer, tableData, syncTableToText);
                    textarea.style.display = 'none';
                    tableContainer.style.display = 'block';
                    syncTableToText();
                } else {
                    import('@tauri-apps/plugin-dialog').then(({ message }) => {
                        message('Current text is not recognized as a valid table.', { title: 'Invalid Table', kind: 'info' });
                    });
                    isTableMode = false;
                }
            } else {
                textarea.style.display = 'block';
                tableContainer.style.display = 'none';
                textarea.focus();
            }
            this._updateToggleText(toggleBtn, isTableMode);
        };

        const showAltHints = () => {
            const keys = '123456789abcdefghijklmnopqrstuvwxyz';
            toolbar.querySelectorAll('button').forEach((btn, i) => {
                if (i < keys.length) {
                    const hintName = keys[i];
                    const hint = document.createElement('span');
                    hint.className = 'alt-shortcut-hint';
                    hint.textContent = hintName;
                    btn.appendChild(hint);
                }
            });
        };

        const hideAltHints = () => {
            toolbar.querySelectorAll('.alt-shortcut-hint').forEach(h => h.remove());
        };

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'toggle-mode-btn';
        this._updateToggleText(toggleBtn, isTableMode);
        toggleBtn.onclick = toggleMode;

        const tools = [
            { label: 'B', wrap: '**', key: 'b' },
            { label: 'I', wrap: '*', key: 'i' },
            { label: 'Link', wrap: ['[', '](url)'], key: 'k' },
            { label: '#', prefix: '# ' },
            { label: '##', prefix: '## ' },
            { label: 'List', prefix: '- ', key: 'u', shift: true },
            { label: 'Num', prefix: '1. ', key: 'o', shift: true },
            { label: 'Task', prefix: '- [ ] ', key: 't', shift: true },
            { label: 'Quote', prefix: '> ', key: 'q', shift: true },
            { label: 'Code', wrap: ['```\n', '\n```'], key: 'j', shift: true },
            { label: 'HR', insert: '\n---\n', key: '-', shift: true },
            { label: 'Table', insert: '\n| A | B |\n|---|---|\n| 1 | 2 |\n' },
            // Opens the helper (templates + live preview + syntax reference)
            // instead of dropping a stub the user then has to look up.
            { label: 'Mermaid', helper: 'mermaid' }
        ];

        const applyFormat = (tool) => {
            cmView.focus();
            const sel = cmView.state.selection.main;
            const from = sel.from, to = sel.to;
            const selText = cmView.state.sliceDoc(from, to);

            // Helper-backed tools open a dialog and insert asynchronously.
            if (tool.helper === 'mermaid') {
                // If the caret sits in an existing ```mermaid block, edit it.
                const existing = this._mermaidBlockAt(cmView.state.doc.toString(), from);
                MermaidHelper.show((markdown) => {
                    const target = existing || { from, to };
                    cmView.dispatch({
                        changes: { from: target.from, to: target.to, insert: markdown },
                        selection: { anchor: target.from + markdown.length },
                    });
                    cmView.focus();
                }, existing ? existing.code : selText.trim());
                return;
            }

            if (tool.wrap) {
                const pre = Array.isArray(tool.wrap) ? tool.wrap[0] : tool.wrap;
                const suf = Array.isArray(tool.wrap) ? tool.wrap[1] : tool.wrap;
                const anchor = from + pre.length;
                cmView.dispatch({
                    changes: { from, to, insert: pre + selText + suf },
                    // Keep the original text selected between the inserted markers.
                    selection: { anchor, head: anchor + selText.length },
                });
            } else if (tool.prefix) {
                // Line markers (headings/list/quote) go at the start of the line.
                const line = cmView.state.doc.lineAt(from);
                const len = tool.prefix.length;
                cmView.dispatch({
                    changes: { from: line.from, to: line.from, insert: tool.prefix },
                    selection: { anchor: from + len, head: to + len },
                });
            } else if (tool.insert) {
                cmView.dispatch({
                    changes: { from, to, insert: tool.insert },
                    selection: { anchor: from + tool.insert.length },
                });
            }
            // updateListener fires the 'input' handlers (preview refresh) on docChanged.
            cmView.focus();
        };

        const toolbar = document.createElement('div');
        toolbar.className = 'editor-toolbar';
        tools.forEach(tool => {
            const btn = document.createElement('button');
            btn.textContent = tool.label;
            if (tool.key) btn.title = `Ctrl+${tool.shift ? 'Shift+' : ''}${tool.key.toUpperCase()}`;
            btn.onmousedown = (e) => { e.preventDefault(); applyFormat(tool); };
            toolbar.appendChild(btn);
        });

        const destroyBlockCM = () => {
            if (this._blockCM) { this._blockCM.destroy(); this._blockCM = null; }
        };

        const saveAndClose = () => {
            const finalContent = isTableMode ? TableEditor.serialize(tableData) : textarea.value;
            this.saveBlock(blockIndex, finalContent);
            destroyBlockCM();
            blockElement.classList.remove('editing');
            previewModal.style.display = 'none';
            this._closeEditModal();
            hideShortcutGuide();
            if (closeBtn) closeBtn.onclick = null;
            if (State.vimState.mode !== 'normal') State.vimState.mode = 'normal';

            shortcuts.unregisterScope(scope);
            shortcuts.setScope('EDITOR');

            if (this.renderEditor) this.renderEditor();

            setTimeout(() => {
                this.selectBlock(blockIndex);
            }, 50);
        };

        const cancelAndClose = async () => {
            if (textarea.value !== originalText) {
                const choice = await confirmDiscardChange();
                if (choice !== 'YES') return;
            }
            destroyBlockCM();
            blockElement.classList.remove('editing');
            previewModal.style.display = 'none';
            this._closeEditModal();
            hideShortcutGuide();

            if (closeBtn) closeBtn.onclick = null;

            shortcuts.unregisterScope(scope);
            shortcuts.setScope('EDITOR');

            if (this.renderEditor) this.renderEditor();

            setTimeout(() => {
                this.selectBlock(blockIndex);
            }, 50);
        };

        const mdActions = {
            'md:shortcut-guide': (e) => {
                e.preventDefault(); e.stopPropagation();
                toggleShortcutGuide(isTableMode ? 'table' : 'text');
            },
            'md:toggle-mode': (e) => {
                e.preventDefault();
                toggleMode();
                const newScope = isTableMode ? 'MARKDOWN_TABLE' : 'MARKDOWN';
                registerShortcuts(newScope);
            },
            'md:save': (e) => {
                e.preventDefault();
                saveAndClose();
            },
            'md:cancel': (e) => {
                e.preventDefault();
                cancelAndClose();
            },
            'md:format': (e) => {
                const key = e.key.toLowerCase();
                const tool = tools.find(t => t.key === key && !!t.shift === e.shiftKey);
                if (tool) { e.preventDefault(); applyFormat(tool); }
            },
            'md:table-row-select': (e) => {
                if (!isTableMode) return;
                e.preventDefault();
                e.stopPropagation();
                const activeCell = tableContainer.querySelector('.active-cell');
                if (activeCell) {
                    const r = parseInt(activeCell.dataset.row);
                    TableEditor.selectRow(tableContainer, r);
                }
            },
            'md:table-op': (e) => {
                if (!isTableMode) return;
            },
            'md:format-index': (e) => {
                const keys = '123456789abcdefghijklmnopqrstuvwxyz';
                const char = e.key.toLowerCase();
                const index = keys.indexOf(char);
                const tool = tools[index];
                if (tool) { e.preventDefault(); applyFormat(tool); }
            },
            'app:toggle-view-mode': (e) => {
                e.preventDefault();
                const finalContent = isTableMode ? TableEditor.serialize(tableData) : textarea.value;
                this.saveBlock(blockIndex, finalContent);
                blockElement.classList.remove('editing');
                previewModal.style.display = 'none';
                this._closeEditModal();
                hideShortcutGuide();
                
                if (window.app && window.app.toggleViewMode) {
                    window.app.toggleViewMode();
                } else {
                    window.dispatchEvent(new CustomEvent('shortcutTriggered', { detail: { command: 'app:toggle-view-mode' } }));
                }
            }
        };

        const registerShortcuts = (targetScope) => {
            shortcuts.unregisterScope('MARKDOWN');
            shortcuts.unregisterScope('MARKDOWN_TABLE');
            
            const config = targetScope === 'MARKDOWN_TABLE' ? SHORTCUTS.MARKDOWN_TABLE : SHORTCUTS.MARKDOWN;
            
            config.forEach(s => {
                if (mdActions[s.cmd]) {
                    shortcuts.register({ ...s, action: mdActions[s.cmd], scope: targetScope });
                }
            });

            if (targetScope === 'MARKDOWN_TABLE') {
                toolbar.style.display = 'none';
            } else {
                toolbar.style.display = 'flex';
            }

            const keys = '123456789abcdefghijklmnopqrstuvwxyz';
            for (let i = 0; i < Math.min(keys.length, tools.length); i++) {
                shortcuts.register({ key: keys[i], alt: true, cmd: 'md:format-index', scope: targetScope, action: mdActions['md:format-index'] });
            }
            
            shortcuts.setScope(targetScope);
        };

        registerShortcuts(scope);

        textarea.addEventListener('focus', () => {
            const currentScope = isTableMode ? 'MARKDOWN_TABLE' : 'MARKDOWN';
            shortcuts.setScope(currentScope);
        });

        tableContainer.addEventListener('focusin', () => {
            if (isTableMode) shortcuts.setScope('MARKDOWN_TABLE');
        });

        let hintsVisible = false;
        const toggleAltHints = (show) => {
            hintsVisible = show !== undefined ? show : !hintsVisible;
            if (hintsVisible) showAltHints();
            else hideAltHints();
        };

        const handleKeyDown = (e) => {
            if (e.key === 'Alt') {
                e.preventDefault();
                toggleAltHints();
            } else if (e.key === 'Escape' && hintsVisible) {
                toggleAltHints(false);
            } else if (hintsVisible) {
                const keys = '123456789abcdefghijklmnopqrstuvwxyz';
                const char = e.key.toLowerCase();
                const index = keys.indexOf(char);
                const tool = tools[index];
                if (tool) {
                    e.preventDefault();
                    applyFormat(tool);
                }
            }
        };

        container.addEventListener('keydown', handleKeyDown);

        // Debounced: re-parsing + re-rendering diagrams on every keystroke made
        // mermaid runs pile up on top of each other (which surfaced as spurious
        // "Syntax error in text"), and wasted work on a fast typist.
        let _previewTimer = null;
        textarea.addEventListener('input', () => {
            if (typeof marked === 'undefined') return;
            clearTimeout(_previewTimer);
            _previewTimer = setTimeout(() => {
                previewContent.innerHTML = this._parseMarkdown(textarea.value);
                runMermaidPreview();
            }, 250);
        });

        const actions = document.createElement('div');
        actions.className = 'edit-actions';
        actions.style.display = 'flex';
        actions.style.gap = '10px';
        actions.style.alignItems = 'center';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-cancel';
        cancelBtn.textContent = 'Cancel (Esc)';
        cancelBtn.onclick = cancelAndClose;

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-save';
        saveBtn.textContent = 'Save (Ctrl+Enter)';
        saveBtn.onclick = saveAndClose;

        toggleBtn.style.margin = '0';
        toggleBtn.style.marginRight = 'auto';
        toggleBtn.style.width = 'auto';

        actions.appendChild(toggleBtn);
        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);

        container.appendChild(toolbar);
        container.appendChild(cmParent);
        container.appendChild(tableContainer);

        // Editing happens in a roomy modal (source left, live preview right)
        // rather than inside the block itself: an in-place box is bounded by the
        // block's position and had to fight the floating preview for space.
        this._buildEditModal({
            container, actions, previewPane: previewContent,
            blockIndex, total: this.blocksData.length,
            onBackdropClose: cancelAndClose,
        });

        if (typeof marked !== 'undefined') {
            previewContent.innerHTML = this._parseMarkdown(textarea.value);
            runMermaidPreview();
        }
        if (closeBtn) {
            closeBtn.onclick = cancelAndClose;
        }
        if (isTableMode) {
            syncTableToText();
        } else {
            requestAnimationFrame(() => {
                textarea.focus();
                textarea.setSelectionRange(0, 0);
            });
        }
    }

    /**
     * Mount the block editor in a resizable modal: source on the left, the live
     * preview on the right, with a draggable splitter between them.
     * The preview element is the app's shared preview node, moved in here so all
     * the existing preview wiring keeps working.
     */
    _buildEditModal({ container, actions, previewPane, blockIndex, total, onBackdropClose }) {
        _injectBlockEditStyles();
        document.getElementById('md-block-edit-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'md-block-edit-overlay';

        const box = document.createElement('div');
        box.className = 'mbe-box';

        const head = document.createElement('div');
        head.className = 'mbe-head';
        const pos = total > 0 ? `${Math.min(blockIndex + 1, total)} / ${total}` : 'new';
        head.innerHTML = `<span class="mbe-title">Edit Block</span>`
            + `<span class="mbe-pos">${pos}</span>`
            + `<span class="mbe-spacer"></span>`
            + `<span class="mbe-hint">Ctrl+Enter to save · Esc to cancel</span>`;

        const body = document.createElement('div');
        body.className = 'mbe-body';

        const left = document.createElement('div');
        left.className = 'mbe-left';
        left.appendChild(container);

        const split = document.createElement('div');
        split.className = 'mbe-split';
        split.title = 'Drag to resize';

        const right = document.createElement('div');
        right.className = 'mbe-right';
        const rightHead = document.createElement('div');
        rightHead.className = 'mbe-right-head';
        rightHead.textContent = 'Preview';
        // Re-home the shared preview node; restore() puts it back on close.
        this._previewHome = { node: previewPane, parent: previewPane.parentElement, next: previewPane.nextSibling };
        previewPane.classList.add('mbe-preview');
        right.append(rightHead, previewPane);

        body.append(left, split, right);
        box.append(head, body, actions);
        actions.classList.add('mbe-foot');
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // Splitter: resize the source pane, preview takes the remainder.
        split.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            let last = e.clientX;
            const prevSel = document.body.style.userSelect;
            document.body.style.userSelect = 'none';
            split.classList.add('dragging');
            const move = (ev) => {
                const w = left.getBoundingClientRect().width + (ev.clientX - last);
                last = ev.clientX;
                const max = body.getBoundingClientRect().width - 220;
                left.style.flex = `0 0 ${Math.min(Math.max(260, w), Math.max(260, max))}px`;
            };
            const up = () => {
                split.classList.remove('dragging');
                document.body.style.userSelect = prevSel;
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        });

        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay && typeof onBackdropClose === 'function') onBackdropClose();
        });

        this._editOverlay = overlay;
    }

    /** Tear the edit modal down and put the shared preview node back. */
    _closeEditModal() {
        const home = this._previewHome;
        if (home && home.node) {
            home.node.classList.remove('mbe-preview');
            home.node.innerHTML = '';
            if (home.parent) home.parent.insertBefore(home.node, home.next || null);
        }
        this._previewHome = null;
        this._editOverlay?.remove();
        this._editOverlay = null;
    }

    _updateToggleText(btn, isTableMode) {
        btn.innerHTML = isTableMode
            ? 'Switch to Text Editor <span class="shortcut-hint">(Ctrl+E)</span>'
            : 'Switch to Table Editor <span class="shortcut-hint">(Ctrl+E)</span>';
    }

    saveBlock(index, newText) {
        if (typeof newText !== 'string') {
            newText = String(newText || '');
        }
        if (State.activeTabIndex < 0) return;
        const file = State.openFiles[State.activeTabIndex];
        
        // Update local blocksData first
        if (index >= this.blocksData.length) {
            if (newText.trim()) this.blocksData.push(newText);
        } else {
            this.blocksData[index] = newText;
            if (!newText.trim()) {
                this.blocksData.splice(index, 1);
            }
        }

        // Use consistent join logic (double newline as per _splitIntoBlocks intent)
        const eol = file.eol || '\n';
        file.content = this.blocksData.join(eol + eol);
        file.isDirty = true;

        if (this.renderTabs) this.renderTabs();
        if (this.renderEditor) this.renderEditor();
        if (this.updateOutline) this.updateOutline();
    }

    selectBlock(index) {
        if (State.activeTabIndex < 0) return;
        // Bounds must come from the ACTUAL blocks. Re-splitting the raw text on
        // blank lines ignores fenced code, so a document with ``` blocks
        // reported more blocks than exist and arrow-navigation ran off the end
        // into an index nothing was rendered for (selection silently vanished).
        // +1 covers the trailing "+ Add Block" phantom.
        const count = (this.blocksData ? this.blocksData.length : 0) + 1;
        if (index < 0) index = 0;
        if (index >= count) index = count - 1;
        State.vimState.selectedIndex = index;

        // If in book mode, determine which page contains this block index and jump to it
        if (State.markdownViewMode === 'book' && this.pages && this.pageFlipInstance) {
            const pageIndex = this.pages.findIndex(page => page.some(b => b.index === index));
            if (pageIndex !== -1) {
                const orientation = this.pageFlipInstance.getOrientation();
                const current = this.pageFlipInstance.getCurrentPageIndex();
                const targetSpreadIndex = orientation === 'landscape' ? pageIndex - (pageIndex % 2) : pageIndex;
                const currentSpreadIndex = orientation === 'landscape' ? current - (current % 2) : current;
                
                if (currentSpreadIndex !== targetSpreadIndex) {
                    this.pageFlipInstance.flip(targetSpreadIndex);
                    this.currentPageIndex = targetSpreadIndex;
                }
            }
        }

        const blocks = this.container.querySelectorAll('.md-block');
        blocks.forEach((b) => {
            const bIdx = parseInt(b.dataset.index);
            if (bIdx === index) {
                b.classList.add('selected');
                if (State.markdownViewMode === 'book') {
                    const pageEl = b.closest('.stf__page');
                    if (pageEl) {
                        const blockTop = b.offsetTop;
                        const blockBottom = blockTop + b.offsetHeight;
                        const pageScroll = pageEl.scrollTop;
                        const pageHeight = pageEl.clientHeight;

                        if (blockTop < pageScroll) {
                            pageEl.scrollTo({ top: Math.max(0, blockTop - 20), behavior: 'smooth' });
                        } else if (blockBottom > pageScroll + pageHeight) {
                            pageEl.scrollTo({ top: blockBottom - pageHeight + 20, behavior: 'smooth' });
                        }
                    }
                } else {
                    b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
                b.focus({ preventScroll: true });
                const range = document.createRange();
                range.selectNodeContents(b);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                sel.collapseToStart();
            } else {
                b.classList.remove('selected');
            }
        });
    }

    activateBlock(index) {
        const blocks = this.container.querySelectorAll('.md-block');
        if (index >= 0 && index < blocks.length) {
            const div = blocks[index];
            if (div.classList.contains('phantom')) {
                div.click();
                return;
            }
            // Prefer the real dblclick handler (set by _renderBlockInternal), but
            // fall back to entering edit mode directly — lazy rendering may not
            // have attached ondblclick yet, so dispatching a dblclick event would
            // silently do nothing (F2 appeared broken on unrendered blocks).
            if (typeof div.ondblclick === 'function' && div.dataset.rendered) {
                const event = new MouseEvent('dblclick', { 'view': window, 'bubbles': true, 'cancelable': true });
                div.dispatchEvent(event);
            } else {
                this.enterEditMode(div, (this.blocksData && this.blocksData[index]) || '', index);
            }
        }
    }

    /**
     * View-level shortcut delegation. App.js's delegateToView() calls this for
     * every non-GLOBAL scoped command when a view is active — MarkdownView has
     * no per-command actions registered for the block scope, so without this
     * F2 (md-block:edit) would silently no-op.
     */
    handleShortcut(cmd, e) {
        if (cmd === 'md-block:edit') {
            if (e && e.preventDefault) e.preventDefault();
            this.editSelectedBlock();
            return true;
        }
        if (cmd === 'md-block:nav') {
            if (e && e.preventDefault) e.preventDefault();
            const dir = (e && e.key === 'ArrowUp') ? -1 : 1;
            this.navigateBlock(dir);
            return true;
        }
        if (cmd === 'md-block:move') {
            if (e && e.preventDefault) e.preventDefault();
            const dir = (e && e.key === 'ArrowUp') ? -1 : 1;
            this.moveBlock(dir);
            return true;
        }
        return false;
    }

    focus() {
        let index = State.vimState.selectedIndex;
        if (index < 0) index = 0;
        this.selectBlock(index);
    }

    toggleBookMode() {
        State.markdownViewMode = State.markdownViewMode === 'book' ? 'scroll' : 'book';
        localStorage.setItem('settings_markdownViewMode', State.markdownViewMode);
        const content = (this.file && this.file.content) || '';
        this.render(content, this.file);
    }

    navigateBlock(direction) {
        let current = State.vimState.selectedIndex;
        if (current === undefined || current === null) current = -1;
        this.selectBlock(current + direction);
    }

    /**
     * Arrow-key block navigation, owned by this view.
     *
     * This used to rely on ShortcutManager resolving the MARKDOWN_BLOCK scope,
     * which only happens when focus lands on a `.md-block` — clicking a table
     * cell, an image, or the gap between blocks left the scope on GLOBAL and the
     * keys silently did nothing (the page just scrolled). Handling it here makes
     * the behaviour independent of where exactly the click landed.
     *
     *   ↑ / ↓          move the selection
     *   Alt+↑ / Alt+↓  move the block itself
     */
    _installBlockNavKeys() {
        if (this._navKeyHandler) {
            window.removeEventListener('keydown', this._navKeyHandler, true);
        }
        this._navKeyHandler = (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            // The explorer owns arrow keys while it has focus: ShortcutManager
            // dispatches explorer:nav → VirtualExplorer.handleKeyDown, which
            // stamps the event. The stamp is REQUIRED — that dispatch
            // synchronously re-renders the virtual list
            // (contentHost.innerHTML=''), detaching the focused row, so the
            // e.target.closest('#explorer') guard below sees null and the old
            // guard silently missed (both the explorer AND this view moved).
            if (e.__explorerKeyDown) return;
            // Only while this view is the visible one.
            if (!this.container || !this.container.isConnected || this.container.offsetParent === null) return;
            // Never steal keys from an editor / input / the block-edit modal.
            if (document.querySelector('#md-block-edit-overlay, #mermaid-helper-overlay, #jh-lightbox')) return;
            const t = e.target;
            // The explorer OWNS the arrow keys: its rows live in #file-list, a
            // descendant of #explorer. Judge by the EVENT TARGET, not by
            // document.activeElement: virtual scrolling destroys the focused row
            // on every keypress (contentHost.innerHTML=''), which drops
            // activeElement to <body> and made the activeElement-based guard
            // miss — both the explorer AND the markdown view moved. The target
            // of a keydown that started inside the explorer stays inside it.
            if (t && typeof t.closest === 'function' && t.closest('#explorer')) return;
            // Same check for the case where focus rests on the explorer's
            // container but the event bubbled from elsewhere.
            if (document.activeElement && typeof document.activeElement.closest === 'function' &&
                document.activeElement.closest('#explorer')) return;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (t && typeof t.closest === 'function' && t.closest('.cm-editor, .editing, #search-panel')) return;
            // Focus inside a .md-block: ShortcutManager (MARKDOWN_BLOCK scope)
            // already resolves ↑/↓ to md-block:nav / md-block:move. Handling
            // them here as well made each keypress advance TWO blocks (double
            // navigateBlock), so defer to ShortcutManager in that case.
            if (t && typeof t.closest === 'function' && t.closest('.md-block')) return;

            // Engage only once the user is actually working with blocks: a block
            // is selected, or the key came from inside the markdown area.
            // Otherwise leave the arrows alone so the page scrolls as usual.
            const inside = t && typeof t.closest === 'function' && this.container.contains(t);
            if (State.vimState.selectedIndex < 0 && !inside) return;

            const dir = e.key === 'ArrowUp' ? -1 : 1;
            e.preventDefault();
            e.stopPropagation();
            if (e.altKey) {
                this.moveBlock(dir);
            } else {
                this.navigateBlock(dir);
            }
        };
        window.addEventListener('keydown', this._navKeyHandler, true);
    }

    /**
     * Reorder: swap the selected block with its neighbour (Alt+Up / Alt+Down).
     * The selection follows the block so repeated presses keep moving the same
     * content, and the file is rewritten through the normal save path.
     */
    moveBlock(direction) {
        const blocks = this.blocksData;
        if (!Array.isArray(blocks) || blocks.length < 2) return;

        const from = State.vimState.selectedIndex;
        const to = from + direction;
        if (from < 0 || from >= blocks.length || to < 0 || to >= blocks.length) return;

        [blocks[from], blocks[to]] = [blocks[to], blocks[from]];
        State.vimState.selectedIndex = to;

        // Persist via the same join logic used by saveBlock, then re-render.
        if (State.activeTabIndex < 0) return;
        const file = State.openFiles[State.activeTabIndex];
        const eol = file.eol || '\n';
        file.content = blocks.join(`${eol}${eol}`);
        file.isDirty = true;

        if (this.renderEditor) this.renderEditor();
        setTimeout(() => this.selectBlock(to), 50);
    }

    editSelectedBlock() {
        // F2 with nothing selected (e.g. focus landed on the pane but no block
        // was clicked) used to no-op because selectedIndex was -1. Fall back to
        // the first block so F2 always opens the edit modal.
        let index = State.vimState.selectedIndex;
        if (index < 0) index = 0;
        this.activateBlock(index);
    }

    getSelectedText() {
        // 1. If inside an active editing block (CodeMirror)
        const cm = this._blockCM;
        if (cm && cm.dom.offsetParent !== null) { // visible
            const sel = cm.state.selection.main;
            return cm.state.sliceDoc(sel.from, sel.to);
        }

        // 2. If a block is selected but not editing -> Return whole block text
        const index = State.vimState.selectedIndex;
        if (index >= 0 && index < this.blocksData.length) {
            return this.blocksData[index];
        }
        return '';
    }

    replaceSelectedText(text) {
        // 1. If inside an active editing block (CodeMirror)
        const cm = this._blockCM;
        if (cm && cm.dom.offsetParent !== null) {
            const sel = cm.state.selection.main;
            cm.dispatch({
                changes: { from: sel.from, to: sel.to, insert: text },
                selection: { anchor: sel.from + text.length },
            });
            cm.focus();
            return;
        }

        // 2. If block selected but not editing -> Replace whole block
        const index = State.vimState.selectedIndex;
        if (index >= 0 && index < this.blocksData.length) {
            this.saveBlock(index, text);
        }
    }

    _splitIntoPages(blocks, pageHeight = 600) {
        const blocksWithIndex = blocks.map((text, idx) => ({ text, index: idx }));
        
        const pages = [];
        let currentPage = [];
        
        const lh = this._measureLineHeight();
        // Count-based packing (the original behaviour). Pages are dense and a
        // page that overflows simply scrolls (.stf__page has overflow-y:auto) —
        // this avoids the near-blank pages that height-estimate pagination
        // produced when it broke early before tall blocks/headings.
        const blocksPerPage = Math.max(5, Math.floor((pageHeight - 80) / (lh * 2.2))) || 8;
        const halfPageLimit = Math.floor(blocksPerPage / 2);

        for (let i = 0; i < blocksWithIndex.length; i++) {
            const item = blocksWithIndex[i];
            const trimmed = item.text.trim();
            const isHeadingOrHR = trimmed.startsWith('#') || trimmed === '---' || trimmed.startsWith('---');

            // If it's a heading/HR and the page is already more than half full,
            // break so the heading starts at the top of the next page.
            if (isHeadingOrHR && currentPage.length >= halfPageLimit) {
                pages.push(currentPage);
                currentPage = [];
            }

            currentPage.push(item);

            if (currentPage.length >= blocksPerPage) {
                pages.push(currentPage);
                currentPage = [];
            }
        }
        
        if (currentPage.length > 0) {
            pages.push(currentPage);
        }
        
        if (pages.length === 0) {
            pages.push([]);
        }
        return pages;
    }

    _renderBookMode(blocks) {
        // Ensure path and page index are updated BEFORE early returns or ResizeObserver
        if (this.currentPageIndex === undefined || this.currentPageIndex === null || this._lastFilePath !== this.file?.path) {
            // Restore the page the user was on before switching tabs (saved in
            // destroy() as _mdBookPage); default to the first page.
            this.currentPageIndex = (this.file && this.file._mdBookPage) || 0;
            if (this.file) {
                this._lastFilePath = this.file.path;
            }
        }

        // Resize observer to scale book to full container width/height on resize
        // Must be attached BEFORE any early returns
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
        }
        let debounceTimer;
        this._resizeObserver = new ResizeObserver((entries) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (State.markdownViewMode === 'book' && this.file && this.file.path === this._lastFilePath) {
                    const rect = this.container.getBoundingClientRect();
                    const lw = this._lastWidth || 0;
                    const lh = this._lastHeight || 0;
                    if (Math.abs(rect.width - lw) > 5 || Math.abs(rect.height - lh) > 5) {
                        this._renderBookMode(blocks);
                        // Re-rendering rebuilds .md-block elements from source,
                        // dropping any injected search <mark> tags. Restore the
                        // active search highlights so they don't vanish.
                        if (typeof window.reapplyActiveSearch === 'function') {
                            window.reapplyActiveSearch();
                        }
                    }
                }
            }, 150);
        });
        this._resizeObserver.observe(this.container);

        // Calculate dynamic single page size based on container width/height
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;
        
        if (containerWidth === 0 || containerHeight === 0) {
            if (this.container.innerHTML === '') {
                this.container.innerHTML = '<div style="width:100%; height:100%; min-height:10px;"></div>';
            }
            // Fallback: Retry rendering after a short delay in case ResizeObserver misses it
            if (this._retryTimeout) clearTimeout(this._retryTimeout);
            this._retryTimeout = setTimeout(() => {
                if (this.container.clientWidth > 0 && this.container.clientHeight > 0) {
                    this._renderBookMode(blocks);
                }
            }, 200);
            return;
        }

        const bookWidth = containerWidth;
        // The footer (page number + hint) is an absolute overlay pinned to the
        // bottom. Reserve its height so the last lines of a page aren't hidden
        // behind it / clipped off the bottom.
        const FOOTER_RESERVE = 46;
        const bookHeight = Math.max(200, containerHeight - FOOTER_RESERVE);

        const singlePageWidth = Math.round(bookWidth / 2);
        const singlePageHeight = Math.round(bookHeight);

        this.pages = this._splitIntoPages(blocks, bookHeight);
        
        if (this.currentPageIndex >= this.pages.length) {
            this.currentPageIndex = Math.max(0, this.pages.length - 1);
        }
        
        this._lastWidth = containerWidth;
        this._lastHeight = containerHeight;


        // Destroy previous StPageFlip instance if exists
        if (this.pageFlipInstance) {
            try { this.pageFlipInstance.destroy(); } catch (e) { /* ignore */ }
            this.pageFlipInstance = null;
        }

        const oldLayout = this.container.querySelector('.md-book-layout');
        if (oldLayout) oldLayout.remove();

        const layoutDiv = document.createElement('div');
        layoutDiv.className = 'md-book-layout';
        layoutDiv.tabIndex = 0;
        layoutDiv.style.outline = 'none';

        const pageContainer = document.createElement('div');
        pageContainer.className = 'md-book-page-container';
        // Pin the flip area to the reserved book height and top-align it, so the
        // leftover space at the bottom belongs to the overlay footer (content no
        // longer runs underneath it).
        pageContainer.style.flex = '0 0 auto';
        pageContainer.style.height = bookHeight + 'px';

        // StPageFlip book element
        const bookDiv = document.createElement('div');
        bookDiv.className = 'md-book-flipbook';

        // Create page elements for StPageFlip
        this.pages.forEach((pageBlocks, idx) => {
            const pageEl = document.createElement('div');
            pageEl.className = 'stf__page md-body';
            pageEl.dataset.pageIndex = idx;
            this._renderPageBlocks(pageEl, idx, true);
            bookDiv.appendChild(pageEl);
        });

        // Add blank page if odd count — ensures last page flips naturally in 2-page spread
        if (this.pages.length % 2 !== 0) {
            const blankPage = document.createElement('div');
            blankPage.className = 'stf__page stf__page--blank';
            bookDiv.appendChild(blankPage);
        }

        pageContainer.appendChild(bookDiv);

        // Footer with progress bar and page info
        const footer = document.createElement('div');
        footer.className = 'md-book-footer';

        const progressContainer = document.createElement('div');
        progressContainer.className = 'md-book-progress-container';

        const progressThumb = document.createElement('div');
        progressThumb.className = 'md-book-progress-thumb';
        
        const progressBar = document.createElement('div');
        progressBar.className = 'md-book-progress-bar';
        const progressPercent = this.pages.length > 1
            ? (this.currentPageIndex / (this.pages.length - 1)) * 100
            : 100;
        progressBar.style.width = `${progressPercent}%`;
        progressContainer.appendChild(progressBar);
        progressContainer.appendChild(progressThumb);
        progressThumb.style.left = `${progressPercent}%`;

        const pageInfo = document.createElement('span');
        pageInfo.className = 'md-book-page-info';
        pageInfo.textContent = `Page ${this.currentPageIndex + 1} of ${this.pages.length}`;

        const hint = document.createElement('span');
        hint.className = 'pt-book-hint';
        hint.textContent = '← / → : move to left/right page · Alt+←/→ : turn page';

        footer.appendChild(progressContainer);
        footer.appendChild(pageInfo);
        footer.appendChild(hint);

        layoutDiv.appendChild(pageContainer);
        layoutDiv.appendChild(footer);

        this.container.appendChild(layoutDiv);

        // Initialize StPageFlip
        try {
            this.pageFlipInstance = new PageFlip(bookDiv, {
                width: singlePageWidth,
                height: singlePageHeight,
                size: 'fixed',
                maxWidth: 3000,
                minHeight: 100,
                maxHeight: 3000,
                drawShadow: true,
                flippingTime: 800,
                usePortrait: false,
                showCover: false,
                autoSize: true,
                maxShadowOpacity: 0.6,
                mobileScrollSupport: false,
                disableFlipByClick: true,
                useMouseEvents: false
            });

            // Handle right-click on book to turn pages
            bookDiv.addEventListener('contextmenu', (e) => {
                if (e.target.closest('.editor-block-container') || e.target.closest('.edit-actions')) {
                    return;
                }
                e.preventDefault();
                if (!this.pageFlipInstance) return;
                const rect = bookDiv.getBoundingClientRect();
                const x = e.clientX - rect.left;
                if (x < rect.width / 2) {
                    this.navigatePage(-1);
                } else {
                    this.navigatePage(1);
                }
            });

            const pageElements = bookDiv.querySelectorAll('.stf__page');
            if (pageElements.length > 0) {
                this.pageFlipInstance.loadFromHTML(pageElements);
            }

            // Fix text selection and arrow key focus
            bookDiv.addEventListener('mousedown', (e) => {
                layoutDiv.focus();
            }, true);

            // Jump to saved page
            if (this.currentPageIndex > 0 && this.currentPageIndex < this.pages.length) {
                setTimeout(() => {
                    try { this.pageFlipInstance.flip(this.currentPageIndex); } catch (e) { /* ignore */ }
                }, 100);
            }

            // Sync page index on flip event
            this.pageFlipInstance.on('flip', (e) => {
                this.currentPageIndex = e.data;
                this._updateBookFooter(progressBar, pageInfo);
                // Move the selection onto the page that is now showing, so
                // Alt+←/→ then ↑/↓ continues from here instead of from wherever
                // the cursor was left behind. Handled on the event (not in
                // navigatePage) so page clicks and the progress bar behave the
                // same way.
                //
                // When the flip was triggered by selectBlock() (arrow-key
                // navigation jumping to a block on another spread), the
                // selection already sits on a page of the newly shown spread —
                // don't override it with the spread's left page.
                const sel = State.vimState.selectedIndex;
                let selOnSpread = false;
                if (sel >= 0 && Array.isArray(this.pages)) {
                    const selPage = this.pages.findIndex((p) => p.some((b) => b && b.index === sel));
                    const left = e.data;
                    selOnSpread = selPage === left || (this.pageFlipInstance.getOrientation() === 'landscape' && selPage === left + 1);
                }
                if (!selOnSpread) this._selectFirstBlockOfPage(e.data);
            });

        } catch (e) {
            console.error('StPageFlip initialization failed:', e);
        }

        // Draggable progress bar
        const jumpToPosition = (clientX) => {
            if (!this.pageFlipInstance) return;
            const rect = progressContainer.getBoundingClientRect();
            const clickX = Math.max(0, Math.min(clientX - rect.left, rect.width));
            const percentage = clickX / rect.width;
            const targetPage = Math.round(percentage * (this.pages.length - 1));
            this.pageFlipInstance.flip(targetPage);
            // Immediately update visuals
            progressBar.style.width = `${percentage * 100}%`;
            progressThumb.style.left = `${percentage * 100}%`;
        };

        let isDragging = false;

        progressContainer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isDragging = true;
            progressContainer.classList.add('dragging');
            jumpToPosition(e.clientX);
        });

        const onMouseMove = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            jumpToPosition(e.clientX);
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            progressContainer.classList.remove('dragging');
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // Store refs for cleanup
        this._progressDragCleanup = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        // Keyboard navigation
        if (this._keydownHandler) {
            window.removeEventListener('keydown', this._keydownHandler, true);
        }
        this._keydownHandler = (e) => {
            if (State.markdownViewMode !== 'book') return;
            if (!this.pageFlipInstance) return;
            // The explorer owns arrow keys while it has focus (stamped by
            // VirtualExplorer.handleKeyDown — see _installBlockNavKeys). Its
            // virtual-scroll re-render detaches the focused row, so the
            // target/activeElement guards below can't see it; the stamp can.
            if (e.__explorerKeyDown) return;
            
            // Only handle if this view is visible
            if (!this.container || this.container.offsetParent === null) {
                return;
            }

            // Skip if focus is in input/textarea or explorer/modal/search panel
            if (document.activeElement && (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT')) {
                return;
            }
            // The explorer owns the arrow keys while it has focus: its rows
            // live in #file-list, a descendant of #explorer. Judge by the EVENT
            // TARGET first (virtual scrolling destroys the focused row on every
            // keypress, dropping activeElement to <body> and making the
            // activeElement check below miss); the target of a keydown that
            // started inside the explorer stays inside it.
            if (e.target && typeof e.target.closest === 'function' && e.target.closest('#explorer')) {
                return;
            }
            if (document.activeElement && typeof document.activeElement.closest === 'function' &&
                document.activeElement.closest('#explorer')) {
                return;
            }
            if (e.target && e.target.closest) {
                if (e.target.closest('#explorer-list-container') || e.target.closest('#explorer-search') || 
                    e.target.closest('.tab-search-overlay') || e.target.closest('#search-panel') || 
                    e.target.closest('.ai-review-overlay') || e.target.closest('.settings-modal') ||
                    e.target.closest('#md-block-edit-overlay') || e.target.closest('#mermaid-helper-overlay') ||
                    e.target.closest('#jh-lightbox') || e.target.closest('.cm-editor') || e.target.closest('.editing')) {
                    return;
                }
            }

            // ← / → move the selection to the top block of the page to the
            // left / right (inside the current spread when possible; selectBlock
            // flips to a neighbouring spread once the edge is reached). Page
            // flipping itself stays on Alt+← / Alt+→.
            if (e.altKey) {
                if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.navigatePage(-1);
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.navigatePage(1);
                }
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                e.stopPropagation();
                this._selectAdjacentPageTop(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                this._selectAdjacentPageTop(1);
            }
        };
        window.addEventListener('keydown', this._keydownHandler, true);
        this._keydownBound = true;
        // Arrow-key block navigation works in book mode too (selectBlock flips
        // to the page holding the target block).
        this._installBlockNavKeys();

        // Focus the current page/block on render
        setTimeout(() => {
            this.focus();
        }, 150);
    }

    _updateBookFooter(progressBar, pageInfo) {
        if (!progressBar || !pageInfo) return;
        const progressPercent = this.pages.length > 1
            ? (this.currentPageIndex / (this.pages.length - 1)) * 100
            : 100;
        progressBar.style.width = `${progressPercent}%`;
        const thumb = progressBar.parentElement?.querySelector('.md-book-progress-thumb');
        if (thumb) thumb.style.left = `${progressPercent}%`;
        pageInfo.textContent = `Page ${this.currentPageIndex + 1} of ${this.pages.length}`;
    }

    _renderPageBlocks(pageDiv, pageIdx, isInteractive = true) {
        const pageBlocks = this.pages[pageIdx] || [];
        pageBlocks.forEach((item) => {
            const div = document.createElement('div');
            div.className = 'md-block md-body';
            div.dataset.index = item.index;
            div.tabIndex = -1;
            div.style.minHeight = '1.5em';
            
            pageDiv.appendChild(div);
            this._renderBlockInternal(div);
            
            if (isInteractive) {
                const stopEvent = (e) => e.stopPropagation();
                div.addEventListener('pointerdown', stopEvent);
                div.addEventListener('pointerup', stopEvent);
                div.addEventListener('mousedown', stopEvent);
                div.addEventListener('mouseup', stopEvent);
                div.addEventListener('click', stopEvent);
                
                div.onclick = (e) => {
                    e.stopPropagation();
                    if (div.classList.contains('editing')) return;
                    State.vimState.selectedIndex = item.index;
                    const blocks = this.container.querySelectorAll('.md-block');
                    blocks.forEach((b) => {
                        if (b === div) {
                            b.classList.add('selected');
                            b.focus({ preventScroll: true });
                        }
                        else b.classList.remove('selected');
                    });
                };
            }
        });
    }

    navigatePage(direction) {
        if (!this.pageFlipInstance) return;
        if (direction > 0) {
            this.pageFlipInstance.flipNext();
        } else {
            this.pageFlipInstance.flipPrev();
        }
    }

    /**
     * Put the block cursor on the first block of `pageIndex`.
     * In a two-page spread the left page is the start of the spread, so its
     * first block is the natural landing spot. Safe against re-entrancy:
     * selectBlock only flips when the target sits on a *different* spread.
     */
    _selectFirstBlockOfPage(pageIndex) {
        if (!Array.isArray(this.pages)) return;
        const page = this.pages[pageIndex];
        const first = Array.isArray(page) ? page.find(b => b && Number.isInteger(b.index)) : null;
        if (!first) return;
        // Already on this page → nothing to do (avoids fighting a manual pick).
        if (State.vimState.selectedIndex >= 0 && page.some(b => b.index === State.vimState.selectedIndex)) return;
        this.selectBlock(first.index);
    }

    /**
     * Move the selection to the top block of the page lying to the left
     * (direction -1) or right (direction +1) of the current position.
     *
     * In a two-page spread this stays inside the spread when possible: → jumps
     * from the left page to the right page, ← jumps back. Pressing again at the
     * edge moves on to the neighbouring spread (selectBlock flips to it), so
     * repeated presses walk the book page by page without turning a page just
     * to look at the adjacent one.
     */
    _selectAdjacentPageTop(direction) {
        if (!Array.isArray(this.pages) || !this.pageFlipInstance) return;
        if (this.pages.length <= 1) return;
        const orientation = this.pageFlipInstance.getOrientation();
        const sel = State.vimState.selectedIndex;
        let curPage = -1;
        if (sel >= 0) {
            curPage = this.pages.findIndex((p) => p.some((b) => b && b.index === sel));
        }
        const left = (typeof this.currentPageIndex === 'number' && this.currentPageIndex >= 0)
            ? this.currentPageIndex
            : 0;
        let targetPage;
        if (orientation === 'portrait') {
            // One page per spread: left/right = previous/next page.
            targetPage = (curPage >= 0 ? curPage : left) + direction;
        } else if (direction > 0) {
            const right = left + 1;
            targetPage = curPage === right ? left + 2 : right;
        } else {
            targetPage = curPage === left ? left - 1 : left;
        }
        if (targetPage < 0 || targetPage >= this.pages.length) return;
        if (targetPage === curPage) return;
        this._selectFirstBlockOfPage(targetPage);
    }

    destroy() {
        // Remember the reading position so switching tabs and coming back keeps
        // the same viewport (scroll mode) / page (book mode).
        if (this.file) {
            try {
                if (State.markdownViewMode === 'book') {
                    this.file._mdBookPage = this.currentPageIndex || 0;
                } else if (this.container) {
                    this.file._mdScrollTop = this.container.scrollTop;
                }
            } catch (e) { /* ignore */ }
        }
        if (this._onFontChange) {
            window.removeEventListener('fontSettingsChanged', this._onFontChange);
        }
        if (this._progressDragCleanup) {
            this._progressDragCleanup();
            this._progressDragCleanup = null;
        }
        if (this.pageFlipInstance) {
            try { this.pageFlipInstance.destroy(); } catch (e) { /* ignore */ }
            this.pageFlipInstance = null;
        }
        if (this._keydownHandler) {
            window.removeEventListener('keydown', this._keydownHandler, true);
            this._keydownHandler = null;
            this._keydownBound = false;
        }
        if (this._navKeyHandler) {
            window.removeEventListener('keydown', this._navKeyHandler, true);
            this._navKeyHandler = null;
        }
        if (this.observer) {
            this.observer.disconnect();
        }
        // The book-mode resize observer is stored as _resizeObserver (not
        // `observer`). If it is left connected after the tab closes, it keeps
        // watching the reused editor container and, on any later reflow, fires
        // its callback — re-rendering THIS (now-dead) file's Markdown into
        // whatever file is currently displayed. That caused another file's
        // README/Markdown to suddenly overwrite the visible editor.
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        super.destroy();
    }

    _createMarkedRenderer() {
        const renderer = new marked.Renderer();

        renderer.code = (codeOrObj, infostring, escaped) => {
            let code = codeOrObj;
            let lang = infostring;
            if (typeof codeOrObj === 'object' && codeOrObj !== null) {
                code = codeOrObj.text !== undefined ? codeOrObj.text : codeOrObj.code;
                lang = codeOrObj.lang;
            }

            lang = (lang || '').match(/\S*/)[0];
            if (lang === 'mermaid' || /^\s*(graph|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|erDiagram|flowchart)\s/.test(code)) {
                return `<div class="mermaid">${code}</div>`;
            }

            const highlighted = (typeof SyntaxHighlighter !== 'undefined')
                ? SyntaxHighlighter.highlight(code, lang)
                : code;

            return `<pre><code class="language-${lang} hljs">${highlighted}</code></pre>`;
        };

        // Images: a relative src (assets/foo.png) can't be loaded by the webview
        // as-is — Tauri blocks file://. Map it through the asset protocol,
        // resolved against the document's own folder.
        renderer.image = (href, title, text) => {
            if (typeof href === 'object' && href !== null) {
                const obj = href;
                href = obj.href;
                title = obj.title;
                text = obj.text;
            }
            const docPath = this.file ? this.file.path : null;
            const src = MdAssets.resolveImageSrc(href, docPath);
            const titleAttr = title ? ` title="${this._escapeAttr(title)}"` : '';
            return `<img src="${this._escapeAttr(src)}" alt="${this._escapeAttr(text || '')}"${titleAttr} loading="lazy">`;
        };

        // Custom link renderer: file references get data-file-link,
        // external URLs get data-url-link for click handling
        renderer.link = (href, title, text) => {
            if (typeof href === 'object' && href !== null) {
                const obj = href;
                href = obj.href;
                title = obj.title;
                text = obj.text;
            }
            const titleAttr = title ? ` title="${title}"` : '';
            const isExternalUrl = /^https?:\/\//.test(href || '');
            if (isExternalUrl) {
                return `<a href="#" data-url-link="${href}"${titleAttr}>${text}</a>`;
            }
            return `<a href="#" data-file-link="${href || ''}"${titleAttr}>${text}</a>`;
        };

        return renderer;
    }

    _parseMarkdown(text) {
        if (typeof marked === 'undefined') return text;
        const renderer = this._createMarkedRenderer();
        // [[wiki links]] are expanded to ordinary Markdown links first, so the
        // link renderer above (and its file-open click handling) applies to them.
        const src = MdAssets.expandWikiLinks(text);
        return marked.parse(src, { renderer });
    }

    /**
     * Backlinks: every document in the workspace that wiki-links to this one.
     *
     * Implemented on top of the existing workspace grep (Rust, streaming) rather
     * than a separate index: for a personal note tree it is fast enough, and it
     * can never go stale. The results land in the normal search-results tab.
     */
    showBacklinks() {
        const path = this.file && this.file.path;
        if (!path) {
            if (window.showToast) window.showToast('Only available for saved files');
            return;
        }
        if (!State.currentDir || !/^([a-zA-Z]:[\\/]|\/)/.test(String(State.currentDir))) {
            if (window.showToast) window.showToast('Open a workspace first');
            return;
        }
        const base = String(path).split(/[\\/]/).pop().replace(/\.md$/i, '');
        // Matches [[Name]] and [[Name|label]] — the target sits right after `[[`.
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = `\\[\\[${escaped}(\\.md)?(\\||\\])`;

        const searchId = Date.now() + Math.random();
        window.app.openSearchResults({
            query: `[[${base}]]`,
            matches: [],
            options: { regex: true, caseSensitive: false, wholeWord: false },
            searchId,
            streaming: true,
        });
        invoke('start_grep', {
            dir: State.currentDir,
            term: pattern,
            regex: true,
            caseSensitive: false,
            wholeWord: false,
            includeSubdirs: true,
            globs: '*.md',
            searchId,
        }).catch((e) => {
            console.error('backlink search failed', e);
            if (window.showToast) window.showToast('Backlink search failed');
        });
    }

    /**
     * Export the whole document as PDF.
     *
     * Renders the Markdown into an offscreen iframe and prints it: the webview's
     * print pipeline already lays out the real fonts, images (asset:// URLs are
     * inherited) and KaTeX output, so the PDF matches what is on screen without
     * pulling in a PDF library. The user picks "Save as PDF" in the dialog.
     */
    async exportToPdf() {
        try {
            const source = (this.blocksData || []).join('\n\n');
            const html = this._parseMarkdown(source);
            const title = (this.file && (this.file.name || this.file.path))
                ? String(this.file.name || this.file.path).split(/[\\/]/).pop().replace(/\.\w+$/, '')
                : 'document';

            // Reuse the app's own stylesheets so the export matches the preview.
            const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
                .map(el => el.outerHTML).join('\n');

            const frame = document.createElement('iframe');
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = 'position:fixed; right:0; bottom:0; width:0; height:0; border:0; opacity:0;';
            document.body.appendChild(frame);

            const doc = frame.contentDocument;
            doc.open();
            doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${this._escapeAttr(title)}</title>${styles}
                <style>
                  @page { margin: 16mm; }
                  body { background:#fff; color:#111; margin:0; padding:0; }
                  .md-body { max-width:none; padding:0; }
                  .md-body img { max-width:100%; }
                  pre, blockquote, table, img, .katex-display { break-inside: avoid; }
                  h1,h2,h3 { break-after: avoid; }
                </style>
                </head><body><div class="md-body">${html}</div></body></html>`);
            doc.close();

            // Math/diagrams need to be materialised before printing.
            if (MdAssets.hasMath(source)) {
                await MdAssets.renderMath(doc.body);
            }
            try { await Markdown.renderMermaid(doc.body); } catch (_) { /* optional */ }

            // Give images a moment to decode, otherwise they print blank.
            await new Promise((resolve) => {
                const imgs = Array.from(doc.images || []);
                if (imgs.length === 0) return resolve();
                let left = imgs.length;
                const done = () => { if (--left <= 0) resolve(); };
                imgs.forEach(img => {
                    if (img.complete) return done();
                    img.addEventListener('load', done, { once: true });
                    img.addEventListener('error', done, { once: true });
                });
                setTimeout(resolve, 3000); // don't hang on a broken asset
            });

            frame.contentWindow.focus();
            frame.contentWindow.print();
            // Leave the frame alive briefly — removing it during the modal print
            // dialog cancels the job in some webviews.
            setTimeout(() => { try { frame.remove(); } catch (_) {} }, 60000);
        } catch (e) {
            console.error('PDF export failed', e);
            if (window.showToast) window.showToast('PDF export failed');
        }
    }

    /**
     * Paste/drop of an image inside the block editor: write the bytes beside the
     * document and insert `![name](assets/name.png)` at the caret.
     * Returns true when handled, so CM skips its own default paste.
     */
    _handleImageDrop(event, view) {
        const blob = MdAssets.extractImageBlob(event);
        if (!blob) return false;
        event.preventDefault();

        const docPath = this.file ? this.file.path : null;
        MdAssets.saveImageForDocument(blob, docPath)
            .then((snippet) => {
                if (!view || !snippet) return;
                const sel = view.state.selection.main;
                view.dispatch({
                    changes: { from: sel.from, to: sel.to, insert: snippet },
                    selection: { anchor: sel.from + snippet.length },
                });
                view.focus();
            })
            .catch((err) => {
                console.error('image paste failed', err);
                if (window.showToast) window.showToast('Failed to save the image');
            });
        return true;
    }

    /**
     * The ```mermaid fenced block containing `pos`, if any — so the helper can
     * reopen an existing diagram instead of appending a second one.
     * @returns {{from:number,to:number,code:string}|null}
     */
    _mermaidBlockAt(text, pos) {
        const re = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            const from = m.index;
            const to = from + m[0].length;
            if (pos >= from && pos <= to) return { from, to, code: m[1].replace(/\s+$/, '') };
        }
        return null;
    }

    _escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    _openUrlInBrowser(url) {
        open(url).catch(err => {
            console.warn('Failed to open URL in browser:', err);
            // Fallback: try window.open for non-Tauri environments
            try { window.open(url, '_blank'); } catch (e) { /* ignore */ }
        });
    }

    _openFileFromLink(href) {
        // Skip anchors, mailto, and other special schemes
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) {
            return;
        }

        // Strip URL fragment if present (e.g. file.md#section)
        const hashIdx = href.indexOf('#');
        const filePath = hashIdx > 0 ? href.substring(0, hashIdx) : href;
        const anchor = hashIdx > 0 ? href.substring(hashIdx + 1) : null;

        // Resolve relative paths against the current file's directory
        let resolvedPath = this._resolveFilePath(filePath);

        if (window.app && typeof window.app.openFile === 'function') {
            window.app.openFile(resolvedPath).then(() => {
                // After opening, jump to anchor if present
                if (anchor) {
                    setTimeout(() => {
                        const currentView = window.app.getCurrentView && window.app.getCurrentView();
                        if (currentView && typeof currentView.jumpToLine === 'function') {
                            currentView.jumpToLine(0, anchor);
                        }
                    }, 200);
                }
            }).catch(() => {
                // File not found — silently ignore (per Editor.js pattern)
            });
        }
    }

    /**
     * Relative-link preview: hovering a `data-file-link` shows the linked file's
     * contents (or an image) in a small floating popup, resolved against the
     * current document's folder — the same resolution `_openFileFromLink` uses.
     * Returns a cleanup function that removes the popup and its listeners.
     */
    _installLinkPreview(el, href) {
        if (!el || !href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:') || /^https?:/i.test(href)) {
            return null;
        }
        let popup = null;
        let timer = null;
        const close = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (popup) { popup.remove(); popup = null; }
        };
        const cleanup = () => {
            close();
            el.removeEventListener('mouseleave', close);
            el.removeEventListener('click', cleanup);
        };
        const isImage = /.(png|jpe?g|gif|svg|webp|bmp)$/i.test(href.split(/[?#]/)[0]);
        el.addEventListener('mouseenter', () => {
            if (popup || timer) return;
            const resolved = this._resolveFilePath(href.split('#')[0]);
            if (!resolved) return;
            timer = setTimeout(async () => {
                timer = null;
                try {
                    popup = document.createElement('div');
                    popup.className = 'md-link-preview-popup';
                    const head = document.createElement('div');
                    head.className = 'md-link-preview-head';
                    head.textContent = resolved.split(/[\\/]/).pop() + (isImage ? '  (click to open)' : '');
                    const body = document.createElement('div');
                    body.className = 'md-link-preview-body';
                    if (isImage) {
                        const img = document.createElement('img');
                        img.src = MdAssets.resolveImageSrc(resolved, resolved);
                        img.alt = '';
                        body.appendChild(img);
                    } else {
                        const { content } = await invoke('read_file_auto_detect', { path: resolved });
                        if (!content) return;
                        body.textContent = String(content).slice(0, 2000);
                    }
                    popup.append(head, body);
                    document.body.appendChild(popup);
                    const rect = el.getBoundingClientRect();
                    popup.style.position = 'fixed';
                    popup.style.left = Math.min(rect.left, Math.max(8, window.innerWidth - popup.offsetWidth - 12)) + 'px';
                    popup.style.top = (rect.bottom + 6) + 'px';
                    popup.style.maxHeight = Math.max(120, window.innerHeight - rect.bottom - 24) + 'px';
                } catch (_) { /* file missing / unreadable — no preview */ }
            }, 350);
        });
        el.addEventListener('mouseleave', close);
        el.addEventListener('click', cleanup);
        return cleanup;
    }

    _resolveFilePath(href) {
        // Already absolute (drive letter or root-relative)
        if (/^[a-zA-Z]:[\\/]/.test(href) || href.startsWith('/')) {
            return href.replace(/\\/g, '/');
        }

        // Current file's directory
        const currentPath = this.file && this.file.path ? this.file.path.replace(/\\/g, '/') : '';
        const dirIdx = currentPath.lastIndexOf('/');
        const dir = dirIdx >= 0 ? currentPath.substring(0, dirIdx) : (State.currentDir || '.');

        // Resolve relative path (handle ../ and ./)
        const baseParts = dir.split('/').filter(Boolean);
        const relParts = href.split('/').filter(Boolean);

        const parts = [...baseParts];
        for (const part of relParts) {
            if (part === '..') {
                parts.pop();
            } else if (part !== '.') {
                parts.push(part);
            }
        }

        return parts.join('/');
    }

    _measureLineHeight() {
        const rootStyle = getComputedStyle(document.documentElement);
        const lhProp = rootStyle.getPropertyValue('--editor-line-height-px').trim();
        if (lhProp) {
            const val = parseFloat(lhProp);
            if (!isNaN(val)) return Math.round(val);
        }
        return 22;
    }

    jumpToLine(lineIndex, textMatch = null) {
        if (!this.blocksData) return;
        
        let targetBlockIdx = -1;
        if (textMatch) {
            targetBlockIdx = this.blocksData.findIndex(blk => blk.includes(textMatch));
        }
        
        if (targetBlockIdx === -1) {
            let currentLine = 0;
            for (let i = 0; i < this.blocksData.length; i++) {
                const blockLines = this.blocksData[i].split('\n').length;
                if (lineIndex >= currentLine && lineIndex < currentLine + blockLines) {
                    targetBlockIdx = i;
                    break;
                }
                currentLine += blockLines + 1;
            }
        }
        
        if (targetBlockIdx >= 0) {
            if (State.markdownViewMode === 'book') {
                this.selectBlock(targetBlockIdx);
            } else {
                const blockEl = this.container.querySelector(`.md-block[data-index="${targetBlockIdx}"]`);
                if (blockEl) {
                    blockEl.scrollIntoView({ block: 'center' });
                    blockEl.focus({ preventScroll: true });
                }
            }
        }
    }
}
