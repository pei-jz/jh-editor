import { BaseView } from './BaseView.js';
import { EL } from '../core/Constants.js';
import { StructureEditor } from '../editors/StructureEditor.js';
import { invoke } from '@tauri-apps/api/core';
import { parseAsync } from '../utils/AsyncParser.js';
import { JsonParser } from '../utils/JsonParser.js';
import { XmlParser } from '../utils/XmlParser.js';
import { HtmlParser } from '../utils/HtmlParser.js';
import { isJspContent, extractJsp, restoreJspInTree } from '../utils/JspSupport.js';
import { CodeMirrorView } from './CodeMirrorView.js';
import { InlineAI } from '../ui/InlineAI.js';
import { SyntaxHighlighter } from '../utils/SyntaxHighlighter.js';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { Navigation } from '../utils/Navigation.js';

const debounce = (func, wait) => {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
};

export class StructureView extends BaseView {
    constructor(container, options = {}) {
        super(container);
        this.onRenderTabs = options.renderTabs;
        this.currentSelectedNode = null;
        this.editor = null;
        this.parser = null;
        this.inlineAI = new InlineAI(this);

        this.boundShortcutHandler = this.handleShortcut.bind(this);
        // window.removeEventListener('shortcutTriggered', ...) handled in destroy if needed, 
        // but App.js calls view.handleShortcut directly now.

        this._onFontChange = () => {
            if (this.sourceTextarea) {
                // If the source pane has manual scroll sync, 
                // we might need to trigger it, but purely CSS size changes
                // usually don't break the scroll position logic unless we use JS offsets.
            }
        };
        window.addEventListener('fontSettingsChanged', this._onFontChange);
    }

