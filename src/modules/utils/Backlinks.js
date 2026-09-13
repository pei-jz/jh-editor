/**
 * Backlinks.js — the search pattern for "which notes link to this one".
 *
 * The first version matched `[[Name]]` only. A Markdown tree is mostly linked
 * the ordinary way — `[notices](./THIRD-PARTY-NOTICES.md)` — so a file linked
 * from half the repository reported no backlinks at all.
 *
 * The pattern is compiled by BOTH engines: Rust's `regex` crate runs the
 * workspace grep, and the results tab re-runs it in JS to mark the hit. Keep it
 * to the syntax they share — no lookbehind, no named groups.
 */

const MD_EXT = /\.(md|markdown|mdx)$/i;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} path  the document the backlinks are for
 * @returns {{ label: string, pattern: string, globs: string } | null}
 */
export function backlinkQuery(path) {
    const fileName = String(path || '').split(/[\\/]/).pop();
    if (!fileName) return null;
    const extMatch = fileName.match(MD_EXT);
    const ext = extMatch ? extMatch[0] : '';
    const stem = ext ? fileName.slice(0, -ext.length) : fileName;
    if (!stem) return null;

    // A space in a link target is written literally, or as %20.
    const name = escapeRe(stem).replace(/ /g, '(?: |%20)');
    const extRe = escapeRe(ext);
    // Any folder in front — `./`, `../docs/`, `C:\notes\` — but the name must
    // start right after a separator, so `MY-NOTES.md` is not a link to `NOTES.md`.
    const dirs = (chars) => `(?:[^${chars}]*[/\\\\])?`;

    const alternatives = [
        // [[Name]]  [[Name.md]]  [[folder/Name|label]]  [[Name#heading]]
        `\\[\\[${dirs('\\]|#\\n')}${name}(?:${extRe})?\\s*[|#\\]]`,
        // [text](Name.md)  [text](./docs/Name.md#part)  [text](<Name.md> "title")
        `\\]\\(\\s*<?${dirs('()\\s<>')}${name}${extRe}(?:#[^()\\s<>]*)?>?(?:\\s|\\))`,
        // [ref]: docs/Name.md
        `^\\s*\\[[^\\]]+\\]:\\s*<?${dirs('\\s<>')}${name}${extRe}(?:#\\S*)?>?(?:\\s|$)`,
    ];
    // Without an extension there is nothing for the two Markdown-link forms to
    // anchor on, and `](Name)` would match far too much — wiki links only.
    const pattern = ext ? alternatives.join('|') : alternatives[0];

    return {
        label: fileName,
        pattern,
        globs: '*.md, *.markdown, *.mdx',
    };
}
