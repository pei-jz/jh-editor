import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// F2 used to open a table in a grid of its own, beside a second copy of the
// same table as the preview. Tables are edited in the view now (click a cell,
// select a range, right-click for rows and columns), so F2 opens a table the
// way it opens every other block: its Markdown source, with the preview.

const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |';

describe('a table in the block editor', () => {
    let MarkdownView, EL, view;

    beforeAll(async () => {
        const module = { exports: {} };
        new Function('module', 'exports', readFileSync('public/lib/marked.min.js', 'utf8'))(module, module.exports);
        globalThis.marked = module.exports.marked || module.exports;
        ({ EL } = await import('../src/modules/core/Constants.js'));
        ({ MarkdownView } = await import('../src/modules/views/MarkdownView.js'));
    });

    beforeEach(() => {
        document.body.innerHTML = '<div id="host"></div>'
            + '<div id="preview-modal"><span class="close-preview"></span><div id="preview-content"></div></div>';
        // Constants.js looks these up once, when it is first imported.
        EL.previewModal.overlay = document.getElementById('preview-modal');
        EL.previewModal.content = document.getElementById('preview-content');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    const open = (text) => {
        const file = { path: 'C:/t/doc.md', name: 'doc.md', content: text, savedContent: text };
        view = new MarkdownView(document.getElementById('host'), {});
        view.file = file;
        view.blocksData = [text];
        const block = document.createElement('div');
        block.className = 'md-block';
        block.dataset.index = '0';
        document.getElementById('host').appendChild(block);
        view.enterEditMode(block, text, 0);
    };

    it('opens as its Markdown source, with the format toolbar', () => {
        open(TABLE);
        expect(view._blockCM.state.doc.toString()).toBe(TABLE);
        expect(document.querySelector('.editor-toolbar').style.display).toBe('flex');
        expect(document.querySelector('.block-cm').style.display).toBe('');
    });

    it('has no grid and no switch to one', () => {
        open(TABLE);
        expect(document.querySelector('.visual-table-editor')).toBeNull();
        expect(document.querySelector('.toggle-mode-btn')).toBeNull();
    });

    it('shows the table in the preview beside the source', () => {
        open(TABLE);
        expect(document.querySelector('.mbe-box .mbe-right table')).not.toBeNull();
    });

    it('still lets the layout key turn the preview below the source', () => {
        open(TABLE);
        const before = document.querySelector('.mbe-body').classList.contains('mbe-vertical');
        view._toggleEditLayout();
        expect(document.querySelector('.mbe-body').classList.contains('mbe-vertical')).toBe(!before);
    });
});