    render(content, file, type) {
        if (!this.container) return;

        this.destroy();

        this.currentFile = file;
        this.currentType = type;
        this.container.innerHTML = '';

        // 1. Container (Flex Row)
        const outerContainer = document.createElement('div');
        outerContainer.className = 'split-view-container';
        outerContainer.style.display = 'flex';
        outerContainer.style.height = '100%';
        outerContainer.style.overflow = 'hidden';

        // 2. Left Pane (Tree)
        const leftPaneDOM = document.createElement('div');
        leftPaneDOM.className = 'split-pane left-pane';
        leftPaneDOM.style.flex = '1';
        leftPaneDOM.style.display = 'flex';
        leftPaneDOM.style.flexDirection = 'column';
        leftPaneDOM.style.overflow = 'hidden';
        leftPaneDOM.style.height = '100%';
        leftPaneDOM.style.borderRight = '1px solid var(--border-color)';
        leftPaneDOM.style.minWidth = '300px';

        const leftHeader = document.createElement('div');
        leftHeader.className = 'pane-header';
        leftHeader.textContent = 'Document Tree';
        leftPaneDOM.appendChild(leftHeader);

        const treeContainer = document.createElement('div');
        treeContainer.className = 'tree-container';
        treeContainer.style.flex = '1';
        treeContainer.style.minHeight = '0';
        treeContainer.style.overflow = 'hidden';
        treeContainer.style.position = 'relative';
        leftPaneDOM.appendChild(treeContainer);

        // 3. Right Pane (Source)
        const rightPane = document.createElement('div');
        rightPane.className = 'split-pane right-pane';
        rightPane.style.flex = '2';
        rightPane.style.display = 'flex';
        rightPane.style.flexDirection = 'column';
        rightPane.style.minWidth = '300px';

        const rightHeader = document.createElement('div');
        rightHeader.className = 'pane-header';
        rightHeader.textContent = 'Selected Element Source';
        rightPane.appendChild(rightHeader);

        const rightPaneContent = document.createElement('div');
        rightPaneContent.className = 'source-container';
        rightPaneContent.style.flex = '1';
        rightPaneContent.style.position = 'relative';
        rightPaneContent.style.overflow = 'hidden';
        rightPane.appendChild(rightPaneContent);

        // 4. Splitter
        const splitter = document.createElement('div');
        splitter.className = 'split-handler';
        splitter.style.width = '4px';
        splitter.style.cursor = 'col-resize';
        splitter.style.backgroundColor = 'var(--border-color)';
        splitter.style.flexShrink = '0';

        let isResizing = false;
        splitter.onmousedown = (e) => {
            isResizing = true;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        };

        const onMouseMove = (e) => {
            if (!isResizing) return;
            const containerRect = outerContainer.getBoundingClientRect();
            const newLeftWidth = e.clientX - containerRect.left;
            if (newLeftWidth > 150 && newLeftWidth < containerRect.width - 150) {
                leftPaneDOM.style.flex = `0 0 ${newLeftWidth}px`;
            }
        };

        const onMouseUp = () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        this._cleanupEvents = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        outerContainer.appendChild(leftPaneDOM);
        outerContainer.appendChild(splitter);
        outerContainer.appendChild(rightPane);
        this.container.appendChild(outerContainer);

        // 5. Async Parsing & Initialization
        (async () => {
            try {
                treeContainer.innerHTML = '<div class="loading-message" style="padding:20px; color:var(--text-color-secondary);">Parsing structure...</div>';
                
                // JSP is served as an HTML structure type, but its <% ... %>
                // blocks break the XML/HTML tokenizer and drop most of the doc.
                // Swap them for sentinels before parsing and restore afterwards.
                const useJsp = isJspContent(file.path, type, content);
                let parseContent = content;
                let jspBlocks = null;
                if (useJsp) {
                    const extracted = extractJsp(content);
                    parseContent = extracted.cleaned;
                    jspBlocks = extracted.blocks;
                }

                let rootNode;
                try {
                    // Try Rust parser first
                    rootNode = await invoke('parse_structured_data', { content: parseContent, format: type, filePath: file.path });
                } catch (e) {
                    // Fallback to JS Worker parser
                    rootNode = await parseAsync(parseContent, type);
                }

                if (jspBlocks) restoreJspInTree(rootNode, jspBlocks);

                // Set helper for stringification (Consistent assignment)
                if (type === 'xml') this.parser = XmlParser;
                else if (type === 'html') this.parser = HtmlParser;
                else this.parser = JsonParser;

                treeContainer.innerHTML = '';
                this.editor = new StructureEditor(
                    treeContainer,
                    rootNode,
                    (newModel) => {
                        // Fix: Must stringify the model before updating file content
                        if (this.parser && typeof this.parser.stringify === 'function') {
                            try {
                                const stringified = this.parser.stringify(newModel);
                                this.currentFile.content = stringified;
                                this.currentFile.isDirty = true;
                                if (this.onRenderTabs) this.onRenderTabs();
                            } catch (e) {
                                console.error('StructureView: Stringify failed during onUpdate', e);
                            }
                        }
                    },
                    (node) => {
                        this.currentSelectedNode = node;
                        this.renderRightPane(rightPaneContent);
                    },
                    {
                        onLazyLoad: async (node) => {
                            try {
                                const children = await invoke('get_node_children', { filePath: file.path, nodeId: node.id });
                                if (jspBlocks) children.forEach((c) => restoreJspInTree(c, jspBlocks));
                                node.children = children;
                                node.lazy = false;
                                return true;
                            } catch (e) {
                                console.error('Lazy load failed:', e);
                                return false;
                            }
                        }
                    }
                );
                this.editor.mount();

                // Restore the tree scroll position (saved in destroy()) so
                // switching tabs and coming back keeps the same viewport. The
                // tree re-parses deterministically, so scrollTop maps back.
                const savedTop = file && file._structScrollTop;
                if (savedTop && this.editor.elements && this.editor.elements.viewport) {
                    requestAnimationFrame(() => {
                        if (this.editor && this.editor.elements && this.editor.elements.viewport) {
                            this.editor.elements.viewport.scrollTop = savedTop;
                            this.editor.render();
                        }
                    });
                }
            } catch (err) {
                console.error('Structure Parse Error:', err);
                treeContainer.innerHTML = `
                    <div style="padding:20px; color:var(--error-color);">
                        <h4>Parse Error</h4>
                        <p>${err.message}</p>
                        <button class="primary-btn" id="retry-structure-btn">Retry</button>
                    </div>
                `;
                const btn = treeContainer.querySelector('#retry-structure-btn');
                if (btn) btn.onclick = () => this.render(content, file, type);
            }
        })();
    }

