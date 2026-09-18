import { describe, it, expect } from 'vitest';
import { CsvModel } from '../src/modules/editors/CsvEditor.js';

describe('CsvModel', () => {
    it('should parse simple CSV content', () => {
        const model = new CsvModel("a,b,c\n1,2,3");
        expect(model.getRowCount()).toBe(2);
        expect(model.getColCount()).toBe(3);
        expect(model.getValue(0, 0)).toBe('a');
        expect(model.getValue(1, 2)).toBe('3');
    });

    it('should handle quoted CSV content', () => {
        const model = new CsvModel('a,"b,c",d\n1,2,3');
        expect(model.getColCount()).toBe(3);
        expect(model.getValue(0, 1)).toBe('b,c');
    });

    it('should serialize CSV content with line endings preserved', () => {
        const model = new CsvModel("a,b\n1,2");
        model.setValue(0, 0, "x");
        const serialized = model.serialize();
        expect(serialized).toBe("x,b\n1,2");
    });

    // A block pasted past the right or bottom edge used to be written with
    // setValue anyway: past the end of a row, where the grid (sized from row 0)
    // never drew it and serialize() still wrote it to the file.
    describe('pasteMatrix', () => {
        it('grows the sheet to fit a block pasted past the edge', () => {
            const model = new CsvModel('a,b\n1,2');
            model.pasteMatrix(1, 1, [['x', 'y', 'z'], ['p', 'q', 'r']]);

            expect(model.getRowCount()).toBe(3);
            expect(model.getColCount()).toBe(4);
            // Every row is as wide as the sheet, so serialize() cannot emit a
            // row with more fields than the grid shows.
            expect(model.getData().every((row) => row.length === 4)).toBe(true);
            expect(model.serialize()).toBe('a,b,,\n1,x,y,z\n,p,q,r');
        });

        it('pastes in place when the block already fits', () => {
            const model = new CsvModel('a,b\n1,2');
            model.pasteMatrix(0, 0, [['x']]);
            expect(model.serialize()).toBe('x,b\n1,2');
        });

        it('undoes the whole paste in one step', () => {
            const model = new CsvModel('a,b\n1,2');
            model.pasteMatrix(0, 0, [['x', 'y', 'z'], ['p', 'q', 'r']]);
            model.undo();
            expect(model.serialize()).toBe('a,b\n1,2');
        });

        it('ignores an empty clipboard rather than growing the sheet', () => {
            const model = new CsvModel('a,b\n1,2');
            model.pasteMatrix(0, 0, []);
            model.pasteMatrix(0, 0, [[]]);
            model.pasteMatrix(-1, 0, [['x']]);
            expect(model.serialize()).toBe('a,b\n1,2');
        });
    });

    // The one caller that means to widen the sheet says so; setValue writing
    // outside it produced cells the grid never drew and the file still got.
    it('setValue does not write outside the sheet', () => {
        const model = new CsvModel('a,b\n1,2');
        model.setValue(1, 5, 'ghost');
        expect(model.getColCount()).toBe(2);
        expect(model.serialize()).toBe('a,b\n1,2');
    });

    it('inserts copied rows at an index, padding/truncating to column count', () => {
        const model = new CsvModel("a,b\n1,2\n3,4");
        // Matrix has an extra column; it should be truncated to 2 cols.
        model.insertRows(1, [['x', 'y', 'z'], ['p']]);
        expect(model.getRowCount()).toBe(5);
        expect(model.getData()[1]).toEqual(['x', 'y']);     // truncated
        expect(model.getData()[2]).toEqual(['p', '']);      // padded
        expect(model.getData()[3]).toEqual(['1', '2']);     // shifted down
    });

    it('inserts copied columns at an index, shifting existing columns right', () => {
        const model = new CsvModel("a,b\n1,2");
        model.insertCols(1, [['X'], ['Y']]);
        expect(model.getColCount()).toBe(3);
        expect(model.getData()[0]).toEqual(['a', 'X', 'b']);
        expect(model.getData()[1]).toEqual(['1', 'Y', '2']);
    });

    it('insert is a single undo step', () => {
        const model = new CsvModel("a,b\n1,2");
        model.insertRows(0, [['x', 'y'], ['z', 'w']]);
        expect(model.getRowCount()).toBe(4);
        model.undo();
        expect(model.getRowCount()).toBe(2);
        expect(model.getData()[0]).toEqual(['a', 'b']);
    });

    /* Ctrl+- removes as many rows as are selected, which is what Excel does.
       Doing that by calling deleteRow() in a loop would leave one undo step per
       row on the stack: an accidental press over 200 selected rows would take
       200 undos to put back. */
    describe('deleting a range', () => {
        it('takes every selected row out at once', () => {
            const model = new CsvModel("a,b\n1,2\n3,4\n5,6");
            expect(model.deleteRows(1, 2)).toBe(2);
            expect(model.getRowCount()).toBe(2);
            expect(model.getData()).toEqual([['a', 'b'], ['5', '6']]);
        });

        it('takes every selected column out at once', () => {
            const model = new CsvModel("a,b,c,d\n1,2,3,4");
            expect(model.deleteCols(1, 2)).toBe(2);
            expect(model.getColCount()).toBe(2);
            expect(model.getData()).toEqual([['a', 'd'], ['1', '4']]);
        });

        it('undoes in one step, however many lines went', () => {
            const model = new CsvModel("a,b\n1,2\n3,4\n5,6");
            model.deleteRows(0, 3);
            expect(model.getRowCount()).toBe(1);
            model.undo();
            expect(model.getRowCount()).toBe(4);
            expect(model.getData()[0]).toEqual(['a', 'b']);
        });

        // Selecting everything and pressing Ctrl+- must not leave a sheet with
        // no rows or no columns — there would be nothing left to type into.
        it('always leaves one line standing', () => {
            const rows = new CsvModel("a,b\n1,2\n3,4");
            expect(rows.deleteRows(0, 3)).toBe(2);
            expect(rows.getRowCount()).toBe(1);

            const cols = new CsvModel("a,b,c\n1,2,3");
            expect(cols.deleteCols(0, 3)).toBe(2);
            expect(cols.getColCount()).toBe(1);
        });

        it('reports nothing removed rather than acting on a bad range', () => {
            const model = new CsvModel("a,b\n1,2");
            expect(model.deleteRows(9, 1)).toBe(0);
            expect(model.deleteRows(0, 0)).toBe(0);
            expect(model.deleteCols(-1, 1)).toBe(0);
            expect(model.getData()).toEqual([['a', 'b'], ['1', '2']]);
        });
    });
});
