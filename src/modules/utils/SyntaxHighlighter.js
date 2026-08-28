/**
 * SyntaxHighlighter — the app-wide façade for "code to coloured HTML".
 *
 * This used to wrap shiki. It now wraps CMHighlighter, which uses the same
 * Lezer parsers the editor already loads, so there is one highlighting engine
 * in the app instead of two doing the same job.
 *
 * `init()` is kept and does nothing: highlighting is synchronous now, there is
 * no WebAssembly to fetch and no grammar to load, but several views still await
 * it before their first render.
 */

import { highlightCode, escapeHtml } from './CMHighlighter.js';

export const SyntaxHighlighter = {
    /** Nothing to warm up any more. Kept so existing callers still work. */
    async init() {
        return true;
    },

    /**
     * @param {string} code
     * @param {string} lang  file extension or Markdown fence tag
     * @returns {string} HTML with `tok-*` classes, styled per theme in editor.css
     */
    highlight(code, lang) {
        return highlightCode(code, lang);
    },

    escapeHtml,
};
