import { describe, expect, it } from 'vitest';
import { newSearchId } from '../src/modules/utils/SearchId.js';

describe('search ids', () => {
    it('are whole, exact numbers that never repeat', () => {
        const ids = Array.from({ length: 2000 }, newSearchId);
        expect(ids.every(Number.isSafeInteger)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
