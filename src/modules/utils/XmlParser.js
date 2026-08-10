
/**
 * XmlParser.js
 * Converts XML string <-> Generic Node Tree
 */

export class XmlParser {
    static parse(xmlString) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlString, "text/xml");

        // check for errors
        const parserError = xmlDoc.getElementsByTagName("parsererror");
        if (parserError.length > 0) {
            throw new Error("XML Parsing Error: " + parserError[0].textContent);
        }

        return this.domToNode(xmlDoc.documentElement);
    }

    static domToNode(domNode) {
        const node = {
            id: Math.random().toString(36).substr(2, 9),
            type: 'element',
            key: domNode.nodeName,
            value: null,
            children: [],
            expanded: true
        };

        // Attributes as "property" children
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
                        // Inline text value for the element if it's the only child?
                        // For StructureEditor simplicity, treat mixed content as children.
                        // Or if it's a leaf text, assign to parent value?

                        // Strategy: Add as text node
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

        // Simplification: If element has ONLY one child and it is text (or just blank spaces ignored)
        // Filter out empty text nodes first to be sure
        node.children = node.children.filter(c => !(c.type === 'text' && c.value.trim() === ''));

        if (node.children.length === 1 && node.children[0].type === 'text') {
            node.value = node.children[0].value;
            node.children = []; // Remove text child to make it a leaf
        }

        return node;
    }

    static stringify(rootNode) {
        // Recursive string builder
        return this.nodeToString(rootNode, 0);
    }

    static nodeToString(node, level) {
        const indent = '  '.repeat(level);

        if (node.type === 'text') {
            return `${indent}${this.escapeXml(node.value ? node.value.trim() : '')}`;
        }

        if (node.type === 'directive') {
            return `${indent}${node.value}`;
        }

        if (node.type === 'property') {
            // Properties are handled by parent element stringifier usually.
            // But if we iterate properties as children, we need to separate them.
            // Our generic tree has properties as CHILDREN.
            // So logic must be: parent iterates children, picks props for open tag, then others for body.
            return '';
        }

        // Element
        let attrs = '';
        const childrenNodes = [];

        if (node.children) {
            node.children.forEach(child => {
                if (child.type === 'property') {
                    const attrName = child.key.replace(/^@/, '');
                    attrs += ` ${attrName}="${this.escapeXml(child.value)}"`;
                } else {
                    childrenNodes.push(child);
                }
            });
        }

        let xml = `${indent}<${node.key}${attrs}`;

        if (childrenNodes.length > 0) {
            // If it's effectively a single text child (preventing multiline breaks for simple values)
            const hasOnlyText = childrenNodes.length === 1 && childrenNodes[0].type === 'text';
            
            if (hasOnlyText) {
                xml += `>${this.escapeXml(childrenNodes[0].value ? childrenNodes[0].value.trim() : '')}</${node.key}>`;
            } else {
                xml += `>\n`;
                childrenNodes.forEach((child, idx) => {
                    if (child.type === 'text') {
                        const trimmed = child.value ? child.value.trim() : '';
                        if (trimmed === '') return;
                        xml += `${indent}  ${this.escapeXml(trimmed)}\n`;
                    } else {
                        xml += this.nodeToString(child, level + 1);
                        xml += '\n';
                    }
                });
                xml += `${indent}</${node.key}>`;
            }
        } else if (node.value !== null && node.value !== undefined && node.value !== '') {
            // Has non-empty value
            xml += `>${this.escapeXml(node.value.trim())}</${node.key}>`;
        } else {
            // Self closing or empty
            xml += ` />`;
        }

        return xml;
    }

    static escapeXml(unsafe) {
        if (unsafe === null || unsafe === undefined) return '';
        return unsafe.toString().replace(/[<>&'"]/g, function (c) {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
            }
        });
    }
}
