/**
 * A table cell's Markdown as what it says, for copying out of the app.
 *
 * A spreadsheet has no idea what `**` means, so a copied cell has to carry the
 * bold itself. This reads only the inline marks a table cell can hold. Anything
 * else stays as written, including raw HTML, which goes to the clipboard
 * escaped: a line break is the one tag a cell needs, and the only one let through.
 */

const escapeHtml = (text) => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const tag = (name, style) => (inner) => `<${name}${style ? ` style="${style}"` : ''}>${inner}</${name}>`;

// A delimiter hugging a space is not a mark, so "2 * 3 * 4" stays arithmetic.
// `_` also has to sit outside a word, so snake_case_name stays a name.
const MARKS = [
    { re: /^\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/, wrap: tag('b') },
    { re: /^__(?!\s)([\s\S]+?)(?<!\s)__(?![\p{L}\p{N}])/u, wrap: tag('b'), word: true },
    { re: /^~~(?!\s)([\s\S]+?)(?<!\s)~~/, wrap: tag('s') },
    { re: /^\*(?![\s*])([\s\S]+?)(?<![\s*])\*/, wrap: tag('i') },
    { re: /^_(?![\s_])([\s\S]+?)(?<![\s_])_(?![\p{L}\p{N}])/u, wrap: tag('i'), word: true },
];

const LINE_BREAK = /^<br\s*\/?>/i;
const LINK = /^(!?)\[((?:\\.|[^\]\\])*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/;
const CODE = /^(`+)([\s\S]+?)\1(?!`)/;
// Only a link that means something outside this document. A relative path
// would point nowhere in a spreadsheet.
const OPENABLE = /^(https?:|mailto:)/i;

function parse(source) {
    let html = '';
    let text = '';
    let i = 0;
    const take = (h, t) => { html += h; text += t; };

    while (i < source.length) {
        const rest = source.slice(i);
        const ch = rest[0];
        let m;

        if (ch === '\\' && /^\\[\\`*_{}[\]()#+\-.!|~]/.test(rest)) {
            take(escapeHtml(rest[1]), rest[1]);
            i += 2;
            continue;
        }
        if (ch === '`' && (m = rest.match(CODE))) {
            const code = m[2].trim() || m[2];
            take(tag('code', "font-family:Consolas,'Courier New',monospace;")(escapeHtml(code)), code);
            i += m[0].length;
            continue;
        }
        if (ch === '<' && (m = rest.match(LINE_BREAK))) {
            // Without this style Excel makes the rest of the cell a new row.
            take('<br style="mso-data-placement:same-cell;">', ' ');
            i += m[0].length;
            continue;
        }
        if ((ch === '[' || ch === '!') && (m = rest.match(LINK))) {
            const inner = parse(m[2]);
            const url = m[3];
            take(!m[1] && OPENABLE.test(url) ? `<a href="${escapeHtml(url)}">${inner.html}</a>` : inner.html, inner.text);
            i += m[0].length;
            continue;
        }
        if (ch === '*' || ch === '_' || ch === '~') {
            const before = i > 0 ? source[i - 1] : '';
            const mark = MARKS.find((k) => {
                if (k.word && /[\p{L}\p{N}]/u.test(before)) return false;
                return (m = rest.match(k.re));
            });
            if (mark) {
                const inner = parse(m[1]);
                take(mark.wrap(inner.html), inner.text);
                i += m[0].length;
                continue;
            }
        }
        take(escapeHtml(ch), ch);
        i += 1;
    }
    return { html, text };
}

/** The cell as HTML, with its marks as real formatting. */
export const inlineHtml = (source) => parse(String(source == null ? '' : source)).html;

/** The cell as plain text, without its marks. */
export const inlineText = (source) => parse(String(source == null ? '' : source)).text;
