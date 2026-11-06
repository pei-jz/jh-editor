import { describe, it, expect } from 'vitest';
import { TableEditor } from '../src/modules/editors/TableEditor.js';

describe('TableEditor', () => {
    describe('isTable', () => {
        it('should detect a standard table with leading and trailing pipes', () => {
            const tableText = '| Header 1 | Header 2 |\n|---|---|\n| Row 1 | Row 2 |';
            expect(TableEditor.isTable(tableText)).toBe(true);
        });

        it('should detect a GFM table without leading and trailing pipes', () => {
            const tableText = 'Header 1 | Header 2\n---|---\nRow 1 | Row 2';
            expect(TableEditor.isTable(tableText)).toBe(true);
        });

        it('should detect a table with custom alignments', () => {
            const tableText = 'Header 1 | Header 2\n:---:|---:\nRow 1 | Row 2';
            expect(TableEditor.isTable(tableText)).toBe(true);
        });

        it('should return false for plain text', () => {
            const plainText = 'This is just a normal paragraph of text.\nLine 2 of paragraph.';
            expect(TableEditor.isTable(plainText)).toBe(false);
        });

        it('should return false for code blocks', () => {
            const codeBlock = '```javascript\nconst a = 1 | 2;\n```';
            expect(TableEditor.isTable(codeBlock)).toBe(false);
        });
    });

    describe('parse', () => {
        it('should parse standard table into 2D array', () => {
            const tableText = '| Header 1 | Header 2 |\n|---|---|\n| Row 1 | Row 2 |';
            const expected = [
                ['Header 1', 'Header 2'],
                ['Row 1', 'Row 2']
            ];
            expect(TableEditor.parse(tableText)).toEqual(expected);
        });

        it('should parse GFM table without leading/trailing pipes into 2D array', () => {
            const tableText = 'Header 1 | Header 2\n---|---\nRow 1 | Row 2';
            const expected = [
                ['Header 1', 'Header 2'],
                ['Row 1', 'Row 2']
            ];
            expect(TableEditor.parse(tableText)).toEqual(expected);
        });
    });

    describe('serialize', () => {
        it('should serialize 2D array back to standard markdown table format', () => {
            const data = [
                ['Header 1', 'Header 2'],
                ['Row 1', 'Row 2']
            ];
            const result = TableEditor.serialize(data);
            expect(result).toContain('| Header 1 | Header 2 |');
            expect(result).toContain('| -------- | -------- |');
            expect(result).toContain('| Row 1    | Row 2    |');
        });
    });

    // The cell grid that used to be drawn here (render / focusCell / selectRow)
    // is gone: tables are edited in the Markdown view itself. Its behaviour is
    // covered by MarkdownTableUndo / MarkdownTableRange.
});
