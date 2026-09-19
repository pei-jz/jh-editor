import { describe, it, expect } from 'vitest';
import { ShortcutManager } from '../src/modules/core/ShortcutManager.js';
import { CsvModel, CsvView } from '../src/modules/editors/CsvEditor.js';

/* Row and column insert / delete used to be Alt+; and Alt+-, with Shift
   switching between row and column — four combinations, none of them borrowed
   from anywhere the user had already been, and reported as hard to remember.
   They are Excel's keys now, which everyone arriving at a grid already knows:

     Ctrl+Shift++   insert       Ctrl+-        delete
     Shift+Space    select row   Ctrl+Space    select column

   and WHICH of a row or a column is decided the way Excel decides it, from the
   shape of the selection rather than from a modifier. */

const csvShortcuts = () => new ShortcutManager().shortcuts.filter((s) => s.scope === 'CSV');

/** Every command bound to `key` + modifiers in the CSV scope. */
const boundTo = (key, { ctrl = false, shift = false, alt = false } = {}) =>
    csvShortcuts()
        .filter((s) => s.key === key && !!s.ctrl === ctrl && !!s.shift === shift && !!s.alt === alt)
        .map((s) => s.cmd);

describe('the CSV grid uses Excel’s keys', () => {
    it('inserts on Ctrl+Shift++', () => {
        expect(boundTo('+', { ctrl: true, shift: true })).toContain('csv:insert');
    });

    it('deletes on Ctrl+-', () => {
        expect(boundTo('-', { ctrl: true })).toContain('csv:delete');
    });

    /* The same physical key reaches the app under several names. Shift+= is '+'
       on a US layout and Shift+; is '+' on a JIS one; some layouts report ':' or
       leave it as '='. The numeric keypad sends a bare '+' and '-' with no
       shift at all. Binding one spelling works on the machine it was written
       on and nowhere else. */
    it('answers to every spelling of the key, not just one keyboard’s', () => {
        for (const k of ['+', ';', ':', '=']) {
            expect(boundTo(k, { ctrl: true, shift: true }), k).toContain('csv:insert');
        }
        expect(boundTo('+', { ctrl: true }), 'keypad +').toContain('csv:insert');
        expect(boundTo('-', { ctrl: true }), 'keypad -').toContain('csv:delete');
    });

    it('keeps the row and column selection Excel pairs them with', () => {
        expect(boundTo(' ', { shift: true })).toContain('csv:select-row');
        expect(boundTo(' ', { ctrl: true })).toContain('csv:select-col');
    });

    // Not additions: the point was to have ONE pair of keys to remember.
    it('has retired the Alt combinations it replaced', () => {
        expect(csvShortcuts().filter((s) => s.alt && !s.ctrl)).toEqual([]);
    });

    // A cell selection cannot express "as columns" — Ctrl+Shift++ on one reads
    // as a row — so the explicit column paste keeps its own key.
    it('leaves Ctrl+Alt+V for pasting copied columns', () => {
        expect(boundTo('v', { ctrl: true, alt: true })).toContain('csv:insert-copied-cols');
    });
});

/* The row-or-column decision. Excel: a selection spanning every row of a column
   IS a column, and that is what insert and delete act on; anything else is a
   row. The real method is exercised — the view's constructor builds a grid of
   DOM, so the prototype is used directly with the two things the decision
   reads. */
const viewOver = (csv, selection) => Object.assign(Object.create(CsvView.prototype), {
    model: new CsvModel(csv),
    selection,
});

const cell = (r, c) => ({ start: { r, c }, end: { r, c } });
const box = (r1, c1, r2, c2) => ({ start: { r: r1, c: c1 }, end: { r: r2, c: c2 } });

describe('whether a selection means rows or columns', () => {
    const SHEET = ['a,b,c', '1,2,3', '4,5,6'].join('\n');   // 3 x 3

    it('calls a full-height, part-width selection a column', () => {
        // Ctrl+Space on the middle column.
        expect(viewOver(SHEET, box(0, 1, 2, 1)).isWholeColumns()).toBe(true);
    });

    it('calls anything shorter a row', () => {
        expect(viewOver(SHEET, box(0, 1, 1, 1)).isWholeColumns()).toBe(false);
        expect(viewOver(SHEET, cell(1, 1)).isWholeColumns()).toBe(false);
    });

    it('calls a whole-row selection a row', () => {
        // Shift+Space on the middle row.
        expect(viewOver(SHEET, box(1, 0, 1, 2)).isWholeColumns()).toBe(false);
    });

    /* The one that matters. Selecting every row of a small file — three rows of
       a three-row CSV, by their row headers — covers the full height exactly as
       a column selection does. Reading that as "columns" would have Ctrl+-
       delete the file's COLUMNS when the user had its rows selected and was
       watching them highlighted. Ambiguous resolves to rows. */
    it('does not mistake "every row of a short file" for a column', () => {
        // Which is also what Ctrl+A selects, and it resolves the same way.
        expect(viewOver(SHEET, box(0, 0, 2, 2)).isWholeColumns()).toBe(false);
    });

    // A one-row file is all ambiguity and no signal. Rows, so that Ctrl+- has
    // nothing left to take rather than quietly removing a column.
    it('treats a single-row file as rows', () => {
        expect(viewOver('a,b,c', box(0, 1, 0, 1)).isWholeColumns()).toBe(false);
    });
});
