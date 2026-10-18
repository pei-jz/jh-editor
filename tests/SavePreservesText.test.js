import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * Saving writes what the user changed and nothing else. Each of these used to
 * rewrite parts of the file that nobody had touched.
 */

vi.mock('../src/modules/ui/Dialog.js', () => ({
    showAlert: vi.fn(async () => true),
    showConfirm: vi.fn(async () => true),   // "Delete this block?" → yes
    showDialog: vi.fn(async () => 'cancel'),
}));

const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
const { State } = await import('../src/modules/core/Store.js');
const { TableEditor } = await import('../src/modules/editors/TableEditor.js');
const { CsvModel } = await import('../src/modules/editors/CsvEditor.js');

describe('Markdown block edits keep the rest of the document as it was', () => {
    let view;
    let file;
    const open = (content) => {
        file = { path: '/d/a.md', content, eol: '\n', isDirty: false };
        State.openFiles = [file];
        State.activeTabIndex = 0;
        view.file = file;
        view.blocksData = view._splitIntoBlocks(content);
    };

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="host"></div>';
        view = new MarkdownView(document.getElementById('host'), { renderTabs: vi.fn(), renderEditor: vi.fn() });
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('keeps blank lines, whitespace-only lines and the final newline elsewhere', () => {
        open('\n# Title\n\n\n\nfirst\n  \nsecond\n\n\nthird\n');
        view.saveBlock(2, 'second, edited');
        expect(file.content).toBe('\n# Title\n\n\n\nfirst\n  \nsecond, edited\n\n\nthird\n');
    });

    it('moving a block keeps the spacing around it', () => {
        open('a\n\n\nb\n\nc\n');
        State.vimState.selectedIndex = 0;
        view.moveBlock(1);
        expect(file.content).toBe('b\n\n\na\n\nc\n');
    });

    it('deleting a block leaves the others untouched', async () => {
        open('a\n\n\nb\n\nc\n\n\nd\n');
        view.selectedRange = () => ({ from: 3, to: 3 });
        await view.deleteSelectedBlocks();
        // "d" is gone; a's triple spacing and the final newline stay.
        expect(file.content.startsWith('a\n\n\nb')).toBe(true);
        expect(file.content.endsWith('\n')).toBe(true);
        expect(file.content).not.toContain('d');
    });

    it('inserting a block uses one blank line around the new one only', () => {
        open('a\n\n\n\nb\n');
        view._applyBlockText(1, 'new', 0);
        expect(file.content).toBe('a\n\n\n\nnew\n\nb\n');
    });

    it('does not split a ~~~ code fence at its blank lines', () => {
        const blocks = view._splitIntoBlocks('~~~\ncode\n\n\nmore\n~~~\n\nafter');
        expect(blocks).toEqual(['~~~\ncode\n\n\nmore\n~~~', 'after']);
    });

    it('a ``` line inside a ~~~ fence does not end it', () => {
        const blocks = view._splitIntoBlocks('~~~\n```\n\nstill code\n~~~\n\nafter');
        expect(blocks).toEqual(['~~~\n```\n\nstill code\n~~~', 'after']);
    });
});

describe('the Markdown table editor', () => {
    it('keeps a pipe escaped inside a cell in its cell', () => {
        const data = TableEditor.parse('| a \\| x | b |\n|---|---|\n| 1 | 2 |');
        expect(data[0]).toEqual(['a \\| x', 'b']);
        expect(TableEditor.serialize(data)).toContain('a \\| x');
        expect(TableEditor.parse(TableEditor.serialize(data))[0]).toEqual(['a \\| x', 'b']);
    });

    it('keeps each column\'s alignment', () => {
        const out = TableEditor.serialize(TableEditor.parse('| a | b | c | d |\n|:--|--:|:-:|---|\n| 1 | 2 | 3 | 4 |'));
        const sep = out.split('\n')[1].split('|').map((c) => c.trim()).filter(Boolean);
        expect(sep[0]).toMatch(/^:-+$/);
        expect(sep[1]).toMatch(/^-+:$/);
        expect(sep[2]).toMatch(/^:-+:$/);
        expect(sep[3]).toMatch(/^-+$/);
    });
});

describe('CSV', () => {
    it('keeps the final line break', () => {
        expect(new CsvModel('a,b\n1,2\n').serialize()).toBe('a,b\n1,2\n');
        expect(new CsvModel('a,b\r\n1,2\r\n').serialize()).toBe('a,b\r\n1,2\r\n');
        expect(new CsvModel('a,b\n1,2').serialize()).toBe('a,b\n1,2');
    });
});
