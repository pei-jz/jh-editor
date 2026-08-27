/**
 * LocalCompletion.js — ghost text with no model behind it.
 *
 * The AI path cannot be an inline completion engine on its own. A single-shot
 * agent task is a POST, a WebSocket subscribe and a round trip to a provider:
 * seconds, not the fraction of a second a suggestion has to arrive in to be
 * worth reading. By the time it lands the caret has usually moved, so the
 * answer is thrown away — after the request was already made and logged.
 *
 * Almost everything an inline completion is actually wanted for is already in
 * the buffer, though. Two engines, both instant and both entirely local:
 *
 *   • LINE  — the line you are typing shares a prefix with a line already in
 *     the file, so the rest of that line is the obvious continuation. This is
 *     what carries repetitive files: CSS custom properties, config, table-driven
 *     tests, long switch statements.
 *
 *   • WORD  — the token under the caret is the start of a word used elsewhere
 *     in the file. The classic editor completion, and the reason long
 *     identifiers are not painful to type.
 *
 * Both are pure functions over text, so they are testable without an editor,
 * and they cost nothing: no network, no model, and nothing leaves the machine.
 */

/** Don't scan an enormous buffer on every keystroke. */
const MAX_SCAN_LINES = 4000;

/** A line prefix shorter than this matches too much to be a suggestion. */
const MIN_LINE_PREFIX = 4;

/**
 * How much of a word has to be typed before it is completed.
 *
 * Three meant `im` offered nothing in a file full of `import`, which reads as
 * the feature being broken rather than being careful. Two is enough of a hint
 * to rank on, and a wrong guess costs a keystroke to ignore.
 */
const MIN_WORD_PREFIX = 2;

/** Anything longer is a paste, not a completion. */
const MAX_SUGGESTION_CHARS = 200;

/** The word characters this treats as one token — `-` and `$` included so CSS
 *  custom properties and shell/PHP variables complete as single words. */
const WORD_RE = /[A-Za-z0-9_$\-]+/g;

/** The part of the current word immediately before the caret. */
export function wordPrefixAt(lineText, column) {
    const upto = lineText.slice(0, column);
    const m = /[A-Za-z0-9_$\-]+$/.exec(upto);
    return m ? m[0] : '';
}

/**
 * Continue the current line from a line elsewhere in the file.
 *
 * Nearest match wins — in a run of similar lines the one just above is far more
 * likely to be the template than one three hundred lines away.
 *
 * @param {string[]} lines      every line of the document
 * @param {number} lineIndex    0-based index of the line being typed
 * @param {string} head         the current line's text up to the caret
 * @returns {string} the continuation, or '' when there is no useful one
 */
export function lineCompletion(lines, lineIndex, head) {
    if (head.trim().length < MIN_LINE_PREFIX) return '';

    const limit = Math.min(lines.length, MAX_SCAN_LINES);
    // Walk outwards from the caret: above first at each distance, because the
    // line you are copying is nearly always one you already wrote.
    for (let d = 1; d < limit; d++) {
        for (const i of [lineIndex - d, lineIndex + d]) {
            if (i < 0 || i >= lines.length) continue;
            const candidate = lines[i];
            if (candidate.length <= head.length) continue;
            if (!candidate.startsWith(head)) continue;
            const rest = candidate.slice(head.length);
            if (!rest.trim()) continue;                       // only trailing space
            if (rest.length > MAX_SUGGESTION_CHARS) continue;
            return rest;
        }
    }
    return '';
}

/**
 * Finish the word under the caret from a word used elsewhere in the file.
 *
 * Ranked by how close the other use is, then by how often the word appears:
 * a name used six times nearby beats one used once at the far end of the file.
 *
 * @param {string} text        the whole document
 * @param {string} prefix      the token before the caret
 * @param {number} caretOffset absolute position of the caret, for the distance
 * @returns {string} the remainder of the word, or ''
 */
export function wordCompletion(text, prefix, caretOffset = 0) {
    if (prefix.length < MIN_WORD_PREFIX) return '';

    const seen = new Map();   // word -> { count, nearest }
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text)) !== null) {
        const word = m[0];
        if (word.length <= prefix.length) continue;
        if (!word.startsWith(prefix)) continue;
        // The word being typed is itself in the text; skip that occurrence.
        if (m.index <= caretOffset && m.index + word.length >= caretOffset) continue;

        const distance = Math.abs(m.index - caretOffset);
        const entry = seen.get(word);
        if (entry) {
            entry.count += 1;
            entry.nearest = Math.min(entry.nearest, distance);
        } else {
            seen.set(word, { count: 1, nearest: distance });
        }
    }
    if (seen.size === 0) return '';

    let best = null;
    let bestScore = -Infinity;
    for (const [word, { count, nearest }] of seen) {
        // Distance dominates; frequency breaks ties between comparable ones.
        const score = count * 2 - Math.log10(nearest + 10) * 3;
        if (score > bestScore) { bestScore = score; best = word; }
    }
    return best ? best.slice(prefix.length) : '';
}

/**
 * The best local suggestion for where the caret is, or ''.
 *
 * @param {object} ctx
 * @param {string} ctx.text         whole document
 * @param {string} ctx.lineText     the current line
 * @param {number} ctx.lineIndex    0-based line number
 * @param {number} ctx.column       caret column within the line
 * @param {number} ctx.offset       absolute caret offset
 * @returns {{text: string, source: 'line'|'word'}|null}
 */
export function localSuggestion({ text, lineText, lineIndex, column, offset }) {
    // Never suggest in the middle of a word: the completion would be inserted
    // in front of characters that are already there.
    const after = lineText.slice(column);
    if (/^[A-Za-z0-9_$\-]/.test(after)) return null;

    const head = lineText.slice(0, column);
    if (!head.trim()) return null;   // nothing typed on this line yet

    const lines = text.split('\n');
    const line = lineCompletion(lines, lineIndex, head);
    if (line) return { text: line, source: 'line' };

    const word = wordCompletion(text, wordPrefixAt(lineText, column), offset);
    if (word) return { text: word, source: 'word' };

    return null;
}

export const _limits = {
    MAX_SCAN_LINES, MIN_LINE_PREFIX, MIN_WORD_PREFIX, MAX_SUGGESTION_CHARS,
};
