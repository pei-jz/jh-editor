import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * Where a block edit lands, and that it can be taken back.
 *
 * The block view used to find its file as State.openFiles[State.activeTabIndex]
 * — the LEFT pane's active tab. A Markdown document in the right pane then had
 * its edits written into the left pane's file, or dropped when the left pane
 * was empty.
 */

const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
const { State } = await import('../src/modules/core/Store.js');
const { markSaved } = await import('../src/modules/utils/DirtyState.js');

const doc = (path, content) => {
    const f = { path, content, eol: '\n', isDirty: false };
    markSaved(f);
    return f;
};

describe('block edits go to the view\'s own file', () => {
    let view;
    let left;
    let right;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="host"></div>';
        view = new MarkdownView(document.getElementById('host'), {
            renderTabs: vi.fn(),
            renderEditor: vi.fn(),
        });
        left = doc('/a/left.md', 'left one\n\nleft two');
        right = doc('/a/right.md', 'right one\n\nright two');
        State.openFiles = [left];
        State.activeTabIndex = 0;
        State.rightOpenFiles = [right];
        State.rightActiveTabIndex = 0;
        // The view is showing the RIGHT pane's document.
        view.file = right;
        view.blocksData = view._splitIntoBlocks(right.content);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
        State.rightOpenFiles = [];
        State.rightActiveTabIndex = -1;
    });

    it('writes into the document it shows, not the left pane\'s', () => {
        view.saveBlock(0, 'right one, edited');
        expect(right.content).toBe('right one, edited\n\nright two');
        expect(right.isDirty).toBe(true);
        expect(left.content).toBe('left one\n\nleft two');
        expect(left.isDirty).toBe(false);
    });

    it('still saves when the left pane has nothing open', () => {
        State.openFiles = [];
        State.activeTabIndex = -1;
        view.saveBlock(1, 'right two, edited');
        expect(right.content).toBe('right one\n\nright two, edited');
    });

    it('undoes and redoes a block edit after the editor is closed', () => {
        view.saveBlock(0, 'changed');
        view.undo();
        expect(right.content).toBe('right one\n\nright two');
        expect(right.isDirty).toBe(false);
        view.redo();
        expect(right.content).toBe('changed\n\nright two');
        expect(left.content).toBe('left one\n\nleft two');
    });
});

describe('saving the same block more than once (Ctrl+S in the edit modal)', () => {
    let view;
    let file;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="host"></div>';
        view = new MarkdownView(document.getElementById('host'), { renderTabs: vi.fn(), renderEditor: vi.fn() });
        file = doc('/a/n.md', 'one\n\ntwo\n\nthree');
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

    it('re-inserts a block that an earlier save emptied, instead of overwriting the next one', () => {
        view._applyBlockText(1, '', 1);            // first Ctrl+S: block emptied
        expect(file.content).toBe('one\n\nthree');
        view._applyBlockText(1, 'two again', 0);   // the range now covers 0 blocks
        expect(file.content).toBe('one\n\ntwo again\n\nthree');
    });

    it('replaces exactly the blocks an earlier save produced', () => {
        view._applyBlockText(1, 'two\n\ntwo and a half', 1);
        // One entry holding both paragraphs until the view is redrawn.
        view._applyBlockText(1, 'two, final', 1);
        expect(file.content).toBe('one\n\ntwo, final\n\nthree');
    });

    it('keeps each save as its own undo step', () => {
        view._applyBlockText(1, 'two v1', 1);
        view._applyBlockText(1, 'two v2', 1);
        view.undo();
        expect(file.content).toBe('one\n\ntwo v1\n\nthree');
        view.undo();
        expect(file.content).toBe('one\n\ntwo\n\nthree');
    });
});

describe('Ctrl+S in the edit modal', async () => {
    const { SHORTCUTS } = await import('../src/modules/core/ShortcutDefinitions.js');

    it('saves and keeps editing; Ctrl+Enter still saves and closes', () => {
        for (const scope of ['MARKDOWN', 'MARKDOWN_TABLE']) {
            const s = SHORTCUTS[scope].find((x) => x.key === 's' && x.ctrl && !x.shift && !x.alt);
            expect(s.cmd, scope).toBe('md:save-progress');
            const enter = SHORTCUTS[scope].find((x) => x.key === 'Enter' && x.ctrl);
            expect(enter.cmd, scope).toBe('md:save');
        }
    });
});
