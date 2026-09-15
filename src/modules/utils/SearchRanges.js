/**
 * SearchRanges.js — search hits as a sorted list, and how many to collect.
 *
 * A search over a large file can find hundreds of thousands of hits. Turning
 * every one into an editor decoration on every Find Next is what froze those
 * files, so the list stays a plain array sorted by position and only the hits
 * on screen are drawn. These are the lookups that makes cheap.
 *
 * Hits are `{ start, end }`, sorted by `start` and non-overlapping, so `end`
 * is sorted too.
 */

/** Terms this short match almost everywhere; collecting them is capped. */
export const SHORT_QUERY_LENGTH = 3;
export const SHORT_QUERY_MATCH_LIMIT = 20000;
/**
 * Longer terms are not capped for being long. This only stops a search that
 * matches most of a huge file from exhausting memory — a regular expression can
 * be long and still match every character.
 */
export const SAFETY_MATCH_LIMIT = 2000000;

/** How many hits to collect for `query` before stopping. */
export function searchMatchLimit(query) {
    return String(query || '').length <= SHORT_QUERY_LENGTH ? SHORT_QUERY_MATCH_LIMIT : SAFETY_MATCH_LIMIT;
}

/** Index of the first hit that ends after `pos` (so it may still be visible). */
export function firstMatchEndingAfter(matches, pos) {
    let lo = 0;
    let hi = matches.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (matches[mid].end <= pos) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Index of the first hit starting at or after `pos`, or -1 when there is none. */
export function firstMatchAtOrAfter(matches, pos) {
    let lo = 0;
    let hi = matches.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (matches[mid].start < pos) lo = mid + 1;
        else hi = mid;
    }
    return lo < matches.length ? lo : -1;
}
