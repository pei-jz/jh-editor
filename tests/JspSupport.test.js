import { describe, it, expect } from 'vitest';
import { isJspContent, extractJsp, restoreJspInTree } from '../src/modules/utils/JspSupport.js';

const SENT = String.fromCharCode(0xE000);

describe('JspSupport — detection', () => {
    it('detects .jsp by extension', () => {
        expect(isJspContent('/w/page.JSP', 'html', '<html/>')).toBe(true);
    });

    it('detects JSP syntax inside a .html file', () => {
        expect(isJspContent('/w/page.html', 'html', '<% x %>')).toBe(true);
    });

    it('is inert for plain html and other formats', () => {
        expect(isJspContent('/w/page.html', 'html', '<div/>')).toBe(false);
        expect(isJspContent('/w/page.jsp', 'xml', '<% x %>')).toBe(false);
        expect(isJspContent('/w/a.html', 'html', null)).toBe(false);
    });
});

describe('JspSupport — extract / restore', () => {
    const jsp = [
        '<%@ page contentType="text/html" %>',
        '<html><body>',
        '<% if (u != null) { %>',
        '  <p>Hi <%= u.getName() %></p>',
        '<% } %>',
        '<%-- a comment --%>',
        '</body></html>',
    ].join('\n');

    it('removes every JSP block from the text handed to the XML parser', () => {
        const { cleaned, blocks } = extractJsp(jsp);
        expect(cleaned).not.toContain('<%');
        expect(cleaned).not.toContain('%>');
        // directive, if-open, expression, if-close, comment
        expect(blocks).toHaveLength(5);
    });

    it('round-trips back to the exact original', () => {
        const { cleaned, blocks } = extractJsp(jsp);
        const node = { type: 'text', key: 'text', value: cleaned };
        restoreJspInTree(node, blocks);
        expect(node.value).toBe(jsp);
    });

    it('keeps a JSP comment intact rather than splitting it', () => {
        const { blocks } = extractJsp('<%-- c --%>');
        expect(blocks).toEqual(['<%-- c --%>']);
    });

    it('retags a restored text node as a directive so it is emitted raw', () => {
        const ex = extractJsp('<% code %>');
        const node = { type: 'text', key: 'text', value: ex.cleaned };
        restoreJspInTree(node, ex.blocks);
        expect(node.type).toBe('directive');
        expect(node.key).toBe('jsp');
    });

    it('restores attribute values without changing the node type', () => {
        const ex = extractJsp('<%= x %>');
        const node = { type: 'property', key: '@value', value: ex.cleaned };
        restoreJspInTree(node, ex.blocks);
        expect(node.value).toBe('<%= x %>');
        expect(node.type).toBe('property');
    });

    it('restores sentinels that appear in a node key', () => {
        const ex = extractJsp('<% k %>');
        const node = { type: 'element', key: `tag${ex.cleaned}`, value: '' };
        restoreJspInTree(node, ex.blocks);
        expect(node.key).toBe('tag<% k %>');
    });

    it('walks children recursively', () => {
        const ex = extractJsp('<% deep %>');
        const tree = {
            type: 'element', key: 'root', value: '',
            children: [{ type: 'element', key: 'a', value: '', children: [
                { type: 'text', key: 'text', value: ex.cleaned },
            ] }],
        };
        restoreJspInTree(tree, ex.blocks);
        expect(tree.children[0].children[0].value).toBe('<% deep %>');
    });

    it('drops a sentinel whose block is missing instead of crashing', () => {
        const node = { type: 'text', key: 'text', value: `x${SENT}99${SENT}y` };
        restoreJspInTree(node, []);
        expect(node.value).toBe('xy');
    });

    it('tolerates null / non-object nodes', () => {
        expect(() => restoreJspInTree(null, [])).not.toThrow();
        expect(() => restoreJspInTree('str', [])).not.toThrow();
    });

    it('leaves content without JSP untouched', () => {
        const { cleaned, blocks } = extractJsp('<html><body/></html>');
        expect(cleaned).toBe('<html><body/></html>');
        expect(blocks).toEqual([]);
    });
});
