/**
 * JspSupport.js
 *
 * The structure parsers (Rust quick_xml and the JS DOMParser fallback) are
 * XML/HTML parsers and choke badly on JSP-specific syntax such as
 *   <%@ page ... %>, <% scriptlet %>, <%= expr %>, <%! decl %>, <%-- comment --%>
 * A stray `<%` makes the tokenizer read a bogus element (e.g. `%@`, `%=`) that
 * never closes, so it swallows — and effectively drops — most of the document.
 *
 * To make the structure view robust we extract every JSP block *before* parsing
 * and replace it with a private-use sentinel token (safe inside text nodes and
 * attribute values alike). After the tree is built we walk it and restore the
 * original JSP text, retagging pure-JSP text nodes as `directive` so they are
 * emitted verbatim (not HTML-escaped) when the tree is stringified back.
 */

// Private Use Area char (U+E000) — will never appear in real HTML/JSP source.
const SENT = String.fromCharCode(0xE000);
// Matches a JSP comment first (so `<%--` isn't split as `<%` + `--`), then any
// other JSP block (directive / scriptlet / expression / declaration).
const JSP_BLOCK_RE = /<%--[\s\S]*?--%>|<%[\s\S]*?%>/g;
// Sentinel token: SENT + index + SENT
const SENT_RE = new RegExp(SENT + '(\\d+)' + SENT, 'g');

/** True when the content should go through JSP handling. */
export function isJspContent(filePath, type, content) {
    if (type !== 'html') return false;
    if (filePath && filePath.toLowerCase().endsWith('.jsp')) return true;
    return typeof content === 'string' && content.indexOf('<%') !== -1;
}

/**
 * Replace JSP blocks with sentinel tokens.
 * @returns {{ cleaned: string, blocks: string[] }}
 */
export function extractJsp(content) {
    const blocks = [];
    const cleaned = content.replace(JSP_BLOCK_RE, (m) => {
        blocks.push(m);
        return SENT + (blocks.length - 1) + SENT;
    });
    return { cleaned, blocks };
}

/**
 * Walk a parsed structure tree and restore the original JSP text in every
 * node value / key that carries a sentinel. Mutates the tree in place.
 */
export function restoreJspInTree(node, blocks) {
    if (!node || typeof node !== 'object') return;

    if (typeof node.value === 'string' && node.value.indexOf(SENT) !== -1) {
        node.value = _restore(node.value, blocks);
        // A text node that carried JSP must be emitted raw (JSP source, not
        // escaped HTML), so present it as a directive on stringify.
        if (node.type === 'text') {
            node.type = 'directive';
            node.key = 'jsp';
        }
    }
    if (typeof node.key === 'string' && node.key.indexOf(SENT) !== -1) {
        node.key = _restore(node.key, blocks);
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) restoreJspInTree(child, blocks);
    }
}

function _restore(str, blocks) {
    SENT_RE.lastIndex = 0;
    return str.replace(SENT_RE, (_, n) => {
        const b = blocks[+n];
        return b !== undefined ? b : '';
    });
}
