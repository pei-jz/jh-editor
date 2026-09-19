import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
    writeText: vi.fn(async () => {}), readText: vi.fn(async () => ''),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
const { State } = await import('../src/modules/core/Store.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').split('\r\n').join('\n');

/* Copying blocks. Three things were wrong or missing at once:

   - Ctrl+C over a MULTI-block selection copied one block and dropped the rest,
     silently — highlighting, delete and F2 all read selectedRange(), and only
     the copy read selectedIndex.
   - Nothing on screen said a block could be copied at all.
   - A heading is one short line, which is the hardest thing on the page to drag
     across, and that is what people were reaching for the mouse to do. */

/** A view over `blocks`, with the cursor at `cursor` and the anchor at `anchor`. */
function viewOver(blocks, { cursor = 0, anchor = null, eol = '\n' } = {}) {
    const view = Object.create(MarkdownView.prototype);
    view.blocksData = blocks.slice();
    view._selAnchor = anchor;
    State.vimState = State.vimState || {};
    State.vimState.selectedIndex = cursor;
    State.activeTabIndex = 0;
    State.openFiles = [{ path: 'C:/docs/notes.md', name: 'notes.md', content: '', eol }];
    return view;
}

const DOC = ['# Title', '## Section A', 'First paragraph.', '## Section B', 'Second paragraph.'];

describe('copying the selected blocks', () => {
    it('copies the block under the cursor', () => {
        expect(viewOver(DOC, { cursor: 1 }).getSelectedText()).toBe('## Section A');
    });

    // The bug. Select a heading, extend onto the paragraph under it, copy — and
    // the heading was gone, with nothing to say so.
    it('copies EVERY block in the selection, not just the last one', () => {
        const view = viewOver(DOC, { cursor: 2, anchor: 1 });
        expect(view.getSelectedText()).toBe('## Section A\n\nFirst paragraph.');
    });

    it('copies the same range whichever end the cursor is on', () => {
        const down = viewOver(DOC, { cursor: 3, anchor: 1 }).getSelectedText();
        const up = viewOver(DOC, { cursor: 1, anchor: 3 }).getSelectedText();
        expect(up).toBe(down);
        expect(down.split('\n\n')).toHaveLength(3);
    });

    /* Joined the way _editBlockRange joins and saveBlock writes: one blank line
       between blocks, in the FILE's line ending. A copy therefore pastes back as
       the blocks it came from rather than as one run-on block. */
    it('separates blocks the way the file does', () => {
        const view = viewOver(DOC, { cursor: 2, anchor: 1, eol: '\r\n' });
        expect(view.getSelectedText()).toBe('## Section A\r\n\r\nFirst paragraph.');
    });

    it('copies nothing when nothing is selected', () => {
        expect(viewOver(DOC, { cursor: -1 }).getSelectedText()).toBe('');
    });

    // Index 5 on a 5-block document is the "+ Add Block" control. There is no
    // source behind it to copy.
    it('copies nothing from the phantom row', () => {
        expect(viewOver(DOC, { cursor: 5 }).getSelectedText()).toBe('');
    });
});

/* Paste has to agree with copy. Replacing only the cursor's block while the
   highlight covered three would leave the other two sitting under the pasted
   text — a copy that had just claimed to take all three. */
describe('pasting over the selected blocks', () => {
    let view;
    beforeEach(() => {
        view = viewOver(DOC, { cursor: 3, anchor: 1 });
        view.saveBlock = vi.fn();
        view._blockCM = null;
    });

    it('replaces the whole range, not the block under the cursor', () => {
        view.replaceSelectedText('replacement');
        // From block 1, three blocks wide — the range the highlight covered.
        expect(view.saveBlock).toHaveBeenCalledWith(1, 'replacement', 3);
    });

    it('replaces a single block as a single block', () => {
        const one = viewOver(DOC, { cursor: 2 });
        one.saveBlock = vi.fn();
        one._blockCM = null;
        one.replaceSelectedText('x');
        expect(one.saveBlock).toHaveBeenCalledWith(2, 'x', 1);
    });
});

/* Ctrl+C and the right-click menu. The app's copy command looks for `copy()` on
   the active view and falls back to the DOM text selection when there is none —
   and MarkdownView had none, so selecting a block and pressing Ctrl+C copied
   nothing at all. The menu was worse: `document.execCommand('copy')` can ONLY
   see a DOM text selection, so it failed for the same reason and would have
   gone on failing for any view that keeps its own selection. */
describe('the copy commands reach the view', () => {
    const md = read('src/modules/views/MarkdownView.js');
    const editor = read('src/modules/core/Editor.js');

    it('gives the Markdown view the three the command layer looks for', () => {
        for (const fn of ['async copy()', 'async cut()', 'async paste()']) {
            expect(md, fn).toContain(fn);
        }
    });

    it('sends the context menu through the same functions as the keys', () => {
        const menu = editor.slice(editor.indexOf('const menuItems = ['),
            editor.indexOf('Format Document'));
        expect(menu).toContain('triggerCopy()');
        expect(menu).toContain('triggerCut()');
        expect(menu).toContain('triggerPaste()');
        expect(menu).not.toContain('execCommand');
    });

    /* Someone who dragged across three words means the three words. Handing
       them the whole paragraph's Markdown would be a strange answer to a
       precise question — and triggerCopy() deliberately leaves a selection
       inside the editor to the view, so the view is the only thing that can
       get this right. */
    it('prefers a real text selection over the block it sits in', () => {
        const fn = md.slice(md.indexOf('getSelectedText() {'), md.indexOf('_domSelectionText() {'));
        expect(fn).toContain('_domSelectionText()');
        expect(fn.indexOf('_domSelectionText()')).toBeLessThan(fn.indexOf('_sourceOfRange'));
    });
});

/* What the per-block copy button puts on the clipboard. */
describe('what a block copies as', () => {
    /* The SOURCE, because this is a Markdown editor and the source round-trips:
       paste `## Section` back and it is still a heading. The rendered text has
       thrown the level away, along with every list marker, link and emphasis. */
    it('keeps the Markdown, not the rendered text', () => {
        expect(MarkdownView.sourceForCopy('## Section A')).toBe('## Section A');
        expect(MarkdownView.sourceForCopy('- one\n- two')).toBe('- one\n- two');
        expect(MarkdownView.sourceForCopy('a [link](x.md) and **bold**'))
            .toBe('a [link](x.md) and **bold**');
    });

    /* The one exception. A fence's source is the code wrapped in ``` lines and
       nobody has ever wanted those — the code is going into a terminal or
       another file. Every renderer with a copy button on a code block does
       this; doing otherwise would be the surprise. */
    it('takes a code fence without its fence', () => {
        expect(MarkdownView.sourceForCopy('```js\nconst a = 1;\n```')).toBe('const a = 1;');
        expect(MarkdownView.sourceForCopy('```\nplain\n```')).toBe('plain');
        expect(MarkdownView.sourceForCopy('~~~py\nx = 1\n~~~')).toBe('x = 1');
    });

    it('keeps a longer fence and the blank lines inside one', () => {
        expect(MarkdownView.sourceForCopy('````\na\n\nb\n````')).toBe('a\n\nb');
    });

    // A paragraph that MENTIONS a fence is not one.
    it('leaves prose about fences alone', () => {
        const prose = 'Use ``` to open a code block.';
        expect(MarkdownView.sourceForCopy(prose)).toBe(prose);
    });

    it('is empty for an empty block', () => {
        expect(MarkdownView.sourceForCopy('')).toBe('');
        expect(MarkdownView.sourceForCopy(null)).toBe('');
    });
});
