
/**
 * StructureEditor.js
 * A generic tree-based editor for structured data (XML, JSON).
 * Follows Component Architecture Skill.
 */
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

export class StructureEditor {
    constructor(container, model, onUpdate, onSelectionChange, options = {}) {
        this.container = container;
        this.model = model; // Root Node of the Generic Tree
        this.onUpdate = onUpdate; // Callback when data changes
        this.onSelectionChange = onSelectionChange; // New callback
        this.options = options;
        this.renderLabel = options.renderLabel || null;

        this.history = [];
        this.future = [];

        this.state = {
            expandedNodes: new Set(), // Set of Node IDs
            selectedNodeId: null,
            editingNodeId: null,
            editingField: null, // 'key' or 'value'
            filterText: ''
        };

        this.elements = {}; // DOM Cache
        this.visibleNodes = []; // Flat list of currently visible nodes
        this.rowHeight = 35; // Estimated height for calculation
        this.bindMethods();
    }

    saveState() {
        if (this.model) {
            this.history.push(JSON.parse(JSON.stringify(this.model)));
            if (this.history.length > 50) this.history.shift();
            this.future = [];
        }
    }

    undo() {
        if (this.history.length > 0) {
            this.future.push(JSON.parse(JSON.stringify(this.model)));
            this.model = this.history.pop();
            this.render();
            if (this.onUpdate) this.onUpdate(this.model);
            return true;
        }
        return false;
    }

    redo() {
        if (this.future.length > 0) {
            this.history.push(JSON.parse(JSON.stringify(this.model)));
            this.model = this.future.pop();
            this.render();
            if (this.onUpdate) this.onUpdate(this.model);
            return true;
        }
        return false;
    }

    bindMethods() {
        this.handleClick = this.handleClick.bind(this);
        this.handleDoubleClick = this.handleDoubleClick.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
    }

    mount() {
        this.elements.root = document.createElement('div');
        this.elements.root.className = 'structure-editor';
        this.elements.root.tabIndex = 0; // Focusable
        this.elements.root.style.cssText = 'display: flex; flex-direction: column; height: 100%; outline: none; overflow: hidden;';

        // Header / Breadcrumbs (Fixed)
        this.elements.breadcrumbs = document.createElement('div');
        this.elements.breadcrumbs.className = 'structure-breadcrumbs';
        this.elements.breadcrumbs.style.flex = '0 0 auto';
        this.elements.root.appendChild(this.elements.breadcrumbs);

        // Scroll Viewport (Flex)
        this.elements.viewport = document.createElement('div');
        this.elements.viewport.className = 'structure-viewport';
        this.elements.viewport.style.cssText = 'flex: 1; overflow-y: auto; overflow-x: hidden; position: relative;';
        this.elements.root.appendChild(this.elements.viewport);

        // Content List (Inside Viewport)
        this.elements.list = document.createElement('div');
        this.elements.list.className = 'structure-virtual-list';
        this.elements.list.style.position = 'relative';
        this.elements.viewport.appendChild(this.elements.list);

        this.render();

        this.container.innerHTML = '';
        this.container.appendChild(this.elements.root);

        this.bindEvents();
        this.focus();
    }

