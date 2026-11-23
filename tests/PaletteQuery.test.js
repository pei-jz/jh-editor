import { describe, it, expect } from 'vitest';
import { MODES, parsePaletteInput, inputFor, parseLineQuery, filterByText, modeById } from '../src/modules/utils/PaletteQuery.js';

describe('parsePaletteInput — the prefix picks the mode', () => {
    it.each([
        ['', 'files', ''],
        ['edit', 'files', 'edit'],
        ['@edi', 'tabs', 'edi'],
        ['>toggle', 'commands', 'toggle'],
        ['#render', 'symbols', 'render'],
        [':120', 'line', '120'],
        ['?TODO', 'grep', 'TODO'],
    ])('%j → %s %j', (text, mode, query) => {
        const parsed = parsePaletteInput(text);
        expect(parsed.mode.id).toBe(mode);
        expect(parsed.query).toBe(query);
    });

    it('ignores spaces right after the prefix but keeps inner ones', () => {
        expect(parsePaletteInput('@  my file').query).toBe('my file');
    });

    // Deleting the prefix is how you fall back to a file search.
    it('treats a prefix character later in the text as part of the query', () => {
        expect(parsePaletteInput('a@b').mode.id).toBe('files');
    });

    it('builds the input that reopens a mode', () => {
        expect(inputFor('tabs', 'x')).toBe('@x');
        expect(inputFor('files', 'x')).toBe('x');
        expect(inputFor('nope')).toBe('');
        expect(modeById('nope').id).toBe('files');
    });

    it('gives every mode a distinct prefix', () => {
        const prefixes = MODES.map((m) => m.prefix);
        expect(new Set(prefixes).size).toBe(prefixes.length);
    });
});

describe('parseLineQuery', () => {
    it('accepts a line inside the document', () => {
        expect(parseLineQuery('12', 40)).toEqual({ line: 12 });
    });

    it('accepts any positive line when the length is unknown', () => {
        expect(parseLineQuery('900', 0)).toEqual({ line: 900 });
    });

    it.each([['', 'empty'], ['abc', 'invalid'], ['0', 'invalid'], ['1.5', 'invalid'], ['-3', 'invalid']])(
        '%j is %s', (q, error) => {
            expect(parseLineQuery(q, 10).error).toBe(error);
        });

    // The palette briefly offered "Go to line 5 of 1".
    it('reports a line past the end as out of range, not as a line', () => {
        expect(parseLineQuery('5', 1)).toMatchObject({ error: 'range' });
    });
});

describe('filterByText', () => {
    const items = [
        { name: 'App.js', dir: 'src/core' },
        { name: 'Editor.js', dir: 'src/core' },
        { name: 'EditorZoom.test.js', dir: 'tests' },
        { name: 'credit.md', dir: 'docs' },
        { name: 'index.js', dir: 'src/editor' },
    ];
    const run = (q) => filterByText(items, q, (i) => i.name, (i) => i.dir).map((i) => i.name);

    it('returns everything, in order, for an empty query', () => {
        expect(run('')).toEqual(items.map((i) => i.name));
    });

    it('ranks a name that starts with the query, then a name containing it, then a folder match', () => {
        expect(run('edit')).toEqual(['Editor.js', 'EditorZoom.test.js', 'credit.md', 'index.js']);
    });

    it('keeps the caller order among equals', () => {
        // All three match in the folder, at its start.
        expect(run('src')).toEqual(['App.js', 'Editor.js', 'index.js']);
    });
});
