/**
 * CMHighlighter.js — code to coloured HTML, using the editor's own parsers.
 *
 * The editor highlights itself with CodeMirror. Everything OUTSIDE an editor —
 * Markdown preview code fences, the diff panes, inline-AI results, BookMode's
 * printed pages — needs the same thing as an HTML string, and that used to be
 * a second, unrelated engine: shiki, a TextMate/WASM stack that shipped 6.8 MB
 * of grammars for languages nothing here ever asked for, and burned its colours
 * into `style="color:#…"` so the output could not follow the app's themes.
 *
 * Lezer already parses these languages for the editor. `highlightTree` walks
 * that same parse and hands back token ranges, which become `tok-*` classes —
 * styled from each theme's `--hl-*` tokens, so a code fence in the preview is
 * coloured like the editor beside it.
 */

import { highlightTree, classHighlighter } from '@lezer/highlight';
import { StreamLanguage } from '@codemirror/language';

// Languages the editor itself supports.
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

/* The rest come from @codemirror/legacy-modes — CodeMirror 5's stream parsers,
   wrapped for Lezer. They are plain JS, a few KB each, and they cover the
   languages that show up in a README or an AI answer and would otherwise have
   arrived as grey text: shells, Go, Ruby, and the config formats.

   PHP is the one language the old engine coloured and this does not: there is
   no Lezer or legacy mode for it here. A `php` fence renders as plain escaped
   text, which is the same thing the old engine did for any grammar it had not
   loaded — readable, just not coloured. A wrong grammar would be worse. */
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { go } from '@codemirror/legacy-modes/mode/go';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { csharp, kotlin, scala } from '@codemirror/legacy-modes/mode/clike';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { diff } from '@codemirror/legacy-modes/mode/diff';

const stream = (mode) => () => StreamLanguage.define(mode);

/**
 * Extension (or fence tag) to a language.
 *
 * Keyed by what people actually write: a Markdown fence says ```bash, a file is
 * called `main.go`, so both spellings land here.
 */
const LANG_MAP = {
    // JavaScript family
    js: () => javascript(),
    jsx: () => javascript({ jsx: true }),
    mjs: () => javascript(),
    cjs: () => javascript(),
    ts: () => javascript({ typescript: true }),
    tsx: () => javascript({ jsx: true, typescript: true }),
    javascript: () => javascript(),
    typescript: () => javascript({ typescript: true }),
    node: () => javascript(),

    // Web
    html: () => html(),
    htm: () => html(),
    vue: () => html(),          // close enough for a fence: template + script
    css: () => css(),
    scss: () => css(),
    less: () => css(),
    svelte: () => svelte(),

    // Data / config
    json: () => json(),
    jsonc: () => json(),
    xml: () => xml(),
    xsd: () => xml(),
    wsdl: () => xml(),
    svg: () => xml(),
    yaml: () => yaml(),
    yml: () => yaml(),
    toml: stream(toml),
    ini: stream(properties),
    properties: stream(properties),
    env: stream(properties),

    // Systems / compiled
    c: () => cpp(),
    h: () => cpp(),
    cpp: () => cpp(),
    cc: () => cpp(),
    hpp: () => cpp(),
    rs: () => rust(),
    rust: () => rust(),
    go: stream(go),
    java: () => java(),
    kt: stream(kotlin),
    kotlin: stream(kotlin),
    swift: stream(swift),
    scala: stream(scala),
    cs: stream(csharp),
    csharp: stream(csharp),

    // Scripting
    py: () => python(),
    python: () => python(),
    rb: stream(ruby),
    ruby: stream(ruby),
    lua: stream(lua),
    pl: stream(perl),
    perl: stream(perl),

    // Shells
    sh: stream(shell),
    bash: stream(shell),
    zsh: stream(shell),
    shell: stream(shell),
    console: stream(shell),
    ps1: stream(powerShell),
    powershell: stream(powerShell),

    // Everything else
    sql: () => sql(),
    md: () => markdown(),
    markdown: () => markdown(),
    dockerfile: stream(dockerFile),
    diff: stream(diff),
    patch: stream(diff),
};

/** Cached per language: building a LanguageSupport is not free. */
const cache = new Map();

function getLangSupport(ext) {
    if (cache.has(ext)) return cache.get(ext);
    const factory = LANG_MAP[ext];
    let support = null;
    if (factory) {
        try { support = factory(); } catch (e) { support = null; }
    }
    cache.set(ext, support);
    return support;
}

/** Languages this can colour — used by tests and by callers that want to check. */
export function supportedLanguages() {
    return Object.keys(LANG_MAP);
}

export function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (m) => {
        switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
        }
    });
}

/**
 * Highlight `code` as `langExt`, returning an HTML fragment.
 *
 * Unknown or missing language → the text, escaped. That is the same answer the
 * old engine gave for a grammar it had not loaded, and it is the right one:
 * plain text is readable, a wrong grammar is not.
 *
 * The output carries `tok-*` classes (from Lezer's standard `classHighlighter`)
 * rather than inline colours, which is what lets it follow the active theme.
 */
export function highlightCode(code, langExt) {
    const text = String(code == null ? '' : code);
    const ext = String(langExt || '').toLowerCase().replace(/^\./, '');
    const langSupport = getLangSupport(ext);
    if (!langSupport) return escapeHtml(text);

    let tree;
    try {
        // `lang-*` packages hand back a LanguageSupport, which wraps the
        // Language in `.language`; StreamLanguage.define() IS the Language.
        // Reading only `.language` gave `undefined` for every stream mode, so
        // bash, Go, TOML and friends silently fell through to plain text.
        const language = langSupport.language || langSupport;
        tree = language.parser.parse(text);
    } catch (e) {
        // A parser that chokes must not take the view down with it.
        return escapeHtml(text);
    }

    let result = '';
    let pos = 0;
    highlightTree(tree, classHighlighter, (from, to, classes) => {
        if (from > pos) result += escapeHtml(text.slice(pos, from));
        result += `<span class="${classes}">${escapeHtml(text.slice(from, to))}</span>`;
        pos = to;
    });
    if (pos < text.length) result += escapeHtml(text.slice(pos));
    return result;
}
