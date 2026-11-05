import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// The table editor shows its cells formatted, so a preview beside it was the
// same table twice, and hard to tell which one was being edited.

const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |';

describe('the preview in the block editor', () => {
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
    const box = () => document.querySelector('.mbe-box');
    const hidden = () => box().classList.contains('mbe-no-preview');
    const toggle = () => document.querySelector('.toggle-mode-btn').click();

    it('is hidden while a table is edited as a table', () => {
        open(TABLE);
        expect(hidden()).toBe(true);
        expect(document.querySelector('.visual-table-editor')).not.toBeNull();
    });

    it('is shown for any other block', () => {
        open('just a paragraph');
        expect(hidden()).toBe(false);
    });

    it('comes and goes with the switch between table and text', () => {
        open(TABLE);
        toggle();
        expect(hidden()).toBe(false);
        toggle();
        expect(hidden()).toBe(true);
    });

    it('stays when text that is not a table cannot switch to the table editor', () => {
        open('just a paragraph');
        toggle();
        expect(hidden()).toBe(false);
    });

    it('brings the format toolbar along when the button switches modes', () => {
        open(TABLE);
        const toolbar = document.querySelector('.editor-toolbar');
        expect(toolbar.style.display).toBe('none');
        toggle();
        expect(toolbar.style.display).toBe('flex');
        toggle();
        expect(toolbar.style.display).toBe('none');
    });

    it('does not let the layout key change the hidden layout', () => {
        open(TABLE);
        const before = document.querySelector('.mbe-body').classList.contains('mbe-vertical');
        view._toggleEditLayout();
        expect(document.querySelector('.mbe-body').classList.contains('mbe-vertical')).toBe(before);
    });
});
