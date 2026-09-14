import { describe, it, expect, vi } from 'vitest';

const render = vi.fn();
vi.mock('../src/modules/editors/CsvEditor.js', () => ({
    CsvEditor: { activeInstance: null, render: (...a) => render(...a) },
}));

const { CsvView } = await import('../src/modules/views/CsvView.js');
const { markSaved } = await import('../src/modules/utils/DirtyState.js');

/** Open a CSV tab; returns the callbacks CsvView gave the grid. */
function openCsv(content, over = {}) {
    const renderTabs = vi.fn();
    const view = new CsvView(document.createElement('div'), { renderTabs });
    const file = { path: 'C:/proj/t.csv', content, eol: '\n', isDirty: false };
    markSaved(file);
    Object.assign(file, over);
    view.render(file.content, file);
    const [, , onSave, options] = render.mock.calls.at(-1);
    return { file, renderTabs, onSave, options };
}

describe('CsvView modified mark', () => {
    it('undoing back to the loaded data clears it, although the grid rewrites the text', () => {
        const { file, renderTabs, onSave, options } = openCsv('a,b\nc,d\n');
        // The grid's serialisation of that file: CRLF, no trailing newline.
        options.onLoaded('a,b\r\nc,d');

        onSave('a,b\r\nc,X');
        expect(file.isDirty).toBe(true);
        expect(renderTabs).toHaveBeenCalledTimes(1);

        onSave('a,b\r\nc,d');
        expect(file.isDirty).toBe(false);
        expect(renderTabs).toHaveBeenCalledTimes(2);
    });

    it('a grid reopened on unsaved edits does not take them as the saved file', () => {
        const { file, onSave, options } = openCsv('a,b\n', { content: 'a,Z', isDirty: true });
        options.onLoaded('a,Z');
        onSave('a,Z');
        expect(file.isDirty).toBe(true);
    });

    it('a byte-identical write-back is clean without any form', () => {
        const { file, onSave } = openCsv('a,b');
        onSave('a,b');
        expect(file.isDirty).toBe(false);
    });
});
