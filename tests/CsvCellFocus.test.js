import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { CsvEditor } from '../src/modules/editors/CsvEditor.js';

// The grid measures column widths on a canvas and watches its size; jsdom has
// neither.
beforeAll(() => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    HTMLCanvasElement.prototype.getContext = () => ({ font: '', measureText: (s) => ({ width: String(s).length * 7 }) });
});

/* Clicking a cell redraws the rows, the clicked <td> included, while the
   mousedown is still being handled. The browser's own mousedown step runs
   after that: it looks for a focusable ancestor of a target that is no longer
   in the document, finds none, and drops focus to <body>. F2, typing and the
   arrow keys then stopped reaching the grid until it was clicked a second way.

   jsdom does not run that browser step, so what is checked here is the grid's
   side of it: the press puts the focus in the grid itself and cancels the
   browser's step, so nothing moves it afterwards. */

let host;

function openGrid(text = 'a,b,c\n1,2,3\n4,5,6\n') {
    host = document.createElement('div');
    host.style.height = '400px';
    document.body.appendChild(host);
    CsvEditor.render(host, text, () => {});
    return CsvEditor.activeInstance;
}

afterEach(() => {
    if (CsvEditor.activeInstance) CsvEditor.activeInstance.destroy();
    CsvEditor.activeInstance = null;
    host?.remove();
    document.body.focus();
});

const press = (el, init = {}) => {
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init });
    el.dispatchEvent(e);
    return e;
};

describe('a press in the CSV grid keeps the keyboard there', () => {
    // The data rows come from a parser Worker that jsdom cannot start, so a
    // stand-in cell is put where the grid's rows go and pressed there.
    const cellPress = (ctl, init = {}) => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td data-r="1" data-c="1">x</td>';
        ctl.view.contentTableTBody.appendChild(tr);
        return press(tr.firstChild, init);
    };

    it('a cell press focuses the grid and cancels the browser’s focus step', () => {
        const ctl = openGrid();
        document.body.focus();

        const e = cellPress(ctl);

        expect(e.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(ctl.view.gridContainer);
        expect(ctl.view.cursor).toEqual({ r: 1, c: 1 });
    });

    it('row and column header presses do the same', () => {
        const ctl = openGrid();
        const rowHead = host.querySelector('.row-indices-table th');
        const colHead = host.querySelector('.csv-header-fixed th');
        expect(rowHead && colHead, 'headers rendered').toBeTruthy();

        document.body.focus();
        expect(press(rowHead).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(ctl.view.gridContainer);

        document.body.focus();
        expect(press(colHead).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(ctl.view.gridContainer);
    });

    it('leaves a right-click alone for the context menu', () => {
        const ctl = openGrid();
        expect(cellPress(ctl, { button: 2 }).defaultPrevented).toBe(false);
    });
});

/* Double-click opens a cell as F2 does. The browser's own dblclick could not
   do it: each press redraws the rows, so the two clicks hit two different
   <td>s and the event never named a cell. The second press is recognised in
   the mousedown instead. */
describe('a double-click in the CSV grid edits the cell', () => {
    const cellAt = (ctl, r, c) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td data-r="${r}" data-c="${c}">x</td>`;
        ctl.view.contentTableTBody.appendChild(tr);
        return tr.firstChild;
    };
    const pressAt = (ctl, r, c, init) => press(cellAt(ctl, r, c), init);

    it('opens the cell on a second press of the same cell', () => {
        const ctl = openGrid();
        const calls = [];
        ctl.startEditing = (r, c) => calls.push([r, c]);
        pressAt(ctl, 1, 2);
        expect(calls).toEqual([]);
        pressAt(ctl, 1, 2);
        expect(calls).toEqual([[1, 2]]);
    });

    it('does not open on presses of two different cells', () => {
        const ctl = openGrid();
        const calls = [];
        ctl.startEditing = (r, c) => calls.push([r, c]);
        pressAt(ctl, 1, 2);
        pressAt(ctl, 1, 1);
        expect(calls).toEqual([]);
    });

    it('a third quick press starts over rather than reopening', () => {
        const ctl = openGrid();
        const calls = [];
        ctl.startEditing = (r, c) => calls.push([r, c]);
        pressAt(ctl, 0, 0); pressAt(ctl, 0, 0); pressAt(ctl, 0, 0);
        expect(calls).toEqual([[0, 0]]);
    });

    it('a Shift press after a press on the same cell does not open it', () => {
        const ctl = openGrid();
        const calls = [];
        ctl.startEditing = (r, c) => calls.push([r, c]);
        pressAt(ctl, 1, 1);
        pressAt(ctl, 1, 1, { shiftKey: true });
        expect(calls).toEqual([]);
    });
});

/* Shift+click (and Ctrl+click) extends the selection from its anchor to the
   clicked cell, as Shift+Arrow does: the active cell stays where it was. Every
   press used to start a fresh one-cell selection whatever the modifiers. */
describe('Shift / Ctrl + click in the CSV grid extends the selection', () => {
    const pressAt = (ctl, r, c, init) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td data-r="${r}" data-c="${c}">x</td>`;
        ctl.view.contentTableTBody.appendChild(tr);
        return press(tr.firstChild, init);
    };

    for (const [name, mod] of [['Shift', { shiftKey: true }], ['Ctrl', { ctrlKey: true }]]) {
        it(`${name}+click spans from the anchor to the clicked cell`, () => {
            const ctl = openGrid();
            pressAt(ctl, 0, 0);
            pressAt(ctl, 2, 1, mod);
            expect(ctl.view.selection.start).toEqual({ r: 0, c: 0 });
            expect(ctl.view.selection.end).toEqual({ r: 2, c: 1 });
            expect(ctl.view.cursor).toEqual({ r: 0, c: 0 });
        });
    }

    it('a second Shift+click re-spans from the same anchor', () => {
        const ctl = openGrid();
        pressAt(ctl, 1, 1);
        pressAt(ctl, 2, 2, { shiftKey: true });
        pressAt(ctl, 0, 0, { shiftKey: true });
        expect(ctl.view.selection.start).toEqual({ r: 1, c: 1 });
        expect(ctl.view.selection.end).toEqual({ r: 0, c: 0 });
    });
});
