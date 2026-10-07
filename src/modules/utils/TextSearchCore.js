/**
 * TextSearchCore.js — find every hit of a search in one big string.
 *
 * This is what the search worker runs for large files. CodeMirror's own search
 * cursor walks the document line by line in JavaScript, and a single `next()`
 * over a 100 MB file with no hits never returns until it reaches the end — the
 * UI froze with no way out. Here the scan runs off the main thread on native
 * RegExp, in line-aligned chunks so progress can be reported between them, and
 * the worker can simply be terminated to cancel (which also stops a regular
 * expression that backtracks forever).
 *
 * The rules follow CodeMirror's SearchQuery so a file gives the same hits
 * whichever path searched it: the same RegExp flags, the same "could this
 * pattern cross a line" guess, and the same whole-word test.
 */

/** CodeMirror's guess at whether a pattern can match across a line break. */
const MULTILINE_HINT = /\\[sWDnr]|\n|\r|\[\^/;
const WORD_CHAR = /[\p{Alphabetic}\p{Number}_]/u;
/** Characters scanned between progress reports (rounded up to a line end). */
export const CHUNK_SIZE = 1 << 20;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The RegExp for a search; throws on an invalid pattern. */
export function buildSearchRegExp({ query, isRegex, caseSensitive }) {
    const source = isRegex ? query : escapeRegExp(query);
    return new RegExp(source, 'gmu' + (caseSensitive ? '' : 'i'));
}

function isWordAt(text, pos) {
    if (pos < 0 || pos >= text.length) return false;
    const cp = text.codePointAt(pos);
    return WORD_CHAR.test(String.fromCodePoint(cp));
}

function isWordBefore(text, pos) {
    if (pos <= 0) return false;
    let i = pos - 1;
    const c = text.charCodeAt(i);
    if (c >= 0xDC00 && c <= 0xDFFF && i > 0) i--;
    return isWordAt(text, i);
}

/** CodeMirror's whole-word rule: neither edge may sit inside a word. */
function wholeWordOk(text, from, to) {
    return (!isWordBefore(text, from) || !isWordAt(text, from))
        && (!isWordAt(text, to) || !isWordBefore(text, to));
}

/**
 * Walk every hit of the search in `text`, in order and non-overlapping.
 * `visit(from, to, match)` returns false to stop early.
 */
function scanMatches(text, opts, onProgress, visit) {
    const { query, isRegex, wholeWord } = opts;
    const re = buildSearchRegExp(opts);
    const wholeText = isRegex && MULTILINE_HINT.test(query);
    let count = 0;

    // Returns false once `visit` asks to stop.
    const scan = (subject, offset) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(subject)) !== null) {
            const from = offset + m.index;
            const to = from + m[0].length;
            if (m[0].length === 0) re.lastIndex++;
            if (wholeWord && !wholeWordOk(text, from, to)) {
                // Retry one character on, so a rejected hit doesn't hide a
                // valid one that overlaps it.
                re.lastIndex = m.index + 1;
                continue;
            }
            count++;
            if (visit(from, to, m) === false) return false;
            // The whole-text scan has no chunks to report between.
            if (wholeText && onProgress && (count & 4095) === 0) onProgress(to, count);
        }
        return true;
    };

    if (wholeText) {
        // Can cross lines, so it has to see the whole text at once.
        scan(text, 0);
    } else {
        // Hits never contain a line break, so line-aligned chunks lose nothing.
        let from = 0;
        while (from <= text.length) {
            let end = from + CHUNK_SIZE >= text.length ? -1 : text.indexOf('\n', from + CHUNK_SIZE);
            if (end === -1) end = text.length;
            if (!scan(text.slice(from, end), from)) break;
            from = end + 1;
            if (onProgress) onProgress(Math.min(from, text.length), count);
        }
    }
}

/**
 * Every hit of the search in `text`, in order and non-overlapping.
 *
 * @param {string} text
 * @param {{query: string, isRegex: boolean, caseSensitive: boolean,
 *          wholeWord: boolean, limit: number}} opts
 * @param {(scanned: number, count: number) => void} [onProgress]
 * @returns {{starts: Int32Array, ends: Int32Array, count: number, truncated: boolean}}
 */
export function findAllMatches(text, opts, onProgress) {
    const { limit = Infinity } = opts;
    const starts = [];
    const ends = [];
    let truncated = false;

    scanMatches(text, opts, onProgress, (from, to) => {
        starts.push(from);
        ends.push(to);
        if (starts.length >= limit) { truncated = true; return false; }
        return true;
    });

    return {
        starts: Int32Array.from(starts),
        ends: Int32Array.from(ends),
        count: starts.length,
        truncated,
    };
}

/**
 * The text that replaces one hit.
 *
 * Regex OFF: the replacement is taken literally, as the search side is.
 * Regex ON: \n \r \t \\ are interpreted, then $1 / $& / $$ resolve against
 * the match's groups.
 */
export function expandReplacement(replaceWith, groups, isRegex) {
    const repl = String(replaceWith || '');
    if (!isRegex) return repl;
    let out = repl.replace(/\\([nrt\\])/g,
        (_, ch) => ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : '\\');
    if (groups) {
        out = out.replace(/\$([$&]|\d+)/g,
            (m, i) => i === '&' ? (groups[0] ?? '') : i === '$' ? '$' : (groups[+i] ?? ''));
    }
    return out;
}

/**
 * Replace every hit, as ONE edit: the span from the first hit to the last,
 * rebuilt. CodeMirror applies 400k separate changes in seconds (and undoes
 * them as slowly); one span takes a fraction of that.
 *
 * `positions` (e.g. the selection's anchor and head) come back mapped into
 * the new text; one inside a replaced hit lands at the start of its
 * replacement.
 *
 * @returns {{count: number, from: number, to: number, insert: string,
 *            positions: number[]}} count 0 means nothing to change.
 */
export function replaceAllMatches(text, opts, replaceWith, positions = [], onProgress) {
    const parts = [];
    let first = -1;
    let prevEnd = 0;
    let count = 0;
    const delta = positions.map(() => 0);
    const mapped = positions.map(() => null);

    scanMatches(text, opts, onProgress, (from, to, m) => {
        if (first < 0) first = prevEnd = from;
        const insert = expandReplacement(replaceWith, m, opts.isRegex);
        parts.push(text.slice(prevEnd, from), insert);
        prevEnd = to;
        count++;
        const d = insert.length - (to - from);
        for (let i = 0; i < positions.length; i++) {
            if (mapped[i] != null) continue;
            const p = positions[i];
            if (to <= p) delta[i] += d;
            else if (from < p) mapped[i] = from + delta[i];
        }
        return true;
    });

    if (!count) return { count: 0, from: 0, to: 0, insert: '', positions: positions.slice() };
    return {
        count,
        from: first,
        to: prevEnd,
        insert: parts.join(''),
        positions: positions.map((p, i) => mapped[i] ?? p + delta[i]),
    };
}
