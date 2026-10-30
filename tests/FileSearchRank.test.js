import { describe, it, expect } from 'vitest';
import {
    fuzzyPositions, toRanges, scoreFile, prepareEntries, rankFiles,
    toRelPath, globToRegex, splitRelRanges,
} from '../src/modules/utils/FileSearchRank.js';

const WS = 'C:/proj';
const files = (...rels) => prepareEntries(
    rels.map((rel) => ({ entry: rel.split('/').pop(), path: `${WS}/${rel}` })), WS);
const order = (query, entries, opts) => rankFiles(query, entries, opts).map((r) => r.rel);
const file = (rel) => ({ name: rel.split('/').pop(), rel });

describe('fuzzyPositions', () => {
    it('finds the characters in order, not necessarily together', () => {
        expect(fuzzyPositions('fsm', 'filesearchmodal.js')).toEqual([0, 4, 10]);
    });

    it('is null when a character is missing or out of order', () => {
        expect(fuzzyPositions('xyz', 'filesearch')).toBeNull();
        expect(fuzzyPositions('ba', 'ab')).toBeNull();
    });

    // Greedy alone would light up the first `a` and leave a gap.
    it('prefers the tightest run that ends where the greedy match ended', () => {
        expect(fuzzyPositions('abc', 'a_x_abc')).toEqual([4, 5, 6]);
    });

    it('matches an empty query trivially', () => {
        expect(fuzzyPositions('', 'anything')).toEqual([]);
    });
});

describe('toRanges', () => {
    it('folds consecutive positions into [start, end) ranges', () => {
        expect(toRanges([0, 1, 2, 5, 7, 8])).toEqual([[0, 3], [5, 6], [7, 9]]);
    });
});

describe('scoreFile tiers', () => {
    const tier = (q, rel) => scoreFile(q, file(rel))?.kind ?? null;

    it('classifies each kind of match', () => {
        expect(tier('app.js', 'src/App.js')).toBe('exact');
        expect(tier('app', 'src/App.js')).toBe('prefix');
        expect(tier('search', 'src/FileSearchModal.js')).toBe('name');
        expect(tier('src/ui', 'src/ui/Modal.js')).toBe('path');
        expect(tier('fsmod', 'src/FileSearchModal.js')).toBe('fuzzyName');
        expect(tier('suim', 'src/ui/Modal.js')).toBe('fuzzyPath');
        expect(tier('zzz', 'src/App.js')).toBeNull();
    });

    it('orders the tiers exact > prefix > name > path > fuzzy name > fuzzy path', () => {
        const s = (q, rel) => scoreFile(q, file(rel)).score;
        const scores = [
            s('app.js', 'App.js'),
            s('app', 'App.js'),
            s('pp', 'App.js'),
            s('lib', 'lib/x.js'),
            s('apjs', 'App.js'),
            s('lx', 'lib/x.js'),
        ];
        expect([...scores].sort((a, b) => b - a)).toEqual(scores);
        expect(new Set(scores).size).toBe(scores.length);
    });

    it('scores a hit at a word start above one inside a word', () => {
        const atWord = scoreFile('search', file('FileSearch.js')).score;
        const inWord = scoreFile('earch', file('FileSearch.js')).score;
        expect(atWord).toBeGreaterThan(inWord);
    });

    it('treats backslashes in the query as slashes', () => {
        expect(scoreFile('src\\ui', file('src/ui/Modal.js')).kind).toBe('path');
    });

    it('returns highlight ranges into the name or the path', () => {
        expect(scoreFile('search', file('src/FileSearch.js')).nameRanges).toEqual([[4, 10]]);
        expect(scoreFile('src/ui', file('src/ui/M.js')).relRanges).toEqual([[0, 6]]);
        expect(scoreFile('fsj', file('FileSearch.js')).nameRanges).toEqual([[0, 1], [4, 5], [11, 12]]);
    });
});

