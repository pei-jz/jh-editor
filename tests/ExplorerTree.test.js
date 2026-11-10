import { describe, expect, it } from 'vitest';
import { formatModified, typeAheadIndex } from '../src/modules/utils/ExplorerTree.js';
import { clampTerminalWidth } from '../src/modules/utils/TerminalPrefs.js';

const names = ['docs', 'dist', 'main.js', 'Makefile', 'readme.md'];

describe('typing in the tree', () => {
    it('finds the next name with that letter, ignoring case', () => {
        expect(typeAheadIndex(names, 'm', -1)).toBe(2);
        expect(typeAheadIndex(names, 'M', 2)).toBe(3);
    });

    it('wraps past the end', () => {
        expect(typeAheadIndex(names, 'd', 3)).toBe(0);
    });

    it('steps through the matches when one letter is repeated', () => {
        expect(typeAheadIndex(names, 'dd', 0)).toBe(1);
    });

    it('keeps the current row while further letters still fit it', () => {
        expect(typeAheadIndex(names, 'ma', 2)).toBe(2);
        expect(typeAheadIndex(names, 'mak', 2)).toBe(3);
    });

    it('stays put when nothing matches', () => {
        expect(typeAheadIndex(names, 'z', 1)).toBe(-1);
        expect(typeAheadIndex([], 'a', -1)).toBe(-1);
    });
});

describe('row details', () => {
    it('writes nothing for a time the filesystem did not give', () => {
        expect(formatModified(0)).toBe('');
        expect(formatModified(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026/01/02 03:04');
    });
});

describe('terminal on the right', () => {
    it('leaves the editors room and stays usable', () => {
        expect(clampTerminalWidth(null, 1600)).toBe(480);
        expect(clampTerminalWidth(5000, 1600)).toBe(1320);
        expect(clampTerminalWidth(480, 480)).toBe(240);
    });
});
