/**
 * SearchId.js — the id that ties a running search's events to its results tab.
 *
 * Always a whole number. The id goes to the backend and comes back in every
 * event, where it is compared exactly, and serde_json can round a fraction when
 * reading it. About one id in nine built from Date.now() + Math.random() came
 * back different, so its tab ignored every event and stayed on "Searching…".
 *
 * Microseconds' worth of room per millisecond, so ids stay unique and inside
 * Number.MAX_SAFE_INTEGER.
 */
let last = 0;

export function newSearchId() {
    last = Math.max(last + 1, Date.now() * 1000);
    return last;
}
