import { highlightTree, classHighlighter } from '@lezer/highlight';

// Language imports
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { java } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { yaml } from '@codemirror/lang-yaml';
import { svelte } from '@replit/codemirror-lang-svelte';

/**
 * Map of file extensions to CodeMirror language factories.
 * Each factory returns a LanguageSupport instance.
 */
const LANG_MAP = {
    js:   () => javascript(),
    jsx:  () => javascript({ jsx: true }),
    mjs:  () => javascript(),
    cjs:  () => javascript(),
    ts:   () => javascript({ typescript: true }),
    tsx:  () => javascript({ jsx: true, typescript: true }),
    html: () => html(),
    htm:  () => html(),
    css:  () => css(),
    scss: () => css(),
    less: () => css(),
    json: () => json(),
    java: () => java(),
    py:   () => python(),
    md:   () => markdown(),
    sql:  () => sql(),
    c:    () => cpp(),
    cpp:  () => cpp(),
    h:    () => cpp(),
    hpp:  () => cpp(),
    rs:   () => rust(),
    yaml: () => yaml(),
    yml:  () => yaml(),
    svelte: () => svelte(),
    xml:  () => xml(),
    xsd:  () => xml(),
    wsdl: () => xml(),
};

function getLangSupport(ext) {
    const factory = LANG_MAP[ext];
    if (!factory) return null;
    try {
        return factory();
    } catch (e) {
        return null;
    }
}

/**
 * Highlight code using CodeMirror's Lezer parser + highlightTree with the
 * standard `classHighlighter`, which emits stable `tok-*` CSS classes (styled
 * in editor.css under `.stf__page .tok-*` for BookMode).
 *
 * Returns an HTML string. Note: `highlightTree(tree, highlighter, putStyle)`
 * takes a Highlighter as its 2nd arg and a (from, to, classes) callback as its
 * 3rd — passing a `{ enter }` walker object there throws
 * "highlighter.style is not a function" and silently disables highlighting.
 */
export function highlightCode(code, langExt) {
    const ext = (langExt || '').toLowerCase();
    const langSupport = getLangSupport(ext);
    if (!langSupport) {
        return escapeHtml(code);
    }

    const tree = langSupport.language.parser.parse(code);

    let result = '';
    let pos = 0;

    highlightTree(tree, classHighlighter, (from, to, classes) => {
        if (from > pos) {
            result += escapeHtml(code.slice(pos, from));
        }
        result += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`;
        pos = to;
    });

    if (pos < code.length) {
        result += escapeHtml(code.slice(pos));
    }

    return result;
}

function escapeHtml(text) {
    return text.replace(/[&<>"']/g, function (m) {
        switch (m) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
        }
    });
}