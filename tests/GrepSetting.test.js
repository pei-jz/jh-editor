import { describe, it, expect, beforeEach } from 'vitest';
import {
    getGrepMaxMatches, setGrepMaxMatches, normalizeGrepMaxMatches,
    DEFAULT_GREP_MAX_MATCHES, MIN_GREP_MAX_MATCHES, MAX_GREP_MAX_MATCHES,
} from '../src/modules/utils/GrepSetting.js';

describe('the search result limit', () => {
    beforeEach(() => { localStorage.clear(); });

    it('defaults to what the constant used to be', () => {
        expect(DEFAULT_GREP_MAX_MATCHES).toBe(5000);
        expect(getGrepMaxMatches()).toBe(5000);
    });

    it('remembers a new value', () => {
        expect(setGrepMaxMatches(20000)).toBe(20000);
        expect(getGrepMaxMatches()).toBe(20000);
    });

    it('keeps to its range, and reads nothing entered as the default', () => {
        expect(normalizeGrepMaxMatches(1)).toBe(MIN_GREP_MAX_MATCHES);
        expect(normalizeGrepMaxMatches(1e9)).toBe(MAX_GREP_MAX_MATCHES);
        expect(normalizeGrepMaxMatches('')).toBe(DEFAULT_GREP_MAX_MATCHES);
        expect(normalizeGrepMaxMatches('  ')).toBe(DEFAULT_GREP_MAX_MATCHES);
        expect(normalizeGrepMaxMatches(null)).toBe(DEFAULT_GREP_MAX_MATCHES);
        expect(normalizeGrepMaxMatches('abc')).toBe(DEFAULT_GREP_MAX_MATCHES);
    });
});
