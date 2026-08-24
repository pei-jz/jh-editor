import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TableEditor } from '../src/modules/editors/TableEditor.js';

// The visual markdown table had no history at all: Ctrl+Z reached app:undo,
// which asked the VIEW to undo and got nothing. The grid keeps its own stack
// over the 2D array it mutates in place.

const grid = () => [['h1', 'h2'], ['a', 'b'], ['c', 'd']];

describe('TableEditor history', () => {
    let container;
    let data;
    let onChange;

    beforeEach(() => {
        document.body.innerHTML = '';
        container = document.createElement('div');
        document.body.appendChild(container);
        data = grid();
        onChange = vi.fn();
        TableEditor._history = null;
        TableEditor.render(container, data, onChange);
    });

    const cell = (r, c) => container.querySelector(`[data-row="${r}"][data-col="${c}"]`);
    const press = (r, c, key, over = {}) => {
        cell(r, c).dispatchEvent(new KeyboardEvent('keydown', {
            key, bubbles: true, cancelable: true, ...over,
        }));
    };

    it('has nothing to undo on a freshly opened table', () => {
        expect(TableEditor.undo(container, data, onChange)).toBe(false);
        expect(data).toEqual(grid());
    });

    it('undoes a row insert and redoes it', () => {
        press(1, 0, ';', { altKey: true });
        expect(data.length).toBe(4);

        expect(TableEditor.undo(container, data, onChange)).toBe(true);
        expect(data).toEqual(grid());

        expect(TableEditor.redo(container, data, onChange)).toBe(true);
        expect(data.length).toBe(4);
    });

    it('undoes a row delete', () => {
        press(1, 0, '-', { altKey: true });
        expect(data.length).toBe(2);
        TableEditor.undo(container, data, onChange);
        expect(data).toEqual(grid());
    });

    it('undoes a column insert', () => {
        press(1, 0, ';', { altKey: true, shiftKey: true });
        expect(data[0].length).toBe(3);
        TableEditor.undo(container, data, onChange);
        expect(data).toEqual(grid());
    });

    // The caller holds this exact array and serialises it — swapping in a new
    // one would leave it writing the pre-undo table back to the document.
    it('restores into the same array the caller holds', () => {
        const held = data;
        press(1, 0, ';', { altKey: true });
        TableEditor.undo(container, data, onChange);
        expect(data).toBe(held);
        expect(held).toEqual(grid());
    });

    it('tells the caller the table changed', () => {
        press(1, 0, ';', { altKey: true });
        onChange.mockClear();
        TableEditor.undo(container, data, onChange);
        expect(onChange).toHaveBeenCalled();
    });

    it('walks several steps back and forward', () => {
        press(1, 0, ';', { altKey: true });
        press(1, 0, ';', { altKey: true });
        expect(data.length).toBe(5);
        TableEditor.undo(container, data, onChange);
        TableEditor.undo(container, data, onChange);
        expect(data).toEqual(grid());
        TableEditor.redo(container, data, onChange);
        TableEditor.redo(container, data, onChange);
        expect(data.length).toBe(5);
    });

    it('drops the redo tail once you edit after undoing', () => {
        press(1, 0, ';', { altKey: true });
        TableEditor.undo(container, data, onChange);
        press(1, 0, '-', { altKey: true });          // a different edit
        expect(TableEditor.redo(container, data, onChange)).toBe(false);
    });

    // Typing fires per keystroke; an undo per character is not what anyone
    // means by undo.
    it('collapses a run of typing in one cell into a single step', () => {
        const input = cell(1, 0).querySelector('input');
        for (const value of ['x', 'xy', 'xyz']) {
            input.value = value;
            input.dispatchEvent(new Event('input'));
        }
        expect(data[1][0]).toBe('xyz');
        TableEditor.undo(container, data, onChange);
        expect(data[1][0]).toBe('a');
    });

    it('keeps typing in different cells as separate steps', () => {
        const type = (r, c, value) => {
            const input = cell(r, c).querySelector('input');
            input.value = value;
            input.dispatchEvent(new Event('input'));
        };
        type(1, 0, 'x');
        type(1, 1, 'y');
        TableEditor.undo(container, data, onChange);
        expect(data[1][1]).toBe('b');
        expect(data[1][0]).toBe('x');
    });

    it('starts over when a different table is opened', () => {
        press(1, 0, ';', { altKey: true });
        const other = [['z']];
        TableEditor.render(container, other, onChange);
        expect(TableEditor.undo(container, other, onChange)).toBe(false);
    });
});

describe('Ctrl+Z reaching the grid', () => {
    it('is not swallowed by the global shortcut manager', async () => {
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const { dirname, join } = await import('node:path');
        const here = dirname(fileURLToPath(import.meta.url));
        const sm = readFileSync(join(here, '..', 'src/modules/core/ShortcutManager.js'), 'utf8');
        // Without this the GLOBAL app:undo fires first and preventDefaults, so
        // the cell's own keydown handler never runs.
        expect(sm).toContain("this.currentScope === 'MARKDOWN_TABLE'");
    });
});
