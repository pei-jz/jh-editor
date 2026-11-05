import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// The tree's rows are one fixed height and cut a long name off, so the whole
// name appears over the row while the mouse is on it.

vi.mock('../src/modules/utils/FileSystem.js', async (orig) => {
    const real = await orig();
    return {
        ...real,
        readDirectory: vi.fn(async () => [
            { entry: 'a-name-too-long-for-the-panel', type: 'DIRECTORY' },
            { entry: 'short.md', type: 'FILE' },
        ]),
    };
});

describe('a long name in the tree', () => {
    let list;
    let originalResizeObserver;
    const peek = () => document.querySelector('.tree-name-peek');
    const row = (name) => [...list.querySelectorAll('.tree-item')]
        .find((r) => r.querySelector('.tree-label').textContent === name);
    const hover = (el) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const setWidths = (el, scroll, client) => {
        const label = el.querySelector('.tree-label');
        Object.defineProperty(label, 'scrollWidth', { value: scroll, configurable: true });
        Object.defineProperty(label, 'clientWidth', { value: client, configurable: true });
    };

    beforeAll(async () => {
        originalResizeObserver = global.ResizeObserver;
        global.ResizeObserver = class {
            constructor() { this.observe = vi.fn(); this.unobserve = vi.fn(); this.disconnect = vi.fn(); }
        };
        document.body.innerHTML = `
            <div id="explorer">
                <div id="explorer-files-panel">
                    <input id="explorer-search" type="text" />
                    <div id="file-list"></div>
                </div>
            </div>
        `;
        const { State } = await import('../src/modules/core/Store.js');
        const Explorer = await import('../src/modules/core/Explorer.js');
        await Explorer.initExplorer(vi.fn(), {});
        list = document.getElementById('file-list');
        State.currentDir = 'C:/root';
        await Explorer.loadExplorer(true);
    });

    afterAll(() => {
        global.ResizeObserver = originalResizeObserver;
    });

    beforeEach(() => {
        if (peek()) peek().remove();
    });

    it('shows the whole name when it is cut off', () => {
        const long = row('a-name-too-long-for-the-panel');
        setWidths(long, 300, 100);
        hover(long.querySelector('.tree-label'));
        expect(peek().textContent).toBe('a-name-too-long-for-the-panel');
    });

    it('shows nothing for a name that fits, and takes down the last one', () => {
        const long = row('a-name-too-long-for-the-panel');
        setWidths(long, 300, 100);
        hover(long);
        const short = row('short.md');
        setWidths(short, 50, 100);
        hover(short);
        expect(peek()).toBeNull();
    });

    it('goes away with the mouse', () => {
        const long = row('a-name-too-long-for-the-panel');
        setWidths(long, 300, 100);
        hover(long);
        list.dispatchEvent(new MouseEvent('mouseleave'));
        expect(peek()).toBeNull();
    });
});
