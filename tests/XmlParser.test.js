import { describe, it, expect } from 'vitest';
import { XmlParser } from '../src/modules/utils/XmlParser.js';

describe('XmlParser', () => {
    describe('parse', () => {
        it('should parse simple XML with text content', () => {
            const xml = '<root>hello</root>';
            const node = XmlParser.parse(xml);

            expect(node).toBeDefined();
            expect(node.type).toBe('element');
            expect(node.key).toBe('root');
            expect(node.value).toBe('hello');
            expect(node.children.length).toBe(0);
        });

        it('should parse XML with attributes', () => {
            const xml = '<root id="123" class="main">content</root>';
            const node = XmlParser.parse(xml);

            expect(node.key).toBe('root');
            expect(node.children.length).toBe(3); // id, class attributes and text content

            const idNode = node.children.find(c => c.key === '@id');
            expect(idNode.type).toBe('property');
            expect(idNode.value).toBe('123');

            const classNode = node.children.find(c => c.key === '@class');
            expect(classNode.type).toBe('property');
            expect(classNode.value).toBe('main');
        });

        it('should parse XML with child elements', () => {
            const xml = '<root><child id="1">item1</child><child id="2">item2</child></root>';
            const node = XmlParser.parse(xml);

            expect(node.children.length).toBe(2);
            expect(node.children[0].key).toBe('child');
            expect(node.children[0].children.length).toBe(2); // attribute + text node
            expect(node.children[0].value).toBeNull(); // attributes present, so text is a child text node
        });

        it('should throw an error for malformed XML', () => {
            expect(() => {
                XmlParser.parse('<root><child></root>');
            }).toThrow('XML Parsing Error');
        });

        it('should handle XML with comments or empty spaces', () => {
            const xml = `
                <root>
                    <!-- comment -->
                    <child>hello</child>
                </root>
            `;
            const node = XmlParser.parse(xml);
            expect(node.children.length).toBe(1);
            expect(node.children[0].key).toBe('child');
            expect(node.children[0].value).toBe('hello');
        });
    });

    describe('stringify', () => {
        it('should stringify a node tree back to XML string', () => {
            const xml = '<root attr="test"><child>hello</child></root>';
            const node = XmlParser.parse(xml);
            const stringified = XmlParser.stringify(node);

            expect(stringified).toContain('<root attr="test">');
            expect(stringified).toContain('  <child>hello</child>');
            expect(stringified).toContain('</root>');
        });

        it('should stringify a self-closing empty element node', () => {
            const node = {
                type: 'element',
                key: 'empty',
                value: null,
                children: []
            };
            const stringified = XmlParser.stringify(node);
            expect(stringified).toBe('<empty />');
        });

        it('should stringify node with property children ignored directly in nodeToString recursively (handled by parent)', () => {
            const node = {
                type: 'property',
                key: 'prop',
                value: 'val'
            };
            const stringified = XmlParser.nodeToString(node, 0);
            expect(stringified).toBe('');
        });

        it('should stringify a text node element correctly', () => {
            const node = {
                type: 'text',
                key: '#text',
                value: 'some text'
            };
            const stringified = XmlParser.nodeToString(node, 0);
            expect(stringified).toBe('some text');
        });
    });

    describe('escapeXml', () => {
        it('should escape xml special characters correctly', () => {
            expect(XmlParser.escapeXml('<>&\'"')).toBe('&lt;&gt;&amp;&apos;&quot;');
            expect(XmlParser.escapeXml(null)).toBe('');
            expect(XmlParser.escapeXml(undefined)).toBe('');
        });
    });
});
