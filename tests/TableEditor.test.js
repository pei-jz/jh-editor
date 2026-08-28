import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    describe('Interactive rendering and editing', () => {
        let container;
        let data;
        let onChange;

        beforeEach(() => {
            container = document.createElement('div');
            data = [
                ['H1', 'H2'],
                ['R1C1', 'R1C2'],
                ['R2C1', 'R2C2']
            ];
            onChange = vi.fn();
            TableEditor._state = null; // reset state
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should render table element structure', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            expect(table).toBeTruthy();
            expect(table.querySelectorAll('tr').length).toBe(3); // header + 2 body rows
            expect(table.querySelectorAll('th').length).toBe(3); // empty row number + 2 headers
        });

        it('should select cells on mousedown and double click', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            const cell = table.querySelector('[data-row="1"][data-col="0"]');

            // Trigger mousedown
            const mouseDownEvent = new MouseEvent('mousedown', { bubbles: true });
            cell.dispatchEvent(mouseDownEvent);
            expect(cell.classList.contains('range-selected')).toBe(true);

            // Trigger double click (enters editing mode)
            const dblClickEvent = new MouseEvent('dblclick', { bubbles: true });
            cell.dispatchEvent(dblClickEvent);
            expect(cell.classList.contains('editing-cell')).toBe(true);
        });

        it('should update model value on text input', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            const cell = table.querySelector('[data-row="1"][data-col="0"]');
            const input = cell.querySelector('textarea');

            input.value = 'NewVal';
            input.dispatchEvent(new Event('input'));

            expect(data[1][0]).toBe('NewVal');
            expect(onChange).toHaveBeenCalled();
        });

        it('should handle arrow key navigation', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            const cell = table.querySelector('[data-row="1"][data-col="0"]');
            
            // Mouse down to select the cell first
            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            
            // Focus and send ArrowDown
            cell.focus();
            const arrowDown = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
            cell.dispatchEvent(arrowDown);

            expect(TableEditor._state.activeRow).toBe(2);
            expect(TableEditor._state.activeCol).toBe(0);
        });

        it('should handle Tab key to move focus and append row at bottom right', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            
            // Focus last cell
            TableEditor._state.activeRow = 2;
            TableEditor._state.activeCol = 1;
            const cell = table.querySelector('[data-row="2"][data-col="1"]');

            const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
            cell.dispatchEvent(tabEvent);

            // Should add a new row
            expect(data.length).toBe(4);
            expect(onChange).toHaveBeenCalled();
        });

        it('should handle Alt+; to insert rows and columns', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            
            TableEditor._state.activeRow = 1;
            TableEditor._state.activeCol = 0;
            const cell = table.querySelector('[data-row="1"][data-col="0"]');

            // Insert Row (Alt + Semicolon)
            const altSemi = new KeyboardEvent('keydown', { key: ';', code: 'Semicolon', altKey: true, bubbles: true });
            cell.dispatchEvent(altSemi);
            expect(data.length).toBe(4); // row inserted

            // Insert Column (Alt + Shift + Semicolon)
            const altShiftSemi = new KeyboardEvent('keydown', { key: ';', code: 'Semicolon', altKey: true, shiftKey: true, bubbles: true });
            cell.dispatchEvent(altShiftSemi);
            expect(data[0].length).toBe(3); // column inserted
        });

        it('should handle Alt+- to delete rows and columns', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            
            TableEditor._state.activeRow = 1;
            TableEditor._state.activeCol = 0;
            const cell = table.querySelector('[data-row="1"][data-col="0"]');

            // Delete row (Alt + Minus)
            const altMinus = new KeyboardEvent('keydown', { key: '-', code: 'Minus', altKey: true, bubbles: true });
            cell.dispatchEvent(altMinus);
            expect(data.length).toBe(2); // row deleted

            // Delete col (Alt + Shift + Minus)
            const altShiftMinus = new KeyboardEvent('keydown', { key: '-', code: 'Minus', altKey: true, shiftKey: true, bubbles: true });
            const newCell = container.querySelector('[data-row="1"][data-col="0"]');
            newCell.dispatchEvent(altShiftMinus);
            expect(data[0].length).toBe(1); // column deleted
        });

        it('should select row using selectRow method', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            TableEditor.selectRow(container, 1);
            const row = container.querySelector('tbody tr'); // first body row
            expect(row.classList.contains('selected-row')).toBe(true);
        });

        it('should handle F2 to start editing the active cell (with e.code fallback)', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            const cell = table.querySelector('[data-row="1"][data-col="0"]');

            // Select the cell first
            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            expect(TableEditor._state.isEditing).toBe(false);

            // F2 with a normal e.key
            cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', code: 'F2', bubbles: true }));
            expect(TableEditor._state.activeRow).toBe(1);
            expect(TableEditor._state.activeCol).toBe(0);
            expect(TableEditor._state.isEditing).toBe(true);
            expect(cell.classList.contains('editing-cell')).toBe(true);
        });

        it('should handle F2 via e.code when e.key is Unidentified (WebView2)', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            const cell = table.querySelector('[data-row="1"][data-col="0"]');

            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', code: 'F2', bubbles: true }));
            expect(TableEditor._state.isEditing).toBe(true);
        });

        it('should support cell copy and paste', () => {
            TableEditor.render(container, data, onChange);
            vi.runAllTimers();
            const table = container.querySelector('table');
            const cell = table.querySelector('[data-row="1"][data-col="0"]');

            // Trigger mousedown to set state row/col first
            cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

            // Copy
            const copyData = {};
            const copyEvent = new Event('copy', { bubbles: true });
            copyEvent.clipboardData = {
                setData: (type, text) => { copyData[type] = text; }
            };
            cell.dispatchEvent(copyEvent);
            expect(copyData['text/plain']).toBe('R1C1');

            // Paste
            const pasteEvent = new Event('paste', { bubbles: true });
            pasteEvent.clipboardData = {
                getData: (type) => 'PastedVal1\tPastedVal2'
            };
            cell.dispatchEvent(pasteEvent);
            expect(data[1][0]).toBe('PastedVal1');
            expect(data[1][1]).toBe('PastedVal2');
        });
    });
});