    renderRightPane(container) {
        if (!this.currentSelectedNode || !this.parser) return;
        
        container.innerHTML = '';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';

        const sourceWrapper = document.createElement('div');
        sourceWrapper.className = 'node-source-wrapper';
        sourceWrapper.style.flex = '1';
        sourceWrapper.style.position = 'relative';
        sourceWrapper.style.overflow = 'hidden';

        container.appendChild(sourceWrapper);

        const checkLazyRecursive = (node) => {
            if (node.lazy) return true;
            if (node.children && node.children.length > 0) {
                return node.children.some(checkLazyRecursive);
            }
            return false;
        };

        if (checkLazyRecursive(this.currentSelectedNode)) {
            if (this.cmView) {
                this.cmView.destroy();
                this.cmView = null;
            }
            sourceWrapper.innerHTML = `
                <div style="padding: 20px; color: var(--text-color); font-family: var(--font-primary); text-align: center; margin-top: 50px;">
                    <h4 style="color: var(--accent-color); margin-bottom: 10px;">⚠️ Incomplete Data</h4>
                    <p style="opacity: 0.8; font-size: 0.9em; line-height: 1.5;">This node contains unloaded content (lazy nodes).</p>
                    <p style="opacity: 0.8; font-size: 0.9em; line-height: 1.5;">Please fully expand it in the tree to load all children before viewing or editing its source.</p>
                </div>
            `;
            return;
        }

        const fragment = this.parser.stringify(this.currentSelectedNode);

        // Instantiate CodeMirrorView
        if (this.cmView) {
            this.cmView.destroy();
        }

        const dummyFile = {
            path: `fragment_${this.currentSelectedNode.id || 'node'}.${this.currentType || 'txt'}`,
            content: fragment,
            isDirty: false
        };

        this.cmView = new CodeMirrorView(sourceWrapper, { renderTabs: false });
        this.cmView.render(fragment, dummyFile, this.currentType);
    }

    applyChanges(newValue) {
        try {
            let newNode;
            if (this.currentType === 'json') {
                newNode = JsonParser.parse(newValue);
            } else if (this.currentType === 'xml') {
                newNode = XmlParser.parse(newValue);
            } else if (this.currentType === 'html') {
                newNode = HtmlParser.parse(newValue);
            }

            if (newNode) {
                this.updateNode(this.currentSelectedNode.id, newNode);
            }
        } catch (err) {
            alert('Invalid format: ' + err.message);
            console.error(err);
        }
    }
    handleShortcut(cmd, e) {
        if (cmd === 'structure:save' || cmd === 'app:save') {
           if (this.cmView) {
               this.applyChanges(this.cmView.editorView.state.doc.toString());
               window.dispatchEvent(new CustomEvent('app:save-shortcut')); 
           }
           return true;
        } else if (cmd === 'app:copy') {
            this.copy();
            return true;
        } else if (cmd === 'app:cut') {
            this.cut();
            return true;
        } else if (cmd === 'app:paste') {
            this.paste();
            return true;
        } else if (cmd === 'app:undo') {
            this.undo();
            return true;
        } else if (cmd === 'app:redo') {
            this.redo();
            return true;
        }
        // Return undefined/false for commands we don't handle (e.g. app:toggle-view-mode)
        // so the delegateToView fallback in App.js will fire
        return false;
    }

