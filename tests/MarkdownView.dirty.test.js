import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The block view writes the document back as blocks joined by one blank line,
// so a file saved with other spacing never matched its saved text again once
// touched — and the tab kept its "*" after an edit was put back.

const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
const { State } = await import('../src/modules/core/Store.js');
const { markSaved } = await import('../src/modules/utils/DirtyState.js');

describe('MarkdownView modified mark', () => {
    let view;
    let file;
    let renderTabs;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="host"></div>';
        renderTabs = vi.fn();
        view = new MarkdownView(document.getElementById('host'), {
            renderTabs,
            renderEditor: vi.fn(),
        });
        // Three blank lines and a trailing newline: not the block view's form.
        file = { path: '/notes/a.md', content: '# Title\n\n\n\nfirst\n\nsecond\n', eol: '\n', isDirty: false };
        markSaved(file);
        State.openFiles = [file];
        State.activeTabIndex = 0;
        view.file = file;
        view.blocksData = view._splitIntoBlocks(file.content);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('editing a block and putting it back clears the mark', () => {
        view.saveBlock(1, 'first, edited');
        expect(file.isDirty).toBe(true);

        view.saveBlock(1, 'first');
        expect(file.isDirty).toBe(false);
        // The text is in the block view's form, not the file's original bytes.
        expect(file.content).not.toBe(file.savedContent);
        expect(renderTabs).toHaveBeenCalled();
    });

    it('moving a block and moving it back clears the mark, and the tab is redrawn', () => {
        State.vimState.selectedIndex = 1;
        view.moveBlock(1);
        expect(file.isDirty).toBe(true);
        expect(renderTabs).toHaveBeenCalledTimes(1);

        view.moveBlock(-1);
        expect(file.isDirty).toBe(false);
        expect(renderTabs).toHaveBeenCalledTimes(2);
    });

    it('a real change stays marked', () => {
        view.saveBlock(2, 'second\n\nthird');
        expect(file.isDirty).toBe(true);
    });
});