    /**
     * Give the tree keyboard focus so the arrow keys work right away.
     *
     * The keydown listener lives on `elements.root`, so it only ever fired once
     * the user had clicked inside the tree. Opening the file from the explorer
     * or by clicking its tab leaves focus on the explorer row / the tab strip /
     * <body>, and every arrow key silently did nothing. Mirrors CsvEditor's
     * initial focus, including its "don't steal focus from the explorer" guard
     * so keyboard navigation there keeps working.
     */
    focus() {
        setTimeout(() => {
            const root = this.elements && this.elements.root;
            if (!root || !root.isConnected) return;
            const active = document.activeElement;
            if (active && typeof active.closest === 'function') {
                if (active.closest('#explorer') || active.closest('#file-explorer')
                    || active.closest('.virtual-explorer-host')) return;
                if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
                    || active.isContentEditable) return;
            }
            root.focus({ preventScroll: true });
        }, 50);
    }

    destroy() {
        this.unbindEvents();
        if (this.elements.root) {
            this.elements.root.remove();
        }
        this.elements = {};
    }

    bindEvents() {
        this.elements.root.addEventListener('click', this.handleClick);
        this.elements.root.addEventListener('dblclick', this.handleDoubleClick);
        this.elements.root.addEventListener('keydown', this.handleKeyDown);

        if (this.elements.viewport) {
            this.elements.viewport.addEventListener('scroll', () => this.render());
        }

        // Safety net for the same problem focus() solves: focus can end up
        // outside the tree at any time (closing a modal, the source pane
        // re-rendering, a click on the tab strip), and the root-bound listener
        // then never sees the key. Handle it at the window level and bow out
        // whenever something else legitimately owns the arrows.
        this._windowKeyHandler = (e) => {
            const root = this.elements && this.elements.root;
            if (!root || !root.isConnected || root.offsetParent === null) return;
            if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.key)) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            // The explorer stamps the arrow keys it owns (VirtualExplorer
            // .handleKeyDown); its virtual list detaches the focused row, so
            // the target/activeElement checks below can't see it — the stamp can.
            if (e.__explorerKeyDown) return;
            const t = e.target;
            // Inside the tree already → the root listener handles it.
            if (t && typeof t.closest === 'function' && root.contains(t)) return;
            const owners = '#explorer, #file-explorer, .virtual-explorer-host, .cm-editor, #search-panel, '
                + '.tab-search-overlay, .ai-review-overlay, .settings-modal, .modal-overlay, .node-source-editor';
            const claimed = (el) => !!(el && typeof el.closest === 'function' && el.closest(owners));
            if (claimed(t) || claimed(document.activeElement)) return;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;

            this.handleKeyDown(e);
        };
        window.addEventListener('keydown', this._windowKeyHandler, true);
    }

    unbindEvents() {
        if (this.elements.root) {
            this.elements.root.removeEventListener('click', this.handleClick);
            this.elements.root.removeEventListener('dblclick', this.handleDoubleClick);
            this.elements.root.removeEventListener('keydown', this.handleKeyDown);
        }
        if (this._windowKeyHandler) {
            window.removeEventListener('keydown', this._windowKeyHandler, true);
            this._windowKeyHandler = null;
        }
    }

    // --- API ---

    select(nodeId) {
        this.state.selectedNodeId = nodeId;
        this.render();

        if (this.onSelectionChange) {
            const node = this.findNodeInternal(this.model, nodeId);
            if (node) {
                this.onSelectionChange(node);
            }
        }
    }

    // --- Rendering ---

    render() {
        if (!this.elements.root) return;

        // 1. Prepare Flat List
        this.visibleNodes = [];
        this.flattenVisibleNodes(this.model, 0, this.visibleNodes);

        // 2. Breadcrumbs
        this.renderBreadcrumbs(this.elements.breadcrumbs);

        // 3. Virtual List Sizing
        const totalHeight = this.visibleNodes.length * this.rowHeight;
        this.elements.list.style.height = `${totalHeight}px`;
        this.elements.list.innerHTML = ''; // Clear only list items

        // 4. Calculate Visible Range
        const scrollTop = this.elements.viewport.scrollTop;
        const viewportHeight = this.elements.viewport.clientHeight;

        const startIndex = Math.max(0, Math.floor(scrollTop / this.rowHeight) - 5);
        const endIndex = Math.min(this.visibleNodes.length, Math.ceil((scrollTop + viewportHeight) / this.rowHeight) + 15);

        // 5. Render visible range
        for (let i = startIndex; i < endIndex; i++) {
            const nodeData = this.visibleNodes[i];
            this.renderNodeVirtual(nodeData, i, this.elements.list);
        }
    }

    flattenVisibleNodes(node, level, list, labelOverride = null) {
        // Fallback Simplification for display:
        // If node has children but only 1 child and it is text (or just empty text nodes), treat as leaf value.
        // This handles cases where parser didn't simplify or data structure varies.
        let effectiveChildren = node.children;
        let effectiveValue = node.value;

        // Display check for specific nodes (like HTML script, style)
        const isOmitTextNode = (node.key && typeof node.key === 'string' && ['script', 'style'].includes(node.key.toLowerCase()));

        if (node.children && node.children.length > 0) {
            const nonTextChildren = node.children.filter(c => !(c.type === 'text'));
            const textChildren = node.children.filter(c => c.type === 'text' && c.value.trim() !== '');

            if (nonTextChildren.length === 0 && textChildren.length === 1) {
                // It's effectively a leaf with value
                effectiveValue = isOmitTextNode ? null : textChildren[0].value;
                effectiveChildren = [];
            }
            
            if (isOmitTextNode && effectiveChildren) {
                effectiveChildren = effectiveChildren.filter(c => c.type !== 'text');
            }
        }
        
        if (isOmitTextNode && effectiveValue) {
            effectiveValue = null;
        }

        // Final safety truncate for extremely long inline values (e.g. base64 images or minified json blocks)
        if (effectiveValue && typeof effectiveValue === 'string' && effectiveValue.length > 150) {
            effectiveValue = effectiveValue.substring(0, 150) + '...';
        }

        const displayNode = { ...node, value: effectiveValue, children: effectiveChildren };
        // If we force it to be a leaf in display, we must ensure hasChildren check fails downstream.

        // Lazy Label: Don't compute label here. Just pass override if exists.
        list.push({ node: displayNode, level, labelOverride });

        if (this.state.expandedNodes.has(node.id) && effectiveChildren && effectiveChildren.length > 0) {
            const keyCounts = {};
            effectiveChildren.forEach(c => keyCounts[c.key] = (keyCounts[c.key] || 0) + 1);
            const keyIndices = {};

            effectiveChildren.forEach(child => {
                let childLabel = child.key;
                if (node.type !== 'element' && node.type !== 'root' && keyCounts[child.key] > 1) {
                    const idx = keyIndices[child.key] || 0;
                    childLabel += `[${idx}]`;
                    keyIndices[child.key] = idx + 1;
                }
                this.flattenVisibleNodes(child, level + 1, list, childLabel);
            });
        }
    }

    renderNodeVirtual(nodeData, index, parentElement) {
        const { node, level, labelOverride } = nodeData;

        // Lazy Label Computation
        let label = labelOverride || node.key || (node.type === 'root' ? 'Root' : '');
        let idxSuffix = '';
        if (labelOverride && labelOverride.includes('[')) {
            idxSuffix = labelOverride.substring(labelOverride.indexOf('['));
        }
        
        if (this.renderLabel) {
            const custom = this.renderLabel(node);
            if (custom) label = custom + idxSuffix;
        }

        const nodeWrapper = document.createElement('div');
        nodeWrapper.className = 'tree-node-wrapper virtual-row';
        nodeWrapper.style.position = 'absolute';
        nodeWrapper.style.top = `${index * this.rowHeight}px`;
        nodeWrapper.style.left = '0';
        nodeWrapper.style.width = '100%';
        nodeWrapper.style.height = `${this.rowHeight}px`;
        nodeWrapper.style.paddingLeft = `${level * 20}px`;
        nodeWrapper.style.display = 'flex';
        nodeWrapper.style.alignItems = 'center';

        const nodeEl = document.createElement('div');
        nodeEl.className = 'tree-node card-style';
        nodeEl.dataset.id = node.id;

        if (this.state.selectedNodeId === node.id) {
            nodeEl.classList.add('selected');
        }

        const expander = document.createElement('span');
        expander.className = 'node-expander';
        const hasChildren = node.lazy || (node.children && node.children.length > 0);

        if (hasChildren) {
            expander.textContent = this.state.expandedNodes.has(node.id) ? '▼' : '▶';
            expander.style.cursor = 'pointer';
            expander.onclick = (e) => {
                e.stopPropagation();
                this.toggleExpand(node.id);
            };
        } else {
            expander.innerHTML = '<span class="node-dot"></span>';
        }
        nodeEl.appendChild(expander);

        // --- Enhance Label with Attributes (Smart Labeling) ---
        let enhancedLabel = label;
        if (node.type === 'element' && node.children) {
            let id = '';
            let classes = '';
            let extra = '';

            for (const child of node.children) {
                if (child.type === 'property') {
                    const key = child.key.toLowerCase();
                    // Handle both Rust (@) and manual (no @) formats
                    const cleanKey = key.startsWith('@') ? key.slice(1) : key;
                    
                    if (cleanKey === 'id' && child.value) {
                        id = `#${child.value}`;
                    } else if (cleanKey === 'class' && child.value) {
                        const cls = String(child.value).trim().split(/\s+/).filter(x => x).join('.');
                        if (cls) classes = `.${cls}`;
                    } else if (['src', 'href', 'name', 'type'].includes(cleanKey) && child.value) {
                        if (!id && !classes) extra += `[${cleanKey}=${child.value}]`;
                    }
                }
            }
            
            // Insert attributes before the [0] index suffix if present
            if (id || classes || extra) {
                const idxStart = label.indexOf('[');
                if (idxStart !== -1) {
                    const tagPart = label.substring(0, idxStart);
                    const idxPart = label.substring(idxStart);
                    enhancedLabel = `${tagPart}${id}${classes}${extra}${idxPart}`;
                } else {
                    enhancedLabel = `${label}${id}${classes}${extra}`;
                }
            }
        }

        const keySpan = document.createElement('span');
        keySpan.className = `node-key node-type-${node.type}`;
        keySpan.textContent = enhancedLabel;
        keySpan.dataset.field = 'key';
        nodeEl.appendChild(keySpan);

        if (node.value !== undefined && node.value !== null && String(node.value).trim() !== "") {
            const sep = document.createElement('span');
            sep.className = 'node-separator';
            sep.textContent = ': ';
            nodeEl.appendChild(sep);

            const valSpan = document.createElement('span');
            valSpan.className = 'node-value';
            valSpan.textContent = String(node.value);
            valSpan.dataset.field = 'value';
            nodeEl.appendChild(valSpan);
        }

        if (!this.state.expandedNodes.has(node.id) && hasChildren) {
            const meta = document.createElement('span');
            meta.className = 'node-meta';
            meta.textContent = ` [${node.children.length}]`;
            nodeEl.appendChild(meta);
        }

        nodeWrapper.appendChild(nodeEl);
        parentElement.appendChild(nodeWrapper);
    }

    renderBreadcrumbs(container) {
        if (!this.state.selectedNodeId) {
            container.textContent = 'Select a node';
            return;
        }

        const path = this.getNodePath(this.model, this.state.selectedNodeId);
        container.innerHTML = '';
        if (!path) return;

        path.forEach((node, index) => {
            const span = document.createElement('span');
            span.className = 'breadcrumb-item';
            span.textContent = node.key || (node.type === 'root' ? 'Root' : 'Item');
            span.onclick = () => {
                this.state.selectedNodeId = node.id;
                this.render(); // Re-render to highlight
                // Scroll to item
                setTimeout(() => {
                    const el = this.elements.root.querySelector(`[data-id="${node.id}"]`);
                    if (el) el.scrollIntoView({ block: 'nearest' });
                }, 0);
            };
            container.appendChild(span);

            if (index < path.length - 1) {
                const sep = document.createElement('span');
                sep.className = 'breadcrumb-separator';
                sep.textContent = ' > ';
                container.appendChild(sep);
            }
        });
    }

    getNodePath(root, targetId, currentPath = []) {
        if (root.id === targetId) return [...currentPath, root];

        if (root.children) {
            for (const child of root.children) {
                const path = this.getNodePath(child, targetId, [...currentPath, root]);
                if (path) return path;
            }
        }
        return null;
    }

    // Old recursive render removed in favor of virtual rendering

    // --- Interaction ---

    toggleExpand(nodeId) {
        // UI Feedback: Loading
        const nodeEl = this.elements.list.querySelector(`.tree-node[data-id="${nodeId}"]`);
        if (nodeEl) {
            const expander = nodeEl.querySelector('.node-expander');
            if (expander) expander.classList.add('loading');
        }
        if (document.body) document.body.style.cursor = 'wait';

        // Async execution to allow UI repaint
        requestAnimationFrame(() => {
            setTimeout(async () => {
                try {
                    if (this.state.expandedNodes.has(nodeId)) {
                        this.state.expandedNodes.delete(nodeId);
                    } else {
                        const node = this.findNodeInternal(this.model, nodeId);
                        if (node && node.lazy && this.options.onLazyLoad) {
                            await this.options.onLazyLoad(node);
                        }
                        this.state.expandedNodes.add(nodeId);
                    }
                    this.render();
                } catch (e) {
                    console.error('Error toggling node:', e);
                } finally {
                    if (document.body) document.body.style.cursor = '';
                }
            }, 10);
        });
    }

    handleClick(e) {
        const nodeEl = e.target.closest('.tree-node');
        if (!nodeEl) return;

        let id = nodeEl.dataset.id;

        if (id) {
            this.state.selectedNodeId = id;
            this.render();

            if (this.onSelectionChange) {
                const node = this.findNodeInternal(this.model, id);
                if (node) {
                    // Leaf Logic:
                    // Only pass PARENT to Source View if the node is a Property (Attribute/Key-Value) or Text.
                    // Elements, Objects, Arrays should display themselves even if empty or simplified.
                    const hasChildren = node.lazy || (node.children && node.children.length > 0);
                    const isComponent = (node.type !== 'property' && node.type !== 'text');

                    if (!hasChildren && !isComponent) {
                        const parent = this.findParentInternal(this.model, id);
                        if (parent) {
                            this.onSelectionChange(parent);
                            return;
                        }
                    }
                    this.onSelectionChange(node);
                }
            }
        }
    }

    handleDoubleClick(e) {
        const nodeEl = e.target.closest('.tree-node');
        if (!nodeEl) return;

        const fieldEl = e.target.closest('.node-key, .node-value');
        if (!fieldEl) return; // Clicked on padding/expander

        const nodeId = nodeEl.dataset.id;
        const field = fieldEl.dataset.field; // 'key' or 'value'

        this.startEditing(nodeId, field, fieldEl);
    }

    startEditing(nodeId, field, element) {
        // Simple prompt for now, replace with inline input later if needed
        const currentText = element.textContent;
        // In Component Architecture, avoid `prompt` if possible, but for MVP it's safest purely for logic check.
        // Let's use specific input replacement.

        element.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentText;
        input.className = 'node-inline-editor';
        input.style.width = Math.max(100, currentText.length * 8) + 'px';

        input.onblur = () => this.finishEditing(nodeId, field, input.value, currentText);
        input.onkeydown = (e) => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') {
                input.value = currentText; // Revert
                input.blur();
            }
        };

        element.appendChild(input);
        input.focus();
    }

    finishEditing(nodeId, field, newValue, oldValue) {
        if (newValue === oldValue) {
            this.render(); // Just restore text
            if (this.elements.root) this.elements.root.focus();
            return;
        }

        this.saveState();

        // Find node in model (BFS or DFS)
        const node = this.findNodeInternal(this.model, nodeId);
        if (node) {
            if (field === 'key') node.key = newValue;
            if (field === 'value') node.value = newValue;

            // Notify Update
            if (this.onUpdate) this.onUpdate(this.model);
        }
        this.render();
        // Return focus to tree
        if (this.elements.root) this.elements.root.focus();
    }

    handleKeyDown(e) {
        // If editing (Input focused), ignore navigation keys so text can be edited
        if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            this.navigateSelection(e.key === 'ArrowUp' ? -1 : 1);
        }
        if (e.key === 'PageDown' || e.key === 'PageUp') {
            e.preventDefault();
            const pageSize = Math.max(1, Math.floor(this.elements.viewport.clientHeight / this.rowHeight) - 1);
            this.navigateSelection(e.key === 'PageUp' ? -pageSize : pageSize);
        }
        if (e.key === 'ArrowRight') {
            e.preventDefault(); // Stop default focus shift
            e.stopImmediatePropagation(); // Aggressively stop others
            if (this.state.selectedNodeId) {
                const node = this.findNodeInternal(this.model, this.state.selectedNodeId);
                if (node && node.children && node.children.length > 0 && !this.state.expandedNodes.has(node.id)) {
                    this.toggleExpand(node.id);
                }
            }
        }
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (this.state.selectedNodeId) {
                const node = this.findNodeInternal(this.model, this.state.selectedNodeId);
                if (node && this.state.expandedNodes.has(node.id)) {
                    this.toggleExpand(node.id);
                } else if (node) {
                    // Go to parent?
                    const parent = this.findParentInternal(this.model, node.id);
                    if (parent) {
                        this.state.selectedNodeId = parent.id;
                        this.render();
                        // Sync with Editor logic?
                        // If we change selection programmatically here, we should trigger onSelectionChange too?
                        // Current ArrowDown/Up calls navigateSelection which triggers it.
                        // Let's add trigger here for consistency if needed, but standard tree behavior usually just collapses.
                        // If already collapsed, move to parent.
                    }
                }
            }
        }
        if (e.key === 'F2') {
            e.preventDefault();
            if (this.state.selectedNodeId) {
                const node = this.findNodeInternal(this.model, this.state.selectedNodeId);
                if (node) {
                    // Find the DOM element for the value
                    const nodeEl = this.elements.root.querySelector(`[data-id="${node.id}"]`);
                    if (nodeEl) {
                        const valueEl = nodeEl.querySelector('.node-value');
                        if (valueEl) {
                            this.startEditing(node.id, 'value', valueEl);
                        } else {
                            // If no value element (e.g. object parent), maybe edit key?
                            // User asked for "start editing value at leaf node".
                            // If no value, maybe do nothing or edit key.
                            // Let's try key if value not present for flexibility, or stick to user req.
                            // "Leaf node" implies it has value.
                        }
                    }
                }
            }
        }
    }

    navigateSelection(direction) {
        // Walk the list the user actually SEES. render() builds it via
        // flattenVisibleNodes, which folds a node whose only child is text into
        // a leaf — a raw model walk would step onto those hidden text nodes and
        // the selection would appear to freeze for a keypress.
        const visibleNodes = (Array.isArray(this.visibleNodes) && this.visibleNodes.length > 0)
            ? this.visibleNodes.map((v) => v.node.id)
            : [];
        if (visibleNodes.length === 0) {
            const traverse = (n) => {
                visibleNodes.push(n.id);
                if (n.children && n.children.length > 0 && this.state.expandedNodes.has(n.id)) {
                    n.children.forEach(traverse);
                }
            };
            traverse(this.model);
        }

        const currentIndex = visibleNodes.indexOf(this.state.selectedNodeId);
        // Nothing selected yet (currentIndex === -1): start at the top rather
        // than jumping `direction` rows past it.
        let newIndex = currentIndex < 0 ? 0 : currentIndex + direction;
        // PageUp/PageDown near the ends should land on the first/last row
        // instead of doing nothing.
        if (currentIndex >= 0 && Math.abs(direction) > 1) {
            newIndex = Math.max(0, Math.min(visibleNodes.length - 1, newIndex));
        }

        if (newIndex >= 0 && newIndex < visibleNodes.length) {
            this.state.selectedNodeId = visibleNodes[newIndex];
            // Keep the row on screen BEFORE re-rendering: the list is
            // virtualized, so a row outside the scrolled range isn't in the DOM
            // at all and scrollIntoView() on it silently did nothing — pressing
            // ↓ past the bottom of the viewport looked like the keys had
            // stopped working.
            const vp = this.elements.viewport;
            if (vp) {
                const top = newIndex * this.rowHeight;
                const bottom = top + this.rowHeight;
                if (top < vp.scrollTop) {
                    vp.scrollTop = top;
                } else if (bottom > vp.scrollTop + vp.clientHeight) {
                    vp.scrollTop = bottom - vp.clientHeight;
                }
            }
            this.render();

            // Trigger Selection Change with same logic
            if (this.onSelectionChange) {
                const node = this.findNodeInternal(this.model, this.state.selectedNodeId);
                if (node) {
                    const hasChildren = node.lazy || (node.children && node.children.length > 0);
                    if (!hasChildren) {
                        const parent = this.findParentInternal(this.model, this.state.selectedNodeId);
                        if (parent) {
                            this.onSelectionChange(parent);
                            return;
                        }
                    }
                    this.onSelectionChange(node);
                }
            }
        }
    }

    // --- Clipboard ---

    async copy() {
        const activeInput = document.activeElement;
        if (activeInput && (activeInput.tagName === 'INPUT' || activeInput.tagName === 'TEXTAREA')) {
            const text = activeInput.value.substring(activeInput.selectionStart, activeInput.selectionEnd);
            if (text) {
                await writeText(text);
                return;
            }
        }

        if (!this.state.selectedNodeId) return;
        const node = this.findNodeInternal(this.model, this.state.selectedNodeId);
        if (node) {
            const cleanNode = this.simplifyNode(node);
            const text = typeof cleanNode === 'object' ? JSON.stringify(cleanNode, null, 2) : String(cleanNode);
            await writeText(text);
        }
    }

    async cut() {
        // Not implemented for Structure yet (Complex to cut tree nodes safely without parent ref in this context easily)
        // Or we just copy and delete?
        // Let's just Copy for now to verify.
        await this.copy();
    }

    async paste() {
        // Not implemented for Structure yet
        // Would need to parse clipboard text and insert as child?
    }

    simplifyNode(node) {
        // Recursively strip internal fields
        const obj = {};
        if (node.type === 'property' || node.type === 'text') {
            return node.value;
        }
        // If it's an element/object
        // This is tricky as our model is generic.
        // Let's just return the raw node structure for now? 
        // Or better, let's return the key/value pair?
        return { [node.key]: node.value || (node.children ? node.children.map(c => this.simplifyNode(c)) : null) };
    }

    findNodeInternal(root, id) {
        if (root.id === id) return root;
        if (root.children) {
            for (const child of root.children) {
                const found = this.findNodeInternal(child, id);
                if (found) return found;
            }
        }
        return null;
    }

    findParentInternal(root, childId) {
        if (!root.children) return null;
        for (const child of root.children) {
            if (child.id === childId) return root;
            const found = this.findParentInternal(child, childId);
            if (found) return found;
        }
        return null;
    }
}
