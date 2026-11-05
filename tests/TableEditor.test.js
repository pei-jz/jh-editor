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
    /* The cell editor was changed from <input> to <textarea> so long values
       wrap instead of scrolling sideways. Three call sites kept asking the DOM
       for 'input' — which does not match a textarea — so they all got null:
       double-clicking a cell hid the display span and showed nothing in its
       place, and the table could no longer be edited at all. */
    describe('cell editing (regression: the editor is a textarea)', () => {
        const mount = () => {
            const container = document.createElement('div');
            document.body.appendChild(container);
            const data = [['H1', 'H2'], ['R1C1', 'R1C2']];
            TableEditor.render(container, data, () => {});
            return { container, data };
        };

        afterEach(() => { document.body.innerHTML = ''; });

        it('gives every cell a textarea, not a single-line input', () => {
            const { container } = mount();
            const cell = container.querySelector('[data-row="1"][data-col="0"]');
            expect(cell.querySelector('textarea')).not.toBeNull();
            expect(cell.querySelector('input')).toBeNull();
        });

        it('reveals and focuses the editor on double click', () => {
            const { container } = mount();
            const cell = container.querySelector('[data-row="1"][data-col="0"]');
            const editor = cell.querySelector('textarea');
            const span = cell.querySelector('.cell-text');

            cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

            // The bug: the span was hidden and the editor stayed display:none,
            // leaving a blank cell nothing could be typed into.
            expect(editor.style.display).toBe('block');
            expect(span.style.display).toBe('none');
            expect(document.activeElement).toBe(editor);
        });

        it('hides the editor again when the cell is left', () => {
            const { container } = mount();
            const cell = container.querySelector('[data-row="1"][data-col="0"]');
            const other = container.querySelector('[data-row="0"][data-col="1"]');
            const editor = cell.querySelector('textarea');

            cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            expect(editor.style.display).toBe('block');

            other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            expect(editor.style.display).toBe('none');
            expect(cell.querySelector('.cell-text').style.display).not.toBe('none');
        });

        it('writes typed text back into the data array', () => {
            const { container, data } = mount();
            const cell = container.querySelector('[data-row="1"][data-col="0"]');
            const editor = cell.querySelector('textarea');

            cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            editor.value = 'edited';
            editor.dispatchEvent(new Event('input', { bubbles: true }));

            expect(data[1][0]).toBe('edited');
            expect(cell.querySelector('.cell-text').textContent).toBe('edited');
        });

        it('focusCell(edit) opens the editor too', () => {
            const { container } = mount();
            TableEditor.focusCell(container, 1, 1, true);
            const editor = container.querySelector('[data-row="1"][data-col="1"] textarea');
            expect(editor.style.display).toBe('block');
        });
    });

    describe('keys on a selected cell', () => {
        let container;
        let data;
        const at = (r, c) => container.querySelector(`[data-row="${r}"][data-col="${c}"]`);
        const key = (el, init) => {
            const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
            el.dispatchEvent(e);
            return e;
        };
        const select = (r, c) => at(r, c).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        const active = () => [TableEditor._state.activeRow, TableEditor._state.activeCol];

        beforeEach(() => {
            document.body.innerHTML = '';
            container = document.createElement('div');
            document.body.appendChild(container);
            data = [['H1', 'H2'], ['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']];
            TableEditor._state = null;
            TableEditor.render(container, data, () => {});
            select(1, 0);
        });

        afterEach(() => { document.body.innerHTML = ''; });

        it('keeps the first key typed, replacing the old text', () => {
            const e = key(at(1, 0), { key: 'a' });
            const editor = at(1, 0).querySelector('textarea');

            expect(e.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(editor);
            expect(editor.value).toBe('a');
            expect(editor.selectionStart).toBe(1);
            expect(editor.selectionEnd).toBe(1);
            expect(data[1][0]).toBe('a');
            expect(at(1, 0).querySelector('.cell-text').textContent).toBe('a');
        });

        it('undoes a typed-over cell as one step', () => {
            key(at(1, 0), { key: 'a' });
            const editor = at(1, 0).querySelector('textarea');
            editor.value = 'abc';
            editor.dispatchEvent(new Event('input'));
            expect(data[1][0]).toBe('abc');

            TableEditor.undo(container, data, () => {});
            expect(data[1][0]).toBe('a1');
        });

        // An IME needs a text field in focus before the key goes down. Moving
        // focus from the keydown typed the first letter bare: nゆうりょく.
        it('rests in the selected cell\'s editor, unseen, with its text selected', () => {
            const editor = at(1, 0).querySelector('textarea');
            expect(document.activeElement).toBe(editor);
            expect(editor.classList.contains('cell-armed')).toBe(true);
            expect(editor.selectionStart).toBe(0);
            expect(editor.selectionEnd).toBe(2);
            expect(TableEditor._state.isEditing).toBe(false);

            select(2, 1);
            expect(editor.classList.contains('cell-armed')).toBe(false);
            expect(editor.style.display).toBe('none');
            expect(document.activeElement).toBe(at(2, 1).querySelector('textarea'));
        });

        it('leaves a key the IME took alone', () => {
            const editor = at(1, 0).querySelector('textarea');
            const e = key(editor, { key: 'Process', code: 'KeyN', keyCode: 229 });
            expect(e.defaultPrevented).toBe(false);
            expect(TableEditor._state.isEditing).toBe(false);
            expect(data[1][0]).toBe('a1');
        });

        it('shows a conversion in place, without touching focus or selection', () => {
            const editor = at(1, 0).querySelector('textarea');
            const selectAll = vi.spyOn(editor, 'select');
            const focus = vi.spyOn(editor, 'focus');

            editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

            expect(selectAll).not.toHaveBeenCalled();
            expect(focus).not.toHaveBeenCalled();
            expect(TableEditor._state.isEditing).toBe(true);
            expect(editor.classList.contains('cell-armed')).toBe(false);
            expect(at(1, 0).querySelector('.cell-text').style.display).toBe('none');

            editor.value = 'にゅうりょく';
            editor.dispatchEvent(new Event('input'));
            expect(data[1][0]).toBe('にゅうりょく');
        });

        it('drives the grid from the armed editor', () => {
            key(at(1, 0).querySelector('textarea'), { key: 'ArrowDown' });
            expect(active()).toEqual([2, 0]);
            key(at(2, 0).querySelector('textarea'), { key: 'Enter' });
            expect(active()).toEqual([3, 0]);
            key(at(3, 0).querySelector('textarea'), { key: 'Tab' });
            expect(active()).toEqual([3, 1]);
        });

        it('opens the cell when the armed text is deleted', () => {
            const editor = at(1, 0).querySelector('textarea');
            editor.value = '';
            editor.dispatchEvent(new Event('input'));
            expect(TableEditor._state.isEditing).toBe(true);
            expect(data[1][0]).toBe('');
        });

        it('keeps Home and End from moving the armed caret', () => {
            expect(key(at(1, 0).querySelector('textarea'), { key: 'Home' }).defaultPrevented).toBe(true);
        });

        it('leaves copying to the browser while the cell is being edited', () => {
            at(1, 0).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const setData = vi.fn();
            const copy = new Event('copy', { bubbles: true, cancelable: true });
            copy.clipboardData = { setData };
            at(1, 0).querySelector('textarea').dispatchEvent(copy);
            expect(setData).not.toHaveBeenCalled();
            expect(copy.defaultPrevented).toBe(false);
        });

        it('takes the click itself, so focus stays on the armed editor', () => {
            const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
            at(2, 0).dispatchEvent(down);
            expect(down.defaultPrevented).toBe(true);
        });

        it.each([
            ['Enter', {}, [2, 0]],
            ['Enter', { shiftKey: true }, [0, 0]],
            ['Tab', {}, [1, 1]],
        ])('moves one cell on %s %j while editing', (name, mods, expected) => {
            at(1, 0).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            key(at(1, 0).querySelector('textarea'), { key: name, ...mods });
            expect(active()).toEqual(expected);
            expect(TableEditor._state.isEditing).toBe(false);
        });

        it('moves one cell on Enter and Tab while selected', () => {
            key(at(1, 0), { key: 'Enter' });
            expect(active()).toEqual([2, 0]);
            key(at(2, 0), { key: 'Tab' });
            expect(active()).toEqual([2, 1]);
        });

        it('wraps Tab to the next row while editing, as it does while selected', () => {
            select(1, 1);
            at(1, 1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            key(at(1, 1).querySelector('textarea'), { key: 'Tab' });
            expect(active()).toEqual([2, 0]);
        });

        it('wraps Shift+Tab back to the end of the previous row', () => {
            select(2, 0);
            key(at(2, 0), { key: 'Tab', shiftKey: true });
            expect(active()).toEqual([1, 1]);
        });

        it('leaves Enter to the IME while it is converting', () => {
            at(1, 0).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const e = key(at(1, 0).querySelector('textarea'), { key: 'Enter', isComposing: true });
            expect(e.defaultPrevented).toBe(false);
            expect(TableEditor._state.isEditing).toBe(true);
            expect(active()).toEqual([1, 0]);
        });

        it('lands on the new row after Tab appends one', () => {
            vi.useFakeTimers();
            try {
                select(3, 1);
                key(at(3, 1), { key: 'Tab' });
                vi.runAllTimers();
                expect(data.length).toBe(5);
                expect(active()).toEqual([4, 0]);
                expect(at(4, 0).classList.contains('active-cell')).toBe(true);
                expect(document.activeElement).toBe(at(4, 0).querySelector('textarea'));
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('what a cell shows', () => {
        let container;
        const mount = (data) => {
            container = document.createElement('div');
            document.body.appendChild(container);
            TableEditor._state = null;
            TableEditor.render(container, data, () => {});
        };
        const cell = (r, c) => container.querySelector(`[data-row="${r}"][data-col="${c}"]`);

        afterEach(() => { document.body.innerHTML = ''; });

        it('renders the marks, and keeps the source for editing', () => {
            mount([['**H**', 'b'], ['**差分**', '`Alt+R` と <script>x</script>']]);
            expect(cell(0, 0).querySelector('.cell-text b').textContent).toBe('H');
            expect(cell(1, 0).querySelector('.cell-text b').textContent).toBe('差分');
            expect(cell(1, 1).querySelector('.cell-text code').textContent).toBe('Alt+R');
            expect(cell(1, 1).querySelector('.cell-text script')).toBeNull();
            expect(cell(1, 0).querySelector('textarea').value).toBe('**差分**');
        });

        it('renders what was typed', () => {
            const data = [['a'], ['b']];
            mount(data);
            const editor = cell(1, 0).querySelector('textarea');
            editor.value = '**new**';
            editor.dispatchEvent(new Event('input'));
            expect(data[1][0]).toBe('**new**');
            expect(cell(1, 0).querySelector('.cell-text b').textContent).toBe('new');
        });
    });

    describe('column widths', () => {
        it('gives more of the width to the column with more in it', () => {
            const container = document.createElement('div');
            TableEditor._state = null;
            TableEditor.render(container, [['a', 'b'], ['短い', '長い説明がここに入ります。とても長い説明です']], () => {});
            const cols = [...container.querySelectorAll('col')].map((c) => c.style.width);
            expect(cols[0]).toBe('32px');
            expect(parseFloat(cols[2])).toBeGreaterThan(parseFloat(cols[1]));
            expect(parseFloat(cols[1]) + parseFloat(cols[2])).toBeCloseTo(100);
        });
    });
});