describe('rankFiles', () => {
    it('puts the exact name first, whatever order the walk produced', () => {
        const entries = files('src/legacy/OldApp.js.bak', 'src/AppShell.js', 'src/App.js');
        // AppShell.js only has the letters in order: it comes last.
        expect(order('App.js', entries)).toEqual(['src/App.js', 'src/legacy/OldApp.js.bak', 'src/AppShell.js']);
        expect(order('app', entries)[0]).toBe('src/App.js');
    });

    it('breaks ties with the shorter path', () => {
        const entries = files('a/b/c/readme.md', 'readme.md', 'a/readme.md');
        expect(order('readme.md', entries)).toEqual(['readme.md', 'a/readme.md', 'a/b/c/readme.md']);
    });

    it('puts a recently opened file above a shorter path on a tie', () => {
        const entries = files('readme.md', 'docs/deep/readme.md');
        const recent = ['C:\\proj\\docs\\deep\\readme.md'];
        expect(order('readme.md', entries, { recent })).toEqual(['docs/deep/readme.md', 'readme.md']);
    });

    it('does not let recency lift a weaker tier', () => {
        const entries = files('src/App.js', 'src/legacy/OldApp.js');
        const recent = [`${WS}/src/legacy/OldApp.js`];
        expect(order('app', entries, { recent })[0]).toBe('src/App.js');
    });

    it('finds files by skipped letters, below every substring hit', () => {
        const entries = files('src/modules/ui/FileSearchModal.js', 'docs/flsrch-notes.md');
        expect(order('flsrch', entries)).toEqual(['docs/flsrch-notes.md', 'src/modules/ui/FileSearchModal.js']);
    });

    it('honours the limit', () => {
        const entries = files(...Array.from({ length: 50 }, (_, i) => `f${i}.txt`));
        expect(rankFiles('f', entries, { limit: 10 })).toHaveLength(10);
    });

    it('returns nothing for an empty query', () => {
        expect(rankFiles('   ', files('a.txt'))).toEqual([]);
    });

    describe('globs', () => {
        it('matches the whole name, highlights it, shortest path first', () => {
            const entries = files('x/y/基本設計書.xlsx', '設計書.xlsx', 'memo.txt');
            const r = rankFiles('*設計*.xlsx', entries);
            expect(r.map((h) => h.rel)).toEqual(['設計書.xlsx', 'x/y/基本設計書.xlsx']);
            expect(r[0].nameRanges).toEqual([[0, '設計書.xlsx'.length]]);
        });

        it('matches a path glob against the relative path', () => {
            const entries = files('src/a.js', 'src/ui/b.js', 'test/c.js');
            expect(order('src/*.js', entries)).toEqual(['src/a.js']);
            expect(order('src/**.js', entries)).toEqual(['src/a.js', 'src/ui/b.js']);
        });
    });
});

describe('helpers', () => {
    it('toRelPath strips the workspace whichever slashes either uses', () => {
        expect(toRelPath('C:\\proj\\src\\a.js', 'C:/proj')).toBe('src/a.js');
        expect(toRelPath('C:/proj/src/a.js', 'C:\\proj\\')).toBe('src/a.js');
        expect(toRelPath('D:/other/a.js', 'C:/proj')).toBe('D:/other/a.js');
        // A sibling folder that merely starts with the same letters is not inside.
        expect(toRelPath('C:/project2/a.js', 'C:/proj')).toBe('C:/project2/a.js');
    });

    it('globToRegex keeps * within a segment and ? to one character', () => {
        expect(globToRegex('a?.txt').regex.test('ab.txt')).toBe(true);
        expect(globToRegex('a?.txt').regex.test('abc.txt')).toBe(false);
        expect(globToRegex('src/*.js').regex.test('src/ui/x.js')).toBe(false);
    });

    it('splitRelRanges divides path ranges between the folder and the name', () => {
        // 'src/ui/Modal.js': dir 'src/ui' (0..6), '/' at 6, name from 7
        expect(splitRelRanges([[4, 9]], 'src/ui/Modal.js', 'Modal.js'))
            .toEqual({ dirRanges: [[4, 6]], nameRanges: [[0, 2]] });
        expect(splitRelRanges([[0, 2]], 'Modal.js', 'Modal.js'))
            .toEqual({ dirRanges: [], nameRanges: [[0, 2]] });
    });
});
