import { describe, it, expect } from 'vitest';
import { HtmlParser } from '../src/modules/utils/HtmlParser.js';

describe('HtmlParser', () => {
    describe('parse', () => {
        it('should parse html fragment correctly', () => {
            const html = '<div class="test">hello <span>world</span></div>';
            const node = HtmlParser.parse(html);

            expect(node).toBeDefined();
            expect(node.type).toBe('element');
            expect(node.key).toBe('div');
            expect(node.children.length).toBe(3); // @class, #text, and span

            const classNode = node.children.find(c => c.key === '@class');
            expect(classNode.type).toBe('property');
            expect(classNode.value).toBe('test');

            const textNode = node.children.find(c => c.key === '#text');
            expect(textNode.type).toBe('text');
            expect(textNode.value).toBe('hello');

            const spanNode = node.children.find(c => c.key === 'span');
            expect(spanNode.type).toBe('element');
            expect(spanNode.value).toBe('world');
        });

        it('should parse full html page correctly', () => {
            const html = '<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
            const node = HtmlParser.parse(html);

            expect(node.key).toBe('html');
            const bodyNode = node.children.find(c => c.key === 'body');
            expect(bodyNode).toBeDefined();
            expect(bodyNode.children[0].key).toBe('h1');
            expect(bodyNode.children[0].value).toBe('Hello');
        });

        it('should handle HTML fragments with multiple root child nodes by returning body node', () => {
            const html = '<div>first</div><p>second</p>';
            const node = HtmlParser.parse(html);
            // Since it's a fragment with multiple elements, DOMParser wraps in <html><body>...
            // parse checks hasHtmlTag/hasBodyTag and returns body node
            expect(node.key).toBe('body');
            expect(node.children.length).toBe(2);
            expect(node.children[0].key).toBe('div');
            expect(node.children[0].value).toBe('first');
            expect(node.children[1].key).toBe('p');
            expect(node.children[1].value).toBe('second');
        });
    });

    describe('stringify', () => {
        it('should stringify a node tree back to HTML string', () => {
            const html = '<div id="container"><p>content</p></div>';
            const node = HtmlParser.parse(html);
            const stringified = HtmlParser.stringify(node);

            expect(stringified).toContain('<div id="container">');
            expect(stringified).toContain('  <p>content</p>');
            expect(stringified).toContain('</div>');
        });

        it('should stringify self-closing HTML5 tags correctly without closing tags', () => {
            const node = {
                type: 'element',
                key: 'img',
                value: null,
                children: [
                    { id: '1', type: 'property', key: '@src', value: 'logo.png' }
                ]
            };
            const stringified = HtmlParser.stringify(node);
            expect(stringified).toBe('<img src="logo.png">');
        });

        it('should stringify property nodes to empty string directly', () => {
            const node = {
                type: 'property',
                key: 'attr',
                value: 'val'
            };
            expect(HtmlParser.nodeToString(node, 0)).toBe('');
        });

        it('should stringify a text node element correctly', () => {
            const node = {
                type: 'text',
                key: '#text',
                value: 'plain text'
            };
            expect(HtmlParser.nodeToString(node, 0)).toBe('plain text');
        });
    });

    describe('escapeHtml', () => {
        it('should escape HTML characters correctly', () => {
            expect(HtmlParser.escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#039;');
            expect(HtmlParser.escapeHtml(null)).toBe('');
            expect(HtmlParser.escapeHtml(undefined)).toBe('');
        });
    });
});
