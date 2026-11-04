import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const writeText = vi.fn(async () => {});
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: (...a) => writeText(...a), readText: vi.fn(async () => '') }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
const { TableEditor } = await import('../src/modules/editors/TableEditor.js');
const { Toast } = await import('../src/modules/ui/Toast.js');

// A table in the Markdown view can be copied two ways: its source for another
// Markdown file, or the table itself for a spreadsheet.
const TABLE = '| Name | Note |\n|---|---|\n| a | `x` |\n| b | y |';

describe('copying a table block', () => {
    let view;
    let block;

    const draw = (text) => {
        view.blocksData = [text];
        block = document.createElement('div');
        block.className = 'md-block';
        block.dataset.index = '0';
        document.getElementById('host').appendChild(block);
        view._renderBlockInternal(block);
    };

    beforeEach(() => {
        writeText.mockClear();
        document.body.innerHTML = '<div id="host"></div>';
        view = new MarkdownView(document.getElementById('host'), {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('offers both on a table', () => {
        draw(TABLE);
        expect(block.querySelector('.md-copy-icon')).not.toBeNull();
        expect(block.querySelector('.md-copy-table-icon')).not.toBeNull();
    });

    it('offers only the source on anything else', () => {
        draw('Just a paragraph.');
        expect(block.querySelector('.md-copy-icon')).not.toBeNull();
        expect(block.querySelector('.md-copy-table-icon')).toBeNull();
    });

    it('the source button copies the Markdown as written', async () => {
        draw(TABLE);
        block.querySelector('.md-copy-icon').click();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(TABLE));
    });

    it('the table button copies what the table editor\'s own button does', async () => {
        const copy = vi.spyOn(TableEditor, 'copyToClipboard').mockResolvedValue(true);
        draw(TABLE);
        const button = block.querySelector('.md-copy-table-icon');
        button.click();
        await vi.waitFor(() => expect(button.classList.contains('copied')).toBe(true));
        expect(copy).toHaveBeenCalledWith([['Name', 'Note'], ['a', '`x`'], ['b', 'y']].map((row) => expect.arrayContaining(row)));
        expect(writeText).not.toHaveBeenCalled();
    });

    it('copies the table as it is now, after a cell was edited in place', async () => {
        const copy = vi.spyOn(TableEditor, 'copyToClipboard').mockResolvedValue(true);
        draw(TABLE);
        view.blocksData[0] = TABLE.replace('| b | y |', '| b | edited |');
        await view._copyBlockAsTable(0, block.querySelector('.md-copy-table-icon'));
        expect(TableEditor.toTsv(copy.mock.calls[0][0])).toContain('b\tedited');
    });

    it('says so when it did not reach the clipboard, and does not claim otherwise', async () => {
        vi.spyOn(TableEditor, 'copyToClipboard').mockResolvedValue(false);
        const toast = vi.spyOn(Toast, 'show').mockImplementation(() => {});
        draw(TABLE);
        const button = block.querySelector('.md-copy-table-icon');
        await view._copyBlockAsTable(0, button);
        expect(toast).toHaveBeenCalled();
        expect(button.classList.contains('copied')).toBe(false);
    });
});
