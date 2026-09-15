import { describe, it, expect } from 'vitest';
import {
    searchMatchLimit, firstMatchEndingAfter, firstMatchAtOrAfter,
    SHORT_QUERY_MATCH_LIMIT, SAFETY_MATCH_LIMIT,
} from '../src/modules/utils/SearchRanges.js';

const hits = [
    { start: 5, end: 8 },
    { start: 10, end: 13 },
    { start: 20, end: 23 },
    { start: 40, end: 43 },
];

describe('searchMatchLimit', () => {
    it('caps only terms of three characters or fewer', () => {
        expect(searchMatchLimit('a')).toBe(SHORT_QUERY_MATCH_LIMIT);
        expect(searchMatchLimit('abc')).toBe(SHORT_QUERY_MATCH_LIMIT);
        expect(searchMatchLimit('abcd')).toBe(SAFETY_MATCH_LIMIT);
        expect(searchMatchLimit('')).toBe(SHORT_QUERY_MATCH_LIMIT);
    });

    it('lets a longer term collect far more than the old fixed 20,000', () => {
        expect(SAFETY_MATCH_LIMIT).toBeGreaterThan(1000000);
    });
});

describe('firstMatchEndingAfter (what is on screen)', () => {
    it('finds the first hit still visible from a position', () => {
        expect(firstMatchEndingAfter(hits, 0)).toBe(0);
        expect(firstMatchEndingAfter(hits, 8)).toBe(1);   // the first hit ends exactly there
        expect(firstMatchEndingAfter(hits, 11)).toBe(1);  // inside the second hit
        expect(firstMatchEndingAfter(hits, 100)).toBe(4); // past them all
    });

    it('handles no hits', () => {
        expect(firstMatchEndingAfter([], 3)).toBe(0);
    });
});

describe('firstMatchAtOrAfter (where a search starts)', () => {
    it('picks the next hit from the cursor, including one starting right there', () => {
        expect(firstMatchAtOrAfter(hits, 0)).toBe(0);
        expect(firstMatchAtOrAfter(hits, 10)).toBe(1);
        expect(firstMatchAtOrAfter(hits, 11)).toBe(2);
    });

    it('says there is none past the last hit, so the caller can wrap', () => {
        expect(firstMatchAtOrAfter(hits, 41)).toBe(-1);
        expect(firstMatchAtOrAfter([], 0)).toBe(-1);
    });
});