    undo() {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            document.execCommand('undo');
        } else if (this.editor && this.editor.undo) {
            if (this.editor.undo()) {
                this.syncSelectionAfterUndo();
            }
        }
    }

    redo() {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            document.execCommand('redo');
        } else if (this.editor && this.editor.redo) {
            if (this.editor.redo()) {
                this.syncSelectionAfterUndo();
            }
        }
    }

    syncSelectionAfterUndo() {
        if (!this.editor || !this.editor.state.selectedNodeId) return;
        
        // Re-find node logic to refresh reference
        const node = this.editor.findNodeInternal(this.editor.model, this.editor.state.selectedNodeId);
        if (node) {
            this.currentSelectedNode = node;
            const rightPane = this.container.querySelector('.source-container');
            if (rightPane) this.renderRightPane(rightPane);
        } else {
            this.currentSelectedNode = null;
            const rightPane = this.container.querySelector('.source-container');
            if (rightPane) rightPane.innerHTML = '';
        }
    }

    async copy() {
        // 1. Legacy <input>/<textarea> selection.
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            const text = active.value.substring(active.selectionStart, active.selectionEnd);
            if (text) { await writeText(text); return; }
        }
        // 2. Selection in the right-hand source pane (CodeMirror 6). Its content
        //    is a contentEditable div, not an <input>, so the check above misses
        //    it — the copy would fall through to the tree node instead.
        if (this.cmView && typeof this.cmView.getSelectedText === 'function') {
            const cmText = this.cmView.getSelectedText();
            if (cmText) { await writeText(cmText); return; }
        }
        // 3. Any other live text selection inside the view (e.g. tree labels).
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && this.container && this.container.contains(sel.anchorNode)) {
            const text = sel.toString();
            if (text) { await writeText(text); return; }
        }
        // 4. Nothing selected → copy the selected tree node.
        if (this.editor) this.editor.copy();
    }

    async cut() {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            const start = active.selectionStart;
            const end = active.selectionEnd;
            const text = active.value.substring(start, end);
            if (text) {
                await writeText(text);
                active.value = active.value.substring(0, start) + active.value.substring(end);
                active.selectionStart = active.selectionEnd = start;
                active.dispatchEvent(new Event('input'));
                return;
            }
        }
        // Source pane (CodeMirror 6): copy the selection, then delete it via CM.
        if (this.cmView && typeof this.cmView.getSelectedText === 'function') {
            const cmText = this.cmView.getSelectedText();
            if (cmText) {
                await writeText(cmText);
                if (typeof this.cmView.replaceSelectedText === 'function') {
                    this.cmView.replaceSelectedText('');
                }
                return;
            }
        }
        if (this.editor) this.editor.cut();
    }

    async paste() {
        const active = document.activeElement;
        let text = '';
        try {
            text = await readText();
        } catch (err) {
            console.warn('StructureView: Paste failed or empty clipboard', err);
        }
        if (!text) return;

        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            const start = active.selectionStart;
            const end = active.selectionEnd;
            const val = active.value;
            active.value = val.substring(0, start) + text + val.substring(end);
            active.selectionStart = active.selectionEnd = start + text.length;
            active.dispatchEvent(new Event('input'));
            return;
        }

        // Tree Node Paste
        if (!this.editor || !this.editor.state.selectedNodeId) return;

        let newNode;
        try {
            if (this.currentType === 'json') {
                newNode = JsonParser.parse(text);
            } else if (this.currentType === 'xml') {
                newNode = XmlParser.parse(text);
            } else if (this.currentType === 'html') {
                newNode = HtmlParser.parse(text);
            }
        } catch (e) {
            console.error('Invalid paste format');
            return;
        }

        if (newNode) {
            const target = this.editor.findNodeInternal(this.editor.model, this.editor.state.selectedNodeId);
            if (!target) return;

            // Generate new IDs
            const assignIds = (n) => {
                n.id = crypto.randomUUID();
                if (n.children) n.children.forEach(assignIds);
            };
            assignIds(newNode);

            this.editor.saveState();

            if (target.type === 'object' || target.type === 'array' || target.type === 'element') {
                if (!target.children) target.children = [];
                if (newNode.key === undefined && target.type === 'object') {
                    newNode.key = 'new_property';
                } else if (target.type === 'array') {
                    newNode.key = `[${target.children.length}]`;
                }
                target.children.push(newNode);
                this.editor.state.expandedNodes.add(target.id);
            } else {
                target.value = newNode.value || text;
            }
            this.editor.render();
            
            // Sync with file
            try {
                const fullSource = this.parser.stringify(this.editor.model);
                this.currentFile.content = fullSource;
                this.currentFile.isDirty = true;
                if (this.onRenderTabs) this.onRenderTabs();
            } catch (e) {
                console.error(e);
            }
        }
    }

    updateNode(nodeId, newNode) {
        if (!this.editor || !this.editor.model) return;

        const findAndReplace = (root) => {
            if (root.id === nodeId) {
                this.editor.saveState();
                newNode.id = nodeId;
                newNode.key = root.key; // Preserve original key to maintain object structure
                Object.assign(root, newNode);
                return true;
            }
            if (root.children) {
                for (let i = 0; i < root.children.length; i++) {
                    if (findAndReplace(root.children[i])) return true;
                }
            }
            return false;
        };

        if (findAndReplace(this.editor.model)) {
            this.editor.render();
            try {
                const fullSource = this.parser.stringify(this.editor.model);
                this.currentFile.content = fullSource;
                this.currentFile.isDirty = true;
                if (this.onRenderTabs) this.onRenderTabs();
            } catch (e) {
                console.error('StructureView: Stringify failed during updateNode', e);
                alert('Failed to generate source: ' + e.message);
            }
        }
    }

    _handleInlineAI(textarea) {
        const cursorPos = textarea.selectionStart;
        const text = textarea.value;

        // Extract context (±20 lines)
        const lines = text.split('\n');
        let currentLineIdx = 0;
        let charAcc = 0;
        for (let i = 0; i < lines.length; i++) {
            if (charAcc + lines[i].length >= cursorPos) {
                currentLineIdx = i;
                break;
            }
            charAcc += lines[i].length + 1;
        }

        const startLine = Math.max(0, currentLineIdx - 20);
        const endLine = Math.min(lines.length - 1, currentLineIdx + 20);
        const context = lines.slice(startLine, endLine + 1).join('\n');

        // Accurate Cursor Position Calculation
        const mirror = document.createElement('div');
        const style = window.getComputedStyle(textarea);
        mirror.style.position = 'absolute';
        mirror.style.visibility = 'hidden';
        mirror.style.whiteSpace = 'pre-wrap';
        mirror.style.wordBreak = 'break-word';
        mirror.style.top = '0';
        mirror.style.left = '0';
        mirror.style.font = style.font;
        mirror.style.width = style.width;
        mirror.style.padding = style.padding;
        mirror.style.border = style.border;
        mirror.style.lineHeight = style.lineHeight;

        const beforeText = text.substring(0, cursorPos);
        mirror.textContent = beforeText;
        const marker = document.createElement('span');
        marker.textContent = '|';
        mirror.appendChild(marker);

        document.body.appendChild(mirror);
        const markerPos = marker.getBoundingClientRect();
        const mirrorRect = mirror.getBoundingClientRect();
        document.body.removeChild(mirror);

        const textareaRect = textarea.getBoundingClientRect();
        const x = textareaRect.left + (markerPos.left - mirrorRect.left) - textarea.scrollLeft + 20;
        const y = textareaRect.top + (markerPos.top - mirrorRect.top) - textarea.scrollTop + 20;

        const selStart = textarea.selectionStart;
        const selEnd = textarea.selectionEnd;

        this.inlineAI.show(x, y, context);
        this.inlineAI.onApply = (newCode) => {
            const val = textarea.value;
            textarea.value = val.substring(0, selStart) + newCode + val.substring(selEnd);
            textarea.selectionStart = selStart;
            textarea.selectionEnd = selStart + newCode.length;
            textarea.dispatchEvent(new Event('input'));
        };
    }

    replaceSelectedText(text) {
        if (this.sourceTextarea) {
            const ta = this.sourceTextarea;
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const val = ta.value;
            ta.value = val.substring(0, start) + text + val.substring(end);
            ta.selectionStart = start;
            ta.selectionEnd = start + text.length;
            ta.dispatchEvent(new Event('input'));
        }
    }

    destroy() {
        if (this._cleanupEvents) {
            this._cleanupEvents();
            this._cleanupEvents = null;
        }
        window.removeEventListener('shortcutTriggered', this.boundShortcutHandler);
        // Save the tree scroll position so reopening this tab restores it.
        if (this.currentFile && this.editor && this.editor.elements && this.editor.elements.viewport) {
            try { this.currentFile._structScrollTop = this.editor.elements.viewport.scrollTop; } catch (e) { /* ignore */ }
        }
        if (this.editor && typeof this.editor.destroy === 'function') {
            this.editor.destroy();
        }
        if (this.cmView) {
            this.cmView.destroy();
            this.cmView = null;
        }
        this.editor = null;
        this.parser = null;
        this.currentSelectedNode = null;
        this.currentFile = null;
        this.currentType = null;
        this.searchHighlightsContent = null;
        this.scrollDecorations = null;
        this.sourceTextarea = null;
    }

    renderSearchHighlights(matches, activeIndex) {
        if (!this.sourceTextarea || !this.searchHighlightsContent) return;
        if (!matches || matches.length === 0) {
            this.searchHighlightsContent.innerHTML = '';
            if (this.scrollDecorations) {
                const marks = this.scrollDecorations.querySelectorAll('.search-scroll-mark');
                marks.forEach(m => m.remove());
            }
            return;
        }

        const text = this.sourceTextarea.value;
        let html = '';
        let scrollHtml = '';
        const scrollHeight = this.sourceTextarea.scrollHeight;
        const lineHeight = this._measureLineHeight();
        const lines = text.split('\n');

        const getLineAndCol = (offset) => {
            const sub = text.substring(0, offset);
            const subLines = sub.split('\n');
            return {
                line: subLines.length - 1,
                col: subLines[subLines.length - 1].length
            };
        };

        matches.forEach((m, idx) => {
            if (!m.isPlainText) return;
            const isActive = idx === activeIndex;
            const className = isActive ? 'search-match active' : 'search-match';
            
            const { line, col } = getLineAndCol(m.start);
            if (line < lines.length) {
                const lineText = lines[line];
                const measureLeft = this._measureText(lineText.substring(0, col));
                const measureWidth = this._measureText(lineText.substring(col, col + (m.end - m.start)));
                const width = (measureWidth === 0) ? 2 : measureWidth;
                const bg = isActive ? '#ff9800' : 'rgba(255, 255, 0, 0.5)';
                const inlineStyle = `background-color: ${bg}; border-radius: 2px; pointer-events: none;`;
                
                html += `<div class="${className}" style="position:absolute; top:${line * lineHeight}px; left:${10 + measureLeft}px; width:${width}px; height:${lineHeight}px; ${inlineStyle}"></div>`;
            }
            
            if (this.scrollDecorations && scrollHeight > 0) {
                const { line } = getLineAndCol(m.start);
                const yPos = line * lineHeight;
                const topPct = (yPos / scrollHeight) * 100;
                const markClass = isActive ? 'search-scroll-mark active' : 'search-scroll-mark';
                scrollHtml += `<div class="${markClass}" style="top:${topPct}%;" data-line="${line}" data-start="${m.start}" data-end="${m.end}"></div>`;
            }
        });

        this.searchHighlightsContent.innerHTML = html;
        
        if (this.scrollDecorations) {
            const oldMarks = this.scrollDecorations.querySelectorAll('.search-scroll-mark');
            oldMarks.forEach(m => m.remove());
            this.scrollDecorations.insertAdjacentHTML('beforeend', scrollHtml);
        }
    }

    getDiagnostics() {
        return [];
    }

    _handleNavHover(e) {
        if (!e || !this.sourceTextarea) return;
        this._lastMouseMoveEvent = e;
        const textarea = this.sourceTextarea;

        if (!e.ctrlKey) {
            this._clearNavHover();
            return;
        }

        const rect = textarea.getBoundingClientRect();
        const style = getComputedStyle(textarea);
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        
        const x = e.clientX - rect.left - paddingLeft + textarea.scrollLeft;
        const y = e.clientY - rect.top - paddingTop + textarea.scrollTop;

        const lineHeight = this._measureLineHeight(); 
        const lineIdx = Math.floor(y / lineHeight);
        const text = textarea.value;
        const lines = text.split('\n');
        
        if (lineIdx < 0 || lineIdx >= lines.length) return;
        
        const lineText = lines[lineIdx];
        const charIdx = this._getCharIndexAtX(lineText, x);
        const lineOffset = this._getLineOffset(lines, lineIdx);
        const offset = lineOffset + charIdx;

        const filePath = this.currentFile ? this.currentFile.path : '';
        const token = Navigation.resolveToken(text, offset, filePath);

        if (token && token.value) {
            textarea.style.cursor = 'pointer';
            this._renderNavMark(token, lines, lineIdx);
        } else {
            this._clearNavHover();
        }
    }

    _renderNavMark(token, lines, lineIdx) {
        if (!this.navOverlay || !this.sourceTextarea) return;
        this.navOverlay.innerHTML = '';

        const textarea = this.sourceTextarea;
        const style = getComputedStyle(textarea);
        const pt = parseFloat(style.paddingTop) || 10;
        const pl = parseFloat(style.paddingLeft) || 10;
        const lineHeight = this._measureLineHeight();

        // Get line/col of token start and end
        const tokenLines = textarea.value.substring(0, token.start).split('\n');
        const tokenLineIdx = tokenLines.length - 1;
        const tokenCol = tokenLines[tokenLineIdx].length;
        const tokenEndLines = textarea.value.substring(0, token.end).split('\n');
        const tokenEndCol = tokenEndLines[tokenEndLines.length - 1].length;

        if (tokenLineIdx !== tokenLines.length - 1) return; // multi-line: skip

        const lineText = (textarea.value.split('\n')[tokenLineIdx]) || '';
        const left = pl + this._measureText(lineText.substring(0, tokenCol));
        const width = this._measureText(lineText.substring(tokenCol, tokenEndCol));
        const top = pt + tokenLineIdx * lineHeight - textarea.scrollTop;

        const mark = document.createElement('div');
        mark.style.cssText = `position:absolute;pointer-events:none;` +
            `top:${top}px;left:${left}px;width:${width}px;height:${lineHeight}px;` +
            `border-bottom:1px solid #3498db;box-sizing:border-box;`;
        this.navOverlay.appendChild(mark);
    }

    _getLineOffset(lines, lineIdx) {
        let offset = 0;
        for (let i = 0; i < lineIdx; i++) {
            offset += lines[i].length + 1;
        }
        return offset;
    }

    _clearNavHover() {
        if (this.sourceTextarea) this.sourceTextarea.style.cursor = 'text';
        if (this.navOverlay) this.navOverlay.innerHTML = '';
    }

    _getCharIndexAtX(lineText, x) {
        let low = 0;
        let high = lineText.length;
        let bestIdx = 0;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (this._measureText(lineText.substring(0, mid)) <= x) {
                bestIdx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return bestIdx;
    }

    _measureText(text) {
        if (!this._mirror) {
            this._mirror = document.createElement('div');
            this._mirror.style.position = 'absolute';
            this._mirror.style.visibility = 'hidden';
            this._mirror.style.whiteSpace = 'pre';
            document.body.appendChild(this._mirror);
        }
        if (this.sourceTextarea) {
            const style = getComputedStyle(this.sourceTextarea);
            this._mirror.style.fontFamily = style.fontFamily;
            this._mirror.style.fontSize = style.fontSize;
            this._mirror.style.fontWeight = style.fontWeight;
            this._mirror.style.fontStyle = style.fontStyle;
            this._mirror.style.fontVariant = style.fontVariant;
            this._mirror.style.lineHeight = style.lineHeight;
            this._mirror.style.letterSpacing = style.letterSpacing;
            this._mirror.style.tabSize = style.tabSize;
            this._mirror.style.wordSpacing = style.wordSpacing;
            this._mirror.style.textIndent = style.textIndent;
        }
        this._mirror.textContent = text;
        return this._mirror.getBoundingClientRect().width;
    }

    _updateWordHighlight() {
        if (!this.sourceTextarea || !this.wordHighlightsContent) return;
        const text = this.sourceTextarea.value;
        const start = this.sourceTextarea.selectionStart;
        const end = this.sourceTextarea.selectionEnd;
        
        if (start === end || (end - start) > 100) {
            this.wordHighlightsContent.innerHTML = '';
            if (this.scrollDecorations) this.scrollDecorations.innerHTML = '';
            return;
        }

        const selectedText = text.substring(start, end);
        if (!/^[a-zA-Z0-9_\-]+$/.test(selectedText)) {
            this.wordHighlightsContent.innerHTML = '';
            if (this.scrollDecorations) this.scrollDecorations.innerHTML = '';
            return;
        }

        let html = '';
        let scrollHtml = '';
        const lines = text.split('\n');
        const scrollHeight = this.sourceTextarea.scrollHeight;
        let pos = -1;
        
        while ((pos = text.indexOf(selectedText, pos + 1)) !== -1) {
            html += this._createHighlightMark(pos, selectedText.length, 'word-hl', text, lines);
            if (this.scrollDecorations && scrollHeight > 0) {
                const { line } = this._getLineAndCol(pos, text);
                const lh = this._measureLineHeight();
                const yPos = line * lh;
                const topPct = (yPos / scrollHeight) * 100; 
                scrollHtml += `<div class="word-scroll-mark" style="top:${topPct}%;" data-line="${line}"></div>`;
            }
        }
        this.wordHighlightsContent.innerHTML = html;
        if (this.scrollDecorations) this.scrollDecorations.innerHTML = scrollHtml;
    }

    _updateBracketHighlight() {
        if (!this.sourceTextarea || !this.bracketHighlightsContent) return;
        const text = this.sourceTextarea.value;
        const pos = this.sourceTextarea.selectionStart;
        if (pos !== this.sourceTextarea.selectionEnd) {
            this.bracketHighlightsContent.innerHTML = '';
            return;
        }

        const brackets = { '(': ')', '{': '}', '[': ']' };
        const reverseBrackets = { ')': '(', '}': '{', ']': '[' };
        
        let targetPos = -1;
        let char = '';
        let isForward = true;

        if (pos < text.length && (brackets[text[pos]] || reverseBrackets[text[pos]])) {
            targetPos = pos;
            char = text[pos];
            isForward = !!brackets[char];
        } else if (pos > 0 && (brackets[text[pos - 1]] || reverseBrackets[text[pos - 1]])) {
            targetPos = pos - 1;
            char = text[pos - 1];
            isForward = !!brackets[char];
        }

        if (targetPos === -1) {
            this.bracketHighlightsContent.innerHTML = '';
            return;
        }

        const matchPos = this._findMatchingBracket(text, targetPos, char, isForward);
        let html = '';
        const lines = text.split('\n');
        html += this._createHighlightMark(targetPos, 1, 'bracket-highlight-mark', text, lines);
        if (matchPos !== -1) {
            html += this._createHighlightMark(matchPos, 1, 'bracket-highlight-mark', text, lines);
        }
        this.bracketHighlightsContent.innerHTML = html;
    }

    _findMatchingBracket(text, startPos, char, isForward) {
        const brackets = { '(': ')', '{': '}', '[': ']' };
        const reverseBrackets = { ')': '(', '}': '{', ']': '[' };
        const open = isForward ? char : reverseBrackets[char];
        const close = isForward ? brackets[char] : char;
        let count = 1;
        if (isForward) {
            for (let i = startPos + 1; i < text.length; i++) {
                if (text[i] === open) count++;
                else if (text[i] === close) count--;
                if (count === 0) return i;
            }
        } else {
            for (let i = startPos - 1; i >= 0; i--) {
                if (text[i] === close) count++;
                else if (text[i] === open) count--;
                if (count === 0) return i;
            }
        }
        return -1;
    }

    _createHighlightMark(offset, length, className, fullText, lines) {
        const { line, col } = this._getLineAndCol(offset, fullText);
        if (line >= lines.length) return '';
        const lineText = lines[line];
        const measure = this._measureRange(lineText, col, col + length);
        const lh = this._measureLineHeight();
        return `<div class="${className}" style="position:absolute; top:${line * lh}px; left:${measure.left}px; width:${measure.width}px; height:${lh}px;"></div>`;
    }

    _getLineAndCol(offset, text) {
        let line = 0;
        let col = 0;
        for (let i = 0; i < offset; i++) {
            if (text[i] === '\n') {
                line++;
                col = 0;
            } else {
                col++;
            }
        }
        return { line, col };
    }

    _measureLineHeight() {
        if (!this.sourceTextarea) return 21;
        const style = getComputedStyle(this.sourceTextarea);
        const lh = parseFloat(style.lineHeight);
        if (!isNaN(lh)) return Math.round(lh);
        const fontSize = parseFloat(style.fontSize) || 14;
        return Math.round(fontSize * 1.5);
    }

    _measureRange(lineText, startCol, endCol) {
        const before = lineText.substring(0, startCol);
        const target = lineText.substring(startCol, endCol);
        
        if (!this._mirror) {
            this._mirror = document.createElement('div');
            this._mirror.style.position = 'absolute';
            this._mirror.style.visibility = 'hidden';
            this._mirror.style.whiteSpace = 'pre';
            document.body.appendChild(this._mirror);
        }
        if (this.sourceTextarea) {
            const style = getComputedStyle(this.sourceTextarea);
            this._mirror.style.fontFamily = style.fontFamily;
            this._mirror.style.fontSize = style.fontSize;
            this._mirror.style.fontWeight = style.fontWeight;
            this._mirror.style.fontStyle = style.fontStyle;
            this._mirror.style.fontVariant = style.fontVariant;
            this._mirror.style.lineHeight = style.lineHeight;
            this._mirror.style.letterSpacing = style.letterSpacing;
            this._mirror.style.tabSize = style.tabSize;
            this._mirror.style.wordSpacing = style.wordSpacing;
            this._mirror.style.textIndent = style.textIndent;
        }

        this._mirror.innerHTML = '';
        const spanBefore = document.createElement('span');
        spanBefore.textContent = before;
        const spanTarget = document.createElement('span');
        spanTarget.textContent = target;
        this._mirror.appendChild(spanBefore);
        this._mirror.appendChild(spanTarget);
        
        let paddingLeft = 10;
        if (this.sourceTextarea) {
             const style = getComputedStyle(this.sourceTextarea);
             paddingLeft = parseFloat(style.paddingLeft) || 10;
        }
        
        return {
            left: paddingLeft + spanBefore.getBoundingClientRect().width,
            width: spanTarget.getBoundingClientRect().width
        };
    }
}
