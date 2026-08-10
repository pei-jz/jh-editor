/**
 * HoverWidget.js — Display LSP hover information (types, docs).
 */

export class HoverWidget {
    constructor() {
        this.element = null;
        this.visible = false;
    }

    render() {
        if (!this.element) {
            this.element = document.createElement('div');
            this.element.className = 'lsp-hover-widget';
            this.element.style.display = 'none';
            document.body.appendChild(this.element);
        }
    }

    show(content, x, y) {
        if (!content) {
            this.hide();
            return;
        }

        this.render();
        this.visible = true;

        // Content can be string or { kind: string, value: string } or Array
        let html = '';
        if (typeof content === 'string') {
            html = this._formatMarkdown(content);
        } else if (content.contents) {
            const contents = Array.isArray(content.contents) ? content.contents : [content.contents];
            html = contents.map(c => {
                const value = typeof c === 'string' ? c : (c.value || '');
                return this._formatMarkdown(value);
            }).join('<hr/>');
        }

        this.element.innerHTML = html;
        this.element.style.left = `${x}px`;
        this.element.style.top = `${y + 20}px`;
        this.element.style.display = 'block';

        // Constrain to viewport
        const rect = this.element.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.element.style.left = `${window.innerWidth - rect.width - 20}px`;
        }
        if (rect.bottom > window.innerHeight) {
            this.element.style.top = `${y - rect.height - 10}px`;
        }
    }

    hide() {
        if (this.element) {
            this.element.style.display = 'none';
            this.visible = false;
        }
    }

    _formatMarkdown(text) {
        // Simple markdown formatter for common LSP hover content
        if (!text) return '';
        
        // Use marked if available, otherwise fallback to simple regex
        if (window.marked) {
            return window.marked.parse(text);
        }

        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br/>');
    }

    destroy() {
        if (this.element) {
            this.element.remove();
            this.element = null;
        }
    }
}
