import { State } from '../core/Store.js';
import { getCurrentView } from '../core/Editor.js';
import { MarkdownView } from '../views/MarkdownView.js';

export const OutlineModal = {
    show() {
        if (State.activeTabIndex < 0) return;
        const file = State.openFiles[State.activeTabIndex];
        if (!file || !file.content) return;

        const fileName = file.name || (file.path ? file.path.split(/[/\\]/).pop() : 'Untitled');
        const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        const isMarkdown = ext === 'md' || ext === 'markdown';

        // Parse headings/functions from the file content
        const lines = file.content.split(/\r?\n/);
        const headings = [];
        let index = 0; // track line index for plain text navigation
        
        lines.forEach((line) => {
            let item = null;
            if (isMarkdown) {
                const match = line.match(/^(#{1,6})\s+(.*)/);
                if (match) {
                    item = { level: match[1].length, text: match[2], lineIndex: index, fullText: line };
                }
            } else {
                // simple heuristic for JS, Java, Rust, Python, etc.
                const classMatch = line.match(/^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+)*(class|interface|struct|enum|trait|impl)\s+([a-zA-Z0-9_]+)/);
                if (classMatch) {
                    item = { level: 1, text: `${classMatch[1]} ${classMatch[2]}`, lineIndex: index, fullText: line };
                } else {
                    const fnMatch = line.match(/^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:function|def|fn)\s+([a-zA-Z0-9_]+)/);
                    if (fnMatch) {
                        item = { level: 2, text: `${fnMatch[1]}()`, lineIndex: index, fullText: line };
                    } else {
                        // methods/arrow functions
                        const methodMatch = line.match(/^\s*(?:export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+)*([a-zA-Z0-9_]+)\s*\([^)]*\)\s*(?::\s*[a-zA-Z0-9_<>]+)?\s*\{/);
                        if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
                            item = { level: 2, text: `${methodMatch[1]}()`, lineIndex: index, fullText: line };
                        } else {
                            const arrowMatch = line.match(/^\s*(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/);
                            if (arrowMatch) {
                                item = { level: 2, text: `${arrowMatch[1]}()`, lineIndex: index, fullText: line };
                            }
                        }
                    }
                }
            }
            if (item) headings.push(item);
            index++;
        });

        if (headings.length === 0) {
            // Optional: Show a toast saying no headings found
            return;
        }

        // Remove existing if any
        const existing = document.getElementById('outline-modal-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'outline-modal-overlay';
        overlay.className = 'tab-search-overlay'; // Reuse tab-search styling

        const container = document.createElement('div');
        container.className = 'tab-search-container';
        container.style.width = '600px';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tab-search-input';
        input.placeholder = 'Search headings...';

        const list = document.createElement('ul');
        list.className = 'tab-search-list';

        let selectedIndex = 0;
        let filteredHeadings = [...headings];

        const updateSelection = () => {
            const items = list.querySelectorAll('.tab-search-item');
            items.forEach((li, i) => {
                if (i === selectedIndex) {
                    li.classList.add('selected');
                    li.scrollIntoView({ block: 'nearest' });
                } else {
                    li.classList.remove('selected');
                }
            });
        };

        const renderList = () => {
            list.innerHTML = '';
            filteredHeadings.forEach((item, i) => {
                const li = document.createElement('li');
                li.className = 'tab-search-item outline-item-row';
                if (i === selectedIndex) li.classList.add('selected');

                // Indent based on heading level (e.g., h1: 0, h2: 20px, h3: 40px)
                const indent = (Math.max(1, item.level) - 1) * 20;
                
                const prefix = isMarkdown ? '<span style="color: var(--primary-color); opacity: 0.7; margin-right: 5px;">' + '#'.repeat(item.level) + '</span> ' : '';
                li.innerHTML = `
                    <span class="name" style="padding-left: ${indent}px; opacity: ${1 - (item.level - 1) * 0.15};">
                        ${prefix}${item.text}
                    </span>
                `;
                
                li.onclick = () => selectAndClose(item);
                list.appendChild(li);
            });
            
            updateSelection();
        };

        const selectAndClose = (item) => {
            overlay.remove();
            
            const currentView = getCurrentView();
            if (currentView && typeof currentView.jumpToLine === 'function') {
                currentView.jumpToLine(item.lineIndex, item.fullText);
                if (currentView.blocksData) {
                    // Highlight the block element on the page for Markdown mode
                    setTimeout(() => {
                        for (let i = 0; i < currentView.blocksData.length; i++) {
                            if (currentView.blocksData[i].includes(item.fullText || item.originalLine)) {
                                const blocks = document.querySelectorAll('.md-block');
                                blocks.forEach(b => {
                                    if (parseInt(b.dataset.index) === i) {
                                        b.style.transition = 'background-color 0.5s';
                                        b.style.backgroundColor = 'rgba(var(--primary-rgb, 0, 122, 204), 0.3)';
                                        setTimeout(() => b.style.backgroundColor = 'transparent', 1000);
                                    }
                                });
                                break;
                            }
                        }
                    }, 100);
                }
            } else if (currentView && currentView.blocksData) {
                for (let i = 0; i < currentView.blocksData.length; i++) {
                    if (currentView.blocksData[i].includes(item.fullText || item.originalLine)) {
                        if (typeof currentView.selectBlock === 'function') {
                            currentView.selectBlock(i);
                            
                            // Highlight the block element on the page
                            setTimeout(() => {
                                const blocks = document.querySelectorAll('.md-block');
                                blocks.forEach(b => {
                                    if (parseInt(b.dataset.index) === i) {
                                        b.style.transition = 'background-color 0.5s';
                                        b.style.backgroundColor = 'rgba(var(--primary-rgb, 0, 122, 204), 0.3)';
                                        setTimeout(() => b.style.backgroundColor = 'transparent', 1000);
                                    }
                                });
                            }, 100);
                        }
                        break;
                    }
                }
            } else if (currentView && typeof currentView.jumpToLine === 'function' && !currentView.textarea) {
                // CodeMirror view: jump by line index (selects + scrolls to it).
                currentView.jumpToLine(item.lineIndex);
            } else if (currentView && currentView.textarea) {

                // Plain text view fallback
                const linesArr = currentView.textarea.value.split('\n');
                let charPos = 0;
                for (let i = 0; i < item.lineIndex; i++) {
                    charPos += linesArr[i].length + 1; // +1 for newline
                }
                currentView.textarea.focus();
                currentView.textarea.setSelectionRange(charPos, charPos + item.fullText.length);
                
                // Scroll to line roughly
                const lineHeight = parseFloat(getComputedStyle(currentView.textarea).lineHeight) || 20;
                currentView.textarea.scrollTop = (item.lineIndex * lineHeight) - (currentView.textarea.clientHeight / 2);
            }
        };

        input.addEventListener('input', () => {
            const query = input.value.toLowerCase();
            filteredHeadings = headings.filter(item => item.text.toLowerCase().includes(query));
            selectedIndex = 0;
            renderList();
        });

        input.addEventListener('keydown', (e) => {
            if (e.isComposing) return;
            
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                if (filteredHeadings.length > 0) {
                    selectedIndex = (selectedIndex + 1) % filteredHeadings.length;
                    updateSelection();
                }
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                if (filteredHeadings.length > 0) {
                    selectedIndex = (selectedIndex - 1 + filteredHeadings.length) % filteredHeadings.length;
                    updateSelection();
                }
                return;
            } else if (e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                if (filteredHeadings.length > 0) {
                    if (e.shiftKey) {
                        selectedIndex = (selectedIndex - 1 + filteredHeadings.length) % filteredHeadings.length;
                    } else {
                        selectedIndex = (selectedIndex + 1) % filteredHeadings.length;
                    }
                    renderList();
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (filteredHeadings[selectedIndex]) {
                    selectAndClose(filteredHeadings[selectedIndex]);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                overlay.remove();
            }
        });

        // Close on click outside
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        container.appendChild(input);
        container.appendChild(list);
        overlay.appendChild(container);
        document.body.appendChild(overlay);

        renderList();
        input.focus();
    }
};
