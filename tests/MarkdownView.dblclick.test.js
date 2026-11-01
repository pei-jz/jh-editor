import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A double-click on a rendered Markdown block used to open the block editor.
// Reading view is where people pick a word to copy, and a double-click is how
// a word is picked everywhere else, so it now does only that: the browser's
// word selection. F2 and the pencil still open the block.

const load = async () => {
    const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
    return { MarkdownView };
};

describe('MarkdownView double-click', () => {
    let view;

    beforeEach(async () => {
        const { MarkdownView } = await load();
        document.body.innerHTML = '<div id="host"></div>';
        view = new MarkdownView(document.getElementById('host'), {});
        view.blocksData = ['first block', 'second block'];
        view.container.innerHTML = '';
        view.blocksData.forEach((_, i) => {
            const div = document.createElement('div');
            div.className = 'md-block';
            div.dataset.index = String(i);
            view.container.appendChild(div);
            view._renderBlockInternal(div);
        });
    });

    afterEach(() => { document.body.innerHTML = ''; });

    it('does not open the block editor', () => {
        const enter = vi.spyOn(view, 'enterEditMode').mockImplementation(() => {});
        const div = view.container.querySelector('.md-block');
        const e = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
        div.dispatchEvent(e);
        expect(enter).not.toHaveBeenCalled();
        // Nothing cancels it, so the browser's word selection goes ahead.
        expect(e.defaultPrevented).toBe(false);
    });

    it('F2 (activateBlock) still opens the block, with its own text', () => {
        const enter = vi.spyOn(view, 'enterEditMode').mockImplementation(() => {});
        view.activateBlock(1);
        expect(enter).toHaveBeenCalledTimes(1);
        const [el, text, index] = enter.mock.calls[0];
        expect(el).toBe(view.container.querySelectorAll('.md-block')[1]);
        expect(text).toBe('second block');
        expect(index).toBe(1);
    });
});
