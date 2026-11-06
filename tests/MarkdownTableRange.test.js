import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// 表示モードの表で、セルを範囲選択してまとめて消す・コピーする・貼り付ける・
// 行や列をまとめて削除する。F2 の表の編集画面をなくしても困らないための機能。

const TABLE = '| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |';

describe('cell ranges in a Markdown table', () => {
    let MarkdownView, ContextMenu, view, file, block;

    beforeAll(async () => {
        const module = { exports: {} };
        new Function('module', 'exports', readFileSync('public/lib/marked.min.js', 'utf8'))(module, module.exports);
        globalThis.marked = module.exports.marked || module.exports;
        ({ MarkdownView } = await import('../src/modules/views/MarkdownView.js'));
        ({ ContextMenu } = await import('../src/modules/ui/ContextMenu.js'));
    });

    const paint = () => {
        block.innerHTML = globalThis.marked.parse(view.blocksData[0]);
        view.tableEdit.attach(block, 0);
    };
    const table = () => block.querySelector('table');
    const cell = (r, c) => table().rows[r].cells[c];
    const sink = () => block.querySelector('.md-range-sink');

    beforeEach(() => {
        document.body.innerHTML = '<div id="host"></div>';
        file = { path: 'C:/t/doc.md', name: 'doc.md', content: TABLE, savedContent: TABLE };
        view = new MarkdownView(document.getElementById('host'), {});
        view.file = file;
        view.blocksData = [TABLE];
        vi.spyOn(view, 'selectBlock').mockImplementation(() => {});
        vi.spyOn(view, '_joinBlocks').mockImplementation(() => view.blocksData[0]);
        vi.spyOn(view, '_refreshDirty').mockImplementation(() => {});
        vi.spyOn(view, '_rerenderBlock').mockImplementation(() => paint());

        block = document.createElement('div');
        block.className = 'md-block';
        block.dataset.index = '0';
        document.getElementById('host').appendChild(block);
        paint();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    const select = (anchor, focus) => {
        view.tableEdit.range = { blockEl: block, index: 0, tableIndex: 0, anchor, focus };
        view.tableEdit._showRange();
    };
    const press = (key, opts = {}) => {
        const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
        sink().dispatchEvent(e);
        return e;
    };
    const clipboardEvent = (type, data = {}) => {
        const store = { ...data };
        const e = new Event(type, { bubbles: true, cancelable: true });
        e.clipboardData = {
            getData: (t) => store[t] || '',
            setData: (t, v) => { store[t] = v; },
        };
        e.store = store;
        return e;
    };
    const mouse = (target, type, opts = {}) => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...opts });
        target.dispatchEvent(e);
        return e;
    };
    const ranged = () => Array.from(block.querySelectorAll('.md-cell-range'), (c) => c.textContent);

    it('marks the cells and hands the keys to the hidden input', () => {
        select({ r: 1, c: 0 }, { r: 2, c: 1 });
        expect(ranged()).toEqual(['1', '2', '4', '5']);
        expect(document.activeElement).toBe(sink());
        expect(sink().classList.contains('md-cell-editing')).toBe(true);
    });

    it('selects across cells by dragging', () => {
        mouse(cell(1, 0), 'mousedown');
        mouse(cell(2, 2), 'mousemove');
        mouse(cell(2, 2), 'mouseup', { buttons: 0 });
        expect(ranged()).toEqual(['1', '2', '3', '4', '5', '6']);
        expect(document.activeElement).toBe(sink());
    });

    it('leaves a drag inside one cell to the text selection', () => {
        mouse(cell(1, 0), 'mousedown');
        mouse(cell(1, 0), 'mousemove');
        mouse(cell(1, 0), 'mouseup', { buttons: 0 });
        expect(view.tableEdit.range).toBe(null);
    });

    it('extends from the cell being edited with Shift+click', () => {
        view.tableEdit._begin(block, 0, cell(1, 1), view.tableEdit._locate(block, 0, table()), 'end');
        const e = mouse(cell(3, 2), 'mousedown', { shiftKey: true });
        expect(e.defaultPrevented).toBe(true);
        expect(ranged()).toEqual(['2', '3', '5', '6', '8', '9']);
        // 続いて来る click では編集に入らない。
        expect(view.tableEdit.handleClick(new MouseEvent('click', { shiftKey: true }), block, 0)).toBe(true);
    });

    it('grows and shrinks with Shift+Arrow, and takes whole rows with Shift+Space', () => {
        select({ r: 1, c: 1 }, { r: 1, c: 1 });
        press('ArrowDown', { shiftKey: true });
        press('ArrowRight', { shiftKey: true });
        expect(ranged()).toEqual(['2', '3', '5', '6']);
        press(' ', { shiftKey: true });
        expect(ranged()).toEqual(['1', '2', '3', '4', '5', '6']);
    });

    it('selects the whole table with Ctrl+A', () => {
        select({ r: 1, c: 1 }, { r: 1, c: 1 });
        press('a', { ctrlKey: true });
        expect(ranged()).toHaveLength(12);
    });

    it('empties the selected cells with Delete, as one undo step', () => {
        select({ r: 1, c: 0 }, { r: 2, c: 1 });
        const e = press('Delete');
        expect(e.defaultPrevented).toBe(true);
        expect(file.content).toBe('| a | b | c |\n|---|---|---|\n|  |  | 3 |\n|  |  | 6 |\n| 7 | 8 | 9 |');
        // 描き直した表の上で選択が続く。
        expect(ranged()).toEqual(['', '', '', '']);
        expect(document.activeElement).toBe(sink());

        view.undo();
        expect(file.content).toBe(TABLE);
    });

    it('copies the cells as tab-separated source and as an HTML table', () => {
        select({ r: 1, c: 1 }, { r: 2, c: 2 });
        const e = clipboardEvent('copy');
        sink().dispatchEvent(e);
        expect(e.defaultPrevented).toBe(true);
        expect(e.store['text/plain']).toBe('2\t3\n5\t6');
        expect(e.store['text/html']).toContain('<td');
        expect(e.store['text/html']).not.toContain('<th');
    });

    it('cuts: copies, then empties', () => {
        select({ r: 3, c: 0 }, { r: 3, c: 0 });
        const e = clipboardEvent('cut');
        sink().dispatchEvent(e);
        expect(e.store['text/plain']).toBe('7');
        expect(file.content).toContain('|  | 8 | 9 |');
    });

    it('pastes a block from Excel at the top-left of the selection', () => {
        select({ r: 1, c: 1 }, { r: 1, c: 1 });
        sink().dispatchEvent(clipboardEvent('paste', { 'text/plain': 'x\ty\r\nz\tw\r\n' }));
        expect(file.content).toBe('| a | b | c |\n|---|---|---|\n| 1 | x | y |\n| 4 | z | w |\n| 7 | 8 | 9 |');
        expect(ranged()).toEqual(['x', 'y', 'z', 'w']);
    });

    it('fills every selected cell with a single pasted value', () => {
        select({ r: 1, c: 0 }, { r: 3, c: 0 });
        sink().dispatchEvent(clipboardEvent('paste', { 'text/plain': 'n' }));
        expect(file.content).toBe('| a | b | c |\n|---|---|---|\n| n | 2 | 3 |\n| n | 5 | 6 |\n| n | 8 | 9 |');
    });

    it('adds rows and columns for a paste that does not fit', () => {
        select({ r: 3, c: 2 }, { r: 3, c: 2 });
        sink().dispatchEvent(clipboardEvent('paste', { 'text/plain': 'p\tq\nr\ts' }));
        const rows = file.content.split('\n');
        expect(rows).toHaveLength(6);
        expect(rows[0].split('|').length - 2).toBe(4);
        expect(file.content).toMatch(/\|\s*7\s*\|\s*8\s*\|\s*p\s*\|\s*q\s*\|/);
        expect(file.content).toMatch(/\|\s*r\s*\|\s*s\s*\|\s*$/);
    });

    it('pastes cells from Excel while a cell is being edited', () => {
        view.tableEdit._begin(block, 0, cell(2, 0), view.tableEdit._locate(block, 0, table()), 'end');
        const e = clipboardEvent('paste', { 'text/plain': 'k\tl' });
        cell(2, 0).dispatchEvent(e);
        expect(e.defaultPrevented).toBe(true);
        expect(file.content).toContain('| k | l | 6 |');
    });

    it('leaves a paste without tabs to the cell itself', () => {
        view.tableEdit._begin(block, 0, cell(2, 0), view.tableEdit._locate(block, 0, table()), 'end');
        const e = clipboardEvent('paste', { 'text/plain': 'plain' });
        cell(2, 0).dispatchEvent(e);
        expect(e.defaultPrevented).toBe(false);
    });

    it('goes back to editing with Enter, and to the block with Escape', () => {
        select({ r: 1, c: 0 }, { r: 2, c: 1 });
        press('Enter');
        expect(view.tableEdit.range).toBe(null);
        expect(cell(2, 1).classList.contains('md-cell-editing')).toBe(true);

        view.tableEdit.cancel();
        select({ r: 1, c: 0 }, { r: 1, c: 0 });
        press('Escape');
        expect(view.tableEdit.range).toBe(null);
        expect(block.querySelector('.md-cell-range')).toBe(null);
        expect(view.selectBlock).toHaveBeenLastCalledWith(0, { reveal: null });
    });

    // Chrome fires blur while the focused input is being removed. The blur
    // came back into clearRange(), the second remove() threw, and Ctrl+Z
    // stopped there without undoing anything. jsdom does not do this.
    it('survives the blur a browser fires while removing the focused input', () => {
        select({ r: 1, c: 0 }, { r: 2, c: 1 });
        press('Delete');
        const input = sink();
        const remove = input.remove.bind(input);
        input.remove = () => {
            input.dispatchEvent(new FocusEvent('blur'));
            if (!input.isConnected) throw new DOMException('no longer a child', 'NotFoundError');
            remove();
        };
        expect(() => press('z', { ctrlKey: true })).not.toThrow();
        expect(file.content).toBe(TABLE);
    });

    it('ends when the focus goes elsewhere', () => {
        select({ r: 1, c: 0 }, { r: 2, c: 1 });
        sink().blur();
        expect(view.tableEdit.range).toBe(null);
        expect(block.querySelector('.md-cell-range')).toBe(null);
    });

    describe('rows and columns from the keyboard (the CSV grid\'s Excel keys)', () => {
        const cellsOf = (text) => text.split('\n').map((l) => l.split('|').slice(1, -1).map((v) => v.trim()));
        const plus = { ctrlKey: true, shiftKey: true };

        it('inserts as many rows above as are selected, and selects them', () => {
            select({ r: 2, c: 1 }, { r: 3, c: 1 });
            const e = press('+', plus);
            expect(e.defaultPrevented).toBe(true);
            expect(cellsOf(file.content).map((r) => r[0])).toEqual(['a', '---', '1', '', '', '4', '7']);
            expect(view.tableEdit.range.anchor).toEqual({ r: 2, c: 0 });
            expect(view.tableEdit.range.focus).toEqual({ r: 3, c: 2 });
        });

        it('takes the key under its other names (JIS ;, keypad +)', () => {
            select({ r: 1, c: 0 }, { r: 1, c: 0 });
            press(';', plus);
            press('+', { ctrlKey: true });
            expect(cellsOf(file.content)).toHaveLength(7);
        });

        it('inserts below the header when the header is selected', () => {
            select({ r: 0, c: 0 }, { r: 0, c: 0 });
            press('+', plus);
            expect(cellsOf(file.content)[2]).toEqual(['', '', '']);
        });

        it('inserts columns to the left when whole columns are selected', () => {
            select({ r: 0, c: 1 }, { r: 3, c: 1 });
            press('+', plus);
            expect(cellsOf(file.content)[0]).toEqual(['a', '', 'b', 'c']);
        });

        it('deletes the selected rows with Ctrl+-, never the header', () => {
            select({ r: 0, c: 0 }, { r: 2, c: 2 });
            press('-', { ctrlKey: true });
            expect(cellsOf(file.content).map((r) => r[0])).toEqual(['a', '---', '7']);
        });

        it('deletes whole columns, but not the last one', () => {
            select({ r: 0, c: 0 }, { r: 3, c: 1 });
            press('-', { ctrlKey: true });
            expect(cellsOf(file.content)[0]).toEqual(['c']);
            press('a', { ctrlKey: true });
            const before = file.content;
            press('-', { ctrlKey: true });
            expect(file.content).toBe(before);
        });

        it('works from a cell being edited, on that cell\'s row', () => {
            view.tableEdit._begin(block, 0, cell(2, 1), view.tableEdit._locate(block, 0, table()), 'end');
            const e = new KeyboardEvent('keydown', { key: '-', ctrlKey: true, bubbles: true, cancelable: true });
            cell(2, 1).dispatchEvent(e);
            expect(e.defaultPrevented).toBe(true);
            expect(cellsOf(file.content).map((r) => r[0])).toEqual(['a', '---', '1', '7']);
        });

        it('adds a row with Tab from the last cell, and edits its first cell', () => {
            view.tableEdit._begin(block, 0, cell(3, 2), view.tableEdit._locate(block, 0, table()), 'end');
            cell(3, 2).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
            expect(cellsOf(file.content)).toHaveLength(6);
            expect(table().rows).toHaveLength(5);
            expect(cell(4, 0).classList.contains('md-cell-editing')).toBe(true);
        });
    });

    // A range starts without selecting the block, so the step used to record
    // whatever block the cursor was on before — and Ctrl+Z scrolled there,
    // typically to the top of the document.
    it('records the table\'s block as the place Ctrl+Z goes back to', async () => {
        const { State } = await import('../src/modules/core/Store.js');
        block.dataset.index = '3';
        view.blocksData = ['# a', 'b', 'c', TABLE];
        view._joinBlocks.mockImplementation(() => view.blocksData.join('\n\n'));
        State.vimState.selectedIndex = 0;
        view.tableEdit.range = { blockEl: block, index: 3, tableIndex: 0, anchor: { r: 1, c: 0 }, focus: { r: 1, c: 0 } };
        view.tableEdit._showRange();
        press('Delete');
        expect(file._mdHistory.undo.at(-1).cursor).toBe(3);
    });

    describe('the right-click menu', () => {
        let items;
        beforeEach(() => {
            items = null;
            vi.spyOn(ContextMenu, 'show').mockImplementation((_e, list) => { items = list; });
        });
        const openMenu = (r, c) => {
            const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
            cell(r, c).dispatchEvent(e);
            return items;
        };
        const item = (label) => items.find((i) => i.label === label);
        // 行や列の削除は表を整形し直すので、桁揃えの空白は比べない。
        const cellsOf = (text) => text.split('\n').map((l) => l.split('|').slice(1, -1).map((v) => v.trim()));

        it('deletes all the selected rows at once, never the header', () => {
            select({ r: 0, c: 0 }, { r: 2, c: 0 });
            openMenu(1, 0);
            item('Delete {n} Rows'.replace('{n}', '2')).action();
            expect(cellsOf(file.content)).toEqual([['a', 'b', 'c'], ['---', '---', '---'], ['7', '8', '9']]);
        });

        it('deletes all the selected columns at once', () => {
            select({ r: 1, c: 0 }, { r: 1, c: 1 });
            openMenu(1, 1);
            item('Delete 2 Columns').action();
            expect(cellsOf(file.content)).toEqual([['c'], ['---'], ['3'], ['6'], ['9']]);
        });

        it('cannot delete every column', () => {
            select({ r: 1, c: 0 }, { r: 1, c: 2 });
            openMenu(1, 0);
            expect(items.some((i) => /Column/.test(i.label || '') && /Delete/.test(i.label || ''))).toBe(false);
        });

        it('inserts below the last selected row', () => {
            select({ r: 1, c: 0 }, { r: 2, c: 0 });
            openMenu(1, 0);
            item('Insert Row Below').action();
            expect(file.content.split('\n')[4]).toMatch(/^\|\s+\|\s+\|\s+\|$/);
        });

        it('clears the contents of the range', () => {
            select({ r: 2, c: 1 }, { r: 3, c: 2 });
            openMenu(3, 2);
            item('Clear Contents').action();
            expect(file.content).toBe('| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 |  |  |\n| 7 |  |  |');
        });

        it('acts on the clicked cell alone when it is outside the range', () => {
            select({ r: 1, c: 0 }, { r: 1, c: 0 });
            openMenu(3, 2);
            expect(view.tableEdit.range).toBe(null);
            expect(item('Delete Row')).toBeTruthy();
        });
    });
});
