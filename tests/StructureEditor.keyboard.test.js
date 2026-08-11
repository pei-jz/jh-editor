import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StructureEditor } from '../src/modules/editors/StructureEditor.js';

// The tree's keydown listener is bound on its own root element, so it only
// fires once focus is inside the tree. Opening a JSON/XML file from the
// explorer or by clicking its tab leaves focus on the explorer row / tab strip
// / <body>, which made every arrow key a no-op. Two things fix that and are
// pinned here: mount() takes focus, and a window-level capture handler picks up
// the keys focus never delivered — while leaving them to whoever legitimately
// owns them (explorer, source editor, inputs).

describe('StructureEditor keyboard navigation', () => {
    let editor;
    let container;
    let offsetParentSpy;

    const model = () => ({
        id: 'root',
        type: 'root',
        key: 'root',
        children: [
            { id: 'a', type: 'property', key: 'alpha', value: '1' },
            { id: 'b', type: 'property', key: 'beta', value: '2' },
            { id: 'c', type: 'property', key: 'gamma', value: '3' }
        ]
    });

    beforeEach(() => {
        vi.useFakeTimers();
        // jsdom has no layout, so offsetParent is always null — the visibility
        // guard would reject every key. Report the elements as visible.
        offsetParentSpy = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get')
            .mockReturnValue(document.body);

        document.body.innerHTML = '<div id="explorer"><div id="file-list"></div></div><div id="host"></div>';
        container = document.getElementById('host');
        editor = new StructureEditor(container, model(), () => {}, () => {});
        editor.mount();
        editor.state.expandedNodes.add('root');
        editor.render();
    });

    afterEach(() => {
        editor.destroy();
        vi.useRealTimers();
        offsetParentSpy.mockRestore();
        document.body.innerHTML = '';
    });

    const press = (key, target = document.body) => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    };

    it('focuses the tree on mount so arrow keys work without clicking first', () => {
        vi.advanceTimersByTime(60);
        expect(document.activeElement).toBe(editor.elements.root);
    });

    it('does not steal focus from the explorer', () => {
        const row = document.getElementById('file-list');
        row.tabIndex = 0;
        row.focus();
        editor.focus();
        vi.advanceTimersByTime(60);
        expect(document.activeElement).toBe(row);
    });

    it('moves the selection on ArrowDown even when focus is outside the tree', () => {
        document.body.focus();
        press('ArrowDown');
        expect(editor.state.selectedNodeId).toBe('root');
        press('ArrowDown');
        expect(editor.state.selectedNodeId).toBe('a');
        press('ArrowUp');
        expect(editor.state.selectedNodeId).toBe('root');
    });

    it('collapses / expands with the left and right arrows', async () => {
        editor.state.selectedNodeId = 'root';
        press('ArrowLeft');
        // toggleExpand defers through rAF + a timer so the row can repaint.
        await vi.advanceTimersByTimeAsync(50);
        expect(editor.state.expandedNodes.has('root')).toBe(false);

        press('ArrowRight');
        await vi.advanceTimersByTimeAsync(50);
        expect(editor.state.expandedNodes.has('root')).toBe(true);
    });

    it('leaves the keys alone when the explorer owns them', () => {
        editor.state.selectedNodeId = 'a';
        press('ArrowDown', document.getElementById('file-list'));
        expect(editor.state.selectedNodeId).toBe('a');

        const stamped = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        stamped.__explorerKeyDown = true;
        document.body.dispatchEvent(stamped);
        expect(editor.state.selectedNodeId).toBe('a');
    });

    it('leaves the keys alone while the source editor or an input has them', () => {
        editor.state.selectedNodeId = 'a';

        const cm = document.createElement('div');
        cm.className = 'cm-editor';
        document.body.appendChild(cm);
        press('ArrowDown', cm);
        expect(editor.state.selectedNodeId).toBe('a');

        const input = document.createElement('input');
        document.body.appendChild(input);
        press('ArrowDown', input);
        expect(editor.state.selectedNodeId).toBe('a');
    });

    it('stops listening once destroyed', () => {
        editor.state.selectedNodeId = 'a';
        editor.destroy();
        expect(() => press('ArrowDown')).not.toThrow();
    });

    it('scrolls the virtualized viewport so the new row stays on screen', () => {
        // 3 children + root = 4 rows of 35px; pretend only one row fits.
        const vp = editor.elements.viewport;
        Object.defineProperty(vp, 'clientHeight', { value: 35, configurable: true });
        editor.state.selectedNodeId = 'root';
        press('ArrowDown'); // → 'a', row 1, below the fold
        expect(editor.state.selectedNodeId).toBe('a');
        expect(vp.scrollTop).toBe(35);
    });
});
