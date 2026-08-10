/**
 * CompletionWidget.js — Floating menu for LSP code completions.
 */

export class CompletionWidget {
    constructor(view) {
        this.view = view;
        this.element = null;
        this.items = [];
        this.selectedIndex = 0;
        this.visible = false;
        this.currentPosition = { line: 0, char: 0 };
    }

    render() {
        if (!this.element) {
            this.element = document.createElement('div');
            this.element.className = 'lsp-completion-widget';
            this.element.style.display = 'none';
            document.body.appendChild(this.element);

            // Handle selection
            this.element.addEventListener('mousedown', (e) => {
                const item = e.target.closest('.completion-item');
                if (item) {
                    this.selectedIndex = parseInt(item.dataset.index);
                    this.applySelection();
                }
                e.preventDefault();
                e.stopPropagation();
            });
        }
    }

    show(items, x, y, line, char) {
        if (!items || items.length === 0) {
            this.hide();
            return;
        }

        this.items = items.slice(0, 50); // Limit to 50 items
        this.selectedIndex = 0;
        this.currentPosition = { line, char };
        this.visible = true;

        this.renderItems();

        this.element.style.left = `${x}px`;
        this.element.style.top = `${y}px`;
        this.element.style.display = 'block';

        // Constrain to viewport
        const rect = this.element.getBoundingClientRect();
        if (rect.bottom > window.innerHeight) {
            this.element.style.top = `${y - rect.height - 20}px`;
        }
    }

    renderItems() {
        this.element.innerHTML = '';
        this.items.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = `completion-item ${index === this.selectedIndex ? 'selected' : ''}`;
            el.dataset.index = index;
            
            const label = typeof item === 'string' ? item : (item.label || '');
            const detail = item.detail ? `<span class="item-detail">${item.detail}</span>` : '';
            
            el.innerHTML = `<span class="item-label">${label}</span>${detail}`;
            this.element.appendChild(el);
            
            if (index === this.selectedIndex) {
                el.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    hide() {
        if (this.element) {
            this.element.style.display = 'none';
            this.visible = false;
        }
    }

    moveSelection(delta) {
        this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
        this.renderItems();
    }

    applySelection() {
        const item = this.items[this.selectedIndex];
        if (!item) return;

        const text = typeof item === 'string' ? item : (item.insertText || item.label);
        this.view.insertTextAtCursor(text, true); // true = replace current word fragment
        this.hide();
    }

    destroy() {
        if (this.element) {
            this.element.remove();
            this.element = null;
        }
    }
}
