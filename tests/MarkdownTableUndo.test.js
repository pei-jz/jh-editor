import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Enter で確定して次のセルへ移ると、ブラウザーの取り消しには新しいセルの分しかない。
// Ctrl+Z を標準の動作に任せたままだと、確定した編集へ戻る手段がなかった。

const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';

describe('Ctrl+Z inside a table cell', () => {
    let MarkdownView, view, file, block, table;

    beforeAll(async () => {
        const module = { exports: {} };
        new Function('module', 'exports', readFileSync('public/lib/marked.min.js', 'utf8'))(module, module.exports);
        globalThis.marked = module.exports.marked || module.exports;
        ({ MarkdownView } = await import('../src/modules/views/MarkdownView.js'));
    });

    beforeEach(() => {
        document.body.innerHTML = '<div id="host"></div>';
        file = { path: 'C:/t/doc.md', name: 'doc.md', content: TABLE, savedContent: TABLE };
        view = new MarkdownView(document.getElementById('host'), {});
        view.file = file;
        view.blocksData = [TABLE];
        vi.spyOn(view, 'selectBlock').mockImplementation(() => {});
        vi.spyOn(view, '_joinBlocks').mockImplementation(() => view.blocksData[0]);
        vi.spyOn(view, '_refreshDirty').mockImplementation(() => {});

        block = document.createElement('div');
        block.className = 'md-block';
        block.dataset.index = '0';
        block.innerHTML = globalThis.marked.parse(TABLE);
        document.getElementById('host').appendChild(block);
        table = block.querySelector('table');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    const open = (row, col) => {
        const cell = table.rows[row].cells[col];
        view.tableEdit._begin(block, 0, cell, view.tableEdit._locate(block, 0, table), 'end');
        return cell;
    };
    const press = (cell, key, opts = {}) => {
        const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
        cell.dispatchEvent(e);
        return e;
    };

    /** 1 行目のセルを x に直して Enter で次のセルへ移った状態。 */
    const commitThenMoveDown = () => {
        const first = open(1, 0);
        first.textContent = 'x';
        press(first, 'Enter');
        expect(file.content).toContain('| x | 2 |');
        return table.rows[2].cells[0];
    };

    it('takes back the edit committed by Enter, from the next cell', () => {
        const next = commitThenMoveDown();
        expect(next.classList.contains('md-cell-editing')).toBe(true);

        const e = press(next, 'z', { ctrlKey: true });

        expect(e.defaultPrevented).toBe(true);
        expect(file.content).toBe(TABLE);
        expect(next.classList.contains('md-cell-editing')).toBe(false);
    });

    it('leaves what was typed in this cell to the native undo', () => {
        const next = commitThenMoveDown();
        next.textContent = '3y';

        const e = press(next, 'z', { ctrlKey: true });

        expect(e.defaultPrevented).toBe(false);
        expect(file.content).toContain('| x | 2 |');
        expect(next.classList.contains('md-cell-editing')).toBe(true);
    });

    it('moves on to the document once the typing is undone', () => {
        const next = commitThenMoveDown();
        next.textContent = '3y';
        press(next, 'z', { ctrlKey: true });
        next.textContent = '3';     // ブラウザーの取り消しの結果

        press(next, 'z', { ctrlKey: true });

        expect(file.content).toBe(TABLE);
    });

    it('stays in the cell when there is nothing left to undo', () => {
        const cell = open(1, 0);
        const e = press(cell, 'z', { ctrlKey: true });
        expect(e.defaultPrevented).toBe(true);
        expect(cell.classList.contains('md-cell-editing')).toBe(true);
    });

    it('redoes a document edit with Ctrl+Y and Ctrl+Shift+Z', () => {
        const next = commitThenMoveDown();
        press(next, 'z', { ctrlKey: true });
        expect(file.content).toBe(TABLE);

        press(open(2, 1), 'y', { ctrlKey: true });
        expect(file.content).toContain('| x | 2 |');

        view.undo();
        press(open(2, 1), 'Z', { ctrlKey: true, shiftKey: true });
        expect(file.content).toContain('| x | 2 |');
    });

    it('keeps redo native after a native undo in the same cell', () => {
        const next = commitThenMoveDown();
        next.textContent = '3y';
        press(next, 'z', { ctrlKey: true });
        next.textContent = '3';

        const e = press(next, 'y', { ctrlKey: true });

        expect(e.defaultPrevented).toBe(false);
    });

    it('ignores the keys while composing', () => {
        const next = commitThenMoveDown();
        const e = press(next, 'z', { ctrlKey: true, isComposing: true });
        expect(e.defaultPrevented).toBe(false);
        expect(file.content).toContain('| x | 2 |');
    });
});
