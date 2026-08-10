
/**
 * HtmlParser.js
 * Converts HTML string <-> Generic Node Tree
 */

export class HtmlParser {
    static parse(htmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, "text/html");

        // DOMParser with text/html always creates <html><body> structure.
        // If the user provided a fragment, we might want to return just the body's contents
        // if the original didn't have <html> tag.

        const hasHtmlTag = /<html/i.test(htmlString);
        const hasBodyTag = /<body/i.test(htmlString);

        if (!hasHtmlTag && !hasBodyTag) {
            // Probably a fragment, root at body's first child or body itself?
            // Let's return a virtual root if multiple children, or the single child.
            const body = doc.body;
            if (body.childNodes.length === 1 && body.childNodes[0].nodeType === Node.ELEMENT_NODE) {
                return this.domToNode(body.childNodes[0]);
            }
            return this.domToNode(body);
        }

        return this.domToNode(doc.documentElement);
    }

    static domToNode(domNode) {
        const node = {
            id: Math.random().toString(36).substr(2, 9),
            type: 'element',
            key: domNode.nodeName.toLowerCase(),
            value: null,
            children: [],
            expanded: true
        };

        // Attributes
        if (domNode.attributes) {
            for (let i = 0; i < domNode.attributes.length; i++) {
                const attr = domNode.attributes[i];
                node.children.push({
                    id: Math.random().toString(36).substr(2, 9),
                    type: 'property',
                    key: `@${attr.name}`,
                    value: attr.value,
                    children: [],
                    expanded: false
                });
            }
        }

        // Child Nodes
        if (domNode.childNodes) {
            for (let i = 0; i < domNode.childNodes.length; i++) {
                const child = domNode.childNodes[i];
                if (child.nodeType === Node.ELEMENT_NODE) {
                    node.children.push(this.domToNode(child));
                } else if (child.nodeType === Node.TEXT_NODE) {
                    const text = child.textContent.trim();
                    if (text.length > 0) {
                        node.children.push({
                            id: Math.random().toString(36).substr(2, 9),
                            type: 'text',
                            key: '#text',
                            value: text,
                            children: [],
                            expanded: false
                        });
                    }
                }
            }
        }

        // Simplification: If element has ONLY one text child, merge it to value
        if (node.children.length === 1 && node.children[0].type === 'text') {
            node.value = node.children[0].value;
            node.children = [];
        }

        return node;
    }

    static stringify(rootNode) {
        // A synthetic "root"/"document" wrapper (produced when a file has
        // multiple top-level nodes, e.g. JSP directives before <html>) is not a
        // real element — emit its children directly instead of a <root> tag.
        if (rootNode && (rootNode.type === 'root' || rootNode.type === 'document') && Array.isArray(rootNode.children)) {
            return rootNode.children.map(c => this.nodeToString(c, 0)).join('\n');
        }
        return this.nodeToString(rootNode, 0);
    }

    static nodeToString(node, level) {
        const indent = '  '.repeat(level);

        if (node.type === 'text') {
            return `${indent}${this.escapeHtml(node.value)}`;
        }

        if (node.type === 'directive') {
            return `${indent}${node.value}`;
        }

        if (node.type === 'property') return '';

        let attrs = '';
        const childrenNodes = [];

        if (node.children) {
            node.children.forEach(child => {
                if (child.type === 'property') {
                    const attrName = child.key.replace(/^@/, '');
                    attrs += ` ${attrName}="${this.escapeHtml(child.value)}"`;
                } else {
                    childrenNodes.push(child);
                }
            });
        }

        const tagName = node.key;
        let html = `${indent}<${tagName}${attrs}`;

        // Self-closing tags (HTML5)
        const selfClosing = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];

        if (selfClosing.includes(tagName)) {
            html += '>';
            return html;
        }

        if (childrenNodes.length > 0) {
            html += `>\n`;
            childrenNodes.forEach(child => {
                html += this.nodeToString(child, level + 1) + '\n';
            });
            html += `${indent}</${tagName}>`;
        } else if (node.value !== null && node.value !== undefined && node.value !== '') {
            html += `>${this.escapeHtml(node.value)}</${tagName}>`;
        } else {
            html += `></${tagName}>`;
        }

        return html;
    }

    static escapeHtml(unsafe) {
        if (unsafe === null || unsafe === undefined) return '';
        return unsafe.toString().replace(/[&<>"']/g, m => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        })[m]);
    }
}
