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
});
