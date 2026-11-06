import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Enter (or a second click on the selected block) edits a paragraph, heading,
// list or quote where it stands, so a one-word fix no longer means opening the
// modal. Code, diagrams, math and HTML still go to the modal, and a table
// starts on its first cell.

const BLOCKS = ['# Title', 'plain words here', 'some **bold** text', '- one\n- two', '```js\nx = 1\n```', '| a | b |\n|---|---|\n| 1 | 2 |'];

describe('editing a block in place', () => {
    let MarkdownView, canEditInPlace, State, view, file;

    beforeAll(async () => {
        const module = { exports: {} };
        new Function('module', 'exports', readFileSync('public/lib/marked.min.js', 'utf8'))(module, module.exports);
        globalThis.marked = module.exports.marked || module.exports;
        ({ MarkdownView } = await import('../src/modules/views/MarkdownView.js'));
        ({ canEditInPlace } = await import('../src/modules/views/MarkdownBlockEdit.js'));
        ({ State } = await import('../src/modules/core/Store.js'));
    });

    const paintAll = () => {
        view.container.innerHTML = '';
        view.blocksData.forEach((_, i) => {
            const div = document.createElement('div');
            div.className = 'md-block';
            div.dataset.index = String(i);
            view.container.appendChild(div);
            view._renderBlockInternal(div);
        });
        const phantom = document.createElement('div');
        phantom.className = 'md-block phantom';
        phantom.textContent = '+ Add Block';
        view.container.appendChild(phantom);
    };

    beforeEach(() => {
        document.body.innerHTML = '<div id="host"></div>';
        const content = BLOCKS.join('\n\n');
        file = { path: 'C:/t/doc.md', name: 'doc.md', content, savedContent: content };
        view = new MarkdownView(document.getElementById('host'), {});
        view.file = file;
        view.blocksData = [...BLOCKS];
        vi.spyOn(view, '_refreshDirty').mockImplementation(() => {});
        vi.spyOn(view, 'selectBlock').mockImplementation(() => {});
        // saveBlock redraws through the app; here the redraw is the test's own.
        vi.spyOn(view, 'saveBlock').mockImplementation((index, text) => {
            view._applyBlockText(index, text);
            view.blocksData = view._splitIntoBlocks(file.content);
            paintAll();
        });
        State.markdownViewMode = 'scroll';
        paintAll();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    const blockAt = (i) => view.container.querySelector(`.md-block[data-index="${i}"]`);
    const editor = () => view.container.querySelector('textarea.md-block-inline-editor');
    const key = (el, k, opts = {}) => {
        const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
        el.dispatchEvent(e);
        return e;
    };

    describe('which blocks', () => {
        it.each([
            ['# Title', true],
            ['plain words', true],
            ['- a\n- b\n  - c', true],
            ['> quoted\n> text', true],
            ['1. one\n2. two', true],
            ['```\ncode\n```', false],
            ['| a |\n|---|\n| 1 |', false],
            ['<div>html</div>', false],
            ['$$\nx^2\n$$', false],
            ['> ```\n> code in a quote\n> ```', false],
            ['', false],
        ])('%j → %s', (text, expected) => {
            expect(canEditInPlace(text)).toBe(expected);
        });
    });

    it('shows the source, symbols and all, in place of the rendered block', () => {
        expect(view.blockEdit.begin(2)).toBe(true);
        expect(editor().value).toBe('some **bold** text');
        expect(blockAt(2).classList.contains('md-inline-editing')).toBe(true);
        expect(document.activeElement).toBe(editor());
        // The key handlers treat it as a text field, not as a selected block.
        expect(editor().classList.contains('md-cell-editing')).toBe(true);
    });

    it('commits with Ctrl+Enter, redrawing only that block', () => {
        view.blockEdit.begin(1);
        const others = blockAt(0);
        editor().value = 'changed words';
        key(editor(), 'Enter', { ctrlKey: true });
        expect(file.content).toContain('# Title\n\nchanged words\n\nsome **bold** text');
        expect(blockAt(1).textContent).toContain('changed words');
        expect(blockAt(0)).toBe(others);
        expect(view.saveBlock).not.toHaveBeenCalled();
        expect(view.selectBlock).toHaveBeenLastCalledWith(1, { reveal: 'nearest' });
    });

    it('commits when the focus leaves', () => {
        view.blockEdit.begin(0);
        editor().value = '## New title';
        editor().blur();
        expect(file.content.startsWith('## New title\n\n')).toBe(true);
        expect(blockAt(0).querySelector('h2')).not.toBeNull();
    });

    it('puts everything back on Escape', () => {
        const before = blockAt(3).innerHTML;
        view.blockEdit.begin(3);
        editor().value = 'thrown away';
        key(editor(), 'Escape');
        expect(blockAt(3).innerHTML).toBe(before);
        expect(file.content).toBe(BLOCKS.join('\n\n'));
    });

    it('leaves the document alone when nothing changed', () => {
        const commit = vi.spyOn(view, '_commitContent');
        view.blockEdit.begin(1);
        editor().blur();
        expect(commit).not.toHaveBeenCalled();
        expect(blockAt(1).querySelector('textarea')).toBeNull();
    });

    it('splits the block on a blank line, through the full redraw', () => {
        view.blockEdit.begin(1);
        editor().value = 'first half\n\nsecond half';
        editor().blur();
        expect(view.saveBlock).toHaveBeenCalled();
        expect(view.blocksData).toContain('first half');
        expect(view.blocksData).toContain('second half');
    });

    it('lets Enter type a new line rather than leave', () => {
        view.blockEdit.begin(3);
        expect(key(editor(), 'Enter').defaultPrevented).toBe(false);
        expect(editor()).not.toBeNull();
    });

    it('writes a new block from "+ Add Block", and ignores an empty one', () => {
        expect(view.blockEdit.begin(BLOCKS.length)).toBe(true);
        editor().blur();
        expect(view.saveBlock).not.toHaveBeenCalled();
        expect(view.container.querySelector('.phantom').textContent).toBe('+ Add Block');

        view.blockEdit.begin(BLOCKS.length);
        editor().value = 'a new paragraph';
        editor().blur();
        expect(view.blocksData.at(-1)).toBe('a new paragraph');
    });

    it.each([['without', ''], ['with', '\n']])('appends after the last block %s a final newline', (_, tail) => {
        file.content = BLOCKS.join('\n\n') + tail;
        view._applyBlockText(BLOCKS.length, 'appended');
        expect(file.content).toBe(BLOCKS.join('\n\n') + '\n\nappended' + tail);
    });

    it('refuses code blocks, so the caller opens the modal', () => {
        expect(view.blockEdit.begin(4)).toBe(false);
    });

    // Book mode opened the modal on Enter at first; it edits in place too now.
    it('works in book mode as well', () => {
        State.markdownViewMode = 'book';
        expect(view.blockEdit.begin(1)).toBe(true);
        editor().value = 'edited in the book';
        key(editor(), 'Enter', { ctrlKey: true });
        expect(file.content).toContain('\n\nedited in the book\n\n');
    });

    describe('Enter on a selected block', () => {
        it('edits text in place', () => {
            const modal = vi.spyOn(view, 'enterEditMode').mockImplementation(() => {});
            State.vimState.selectedIndex = 1;
            view._selAnchor = 1;
            view.editSelectedBlockInPlace();
            expect(editor()).not.toBeNull();
            expect(modal).not.toHaveBeenCalled();
        });

        it('opens the modal for a code block', () => {
            const modal = vi.spyOn(view, 'enterEditMode').mockImplementation(() => {});
            State.vimState.selectedIndex = 4;
            view._selAnchor = 4;
            view.editSelectedBlockInPlace();
            expect(modal).toHaveBeenCalledTimes(1);
            expect(modal.mock.calls[0][2]).toBe(4);
        });

        it('starts a table on its first cell', () => {
            const modal = vi.spyOn(view, 'enterEditMode').mockImplementation(() => {});
            State.vimState.selectedIndex = 5;
            view._selAnchor = 5;
            view.editSelectedBlockInPlace();
            expect(modal).not.toHaveBeenCalled();
            expect(blockAt(5).querySelector('td.md-cell-editing').textContent).toBe('1');
        });

        it('is what the block scope maps Enter to; F2 stays the modal', async () => {
            const { SHORTCUTS } = await import('../src/modules/core/ShortcutDefinitions.js');
            const enter = SHORTCUTS.MARKDOWN_BLOCK.find((s) => s.key === 'Enter' && !s.ctrl && !s.shift && !s.alt);
            const f2 = SHORTCUTS.MARKDOWN_BLOCK.find((s) => s.key === 'F2');
            expect(enter.cmd).toBe('md-block:edit-inline');
            expect(f2.cmd).toBe('md-block:edit');
            expect(view.handleShortcut('md-block:edit-inline', { preventDefault() {} })).toBe(true);
        });
    });

    describe('a second click on the selected block', () => {
        beforeEach(() => { vi.useFakeTimers(); });
        afterEach(() => { vi.useRealTimers(); });

        const clickOn = (el) => {
            const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
            Object.defineProperty(e, 'target', { value: el });
            return e;
        };

        it('edits after a pause', () => {
            State.vimState.selectedIndex = 1;
            view._selAnchor = 1;
            view.blockEdit.scheduleFromClick(clickOn(blockAt(1).querySelector('p')), blockAt(1), 1);
            expect(editor()).toBeNull();
            vi.advanceTimersByTime(500);
            expect(editor()).not.toBeNull();
        });

        it('does nothing when it turns into a double-click', () => {
            State.vimState.selectedIndex = 1;
            view._selAnchor = 1;
            view.blockEdit.scheduleFromClick(clickOn(blockAt(1).querySelector('p')), blockAt(1), 1);
            blockAt(1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            vi.advanceTimersByTime(500);
            expect(editor()).toBeNull();
        });

        it('ignores clicks on links and images', () => {
            view.blocksData[1] = 'see [this](https://example.com)';
            paintAll();
            State.vimState.selectedIndex = 1;
            view._selAnchor = 1;
            view.blockEdit.scheduleFromClick(clickOn(blockAt(1).querySelector('a')), blockAt(1), 1);
            vi.advanceTimersByTime(500);
            expect(editor()).toBeNull();
        });
    });
});
