import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// A single click in the explorer used to open the file (or toggle the folder)
// as well as select it, so picking a file to copy or rename opened it too.
// Now a single click selects; double-click, Enter or → opens. A setting puts
// the old single-click behaviour back.

vi.mock('../src/modules/utils/FileSystem.js', async (orig) => {
    const real = await orig();
    return {
        ...real,
        readDirectory: vi.fn(async (dir) => (/root$/.test(dir)
            ? [{ entry: 'docs', type: 'DIRECTORY' }, { entry: 'a.md', type: 'FILE' }, { entry: 'b.md', type: 'FILE' }]
            : [{ entry: 'inner.md', type: 'FILE' }])),
    };
});

describe('explorer clicks', () => {
    let Explorer;
    let State;
    let setExplorerOpensOn;
    const opened = vi.fn();
    let originalResizeObserver;

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
        ({ State } = await import('../src/modules/core/Store.js'));
        ({ setExplorerOpensOn } = await import('../src/modules/utils/ExplorerPrefs.js'));
        Explorer = await import('../src/modules/core/Explorer.js');
        await Explorer.initExplorer(opened, {});
    });

    afterAll(() => {
        global.ResizeObserver = originalResizeObserver;
        document.body.innerHTML = '';
    });

    beforeEach(async () => {
        vi.useRealTimers();
        localStorage.clear();
        opened.mockClear();
        State.currentDir = 'C:/root';
        State.expandedFolders = new Set();
        await Explorer.loadExplorer(true);
        // Let the previous test's last click fall out of the double-click window.
        await new Promise((r) => setTimeout(r, 450));
    });

    const row = (name) => [...document.querySelectorAll('#file-list .tree-label')]
        .find((l) => l.textContent === name).parentElement;
    const click = (name) => row(name).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('selects on a single click without opening', () => {
        click('a.md');
        expect(opened).not.toHaveBeenCalled();
        expect(row('a.md').classList.contains('selected')).toBe(true);
    });

    it('opens on a double click', () => {
        click('a.md');
        click('a.md');
        expect(opened).toHaveBeenCalledWith('C:/root/a.md');
    });

    it('does not open when the two clicks are on different rows', () => {
        click('a.md');
        click('b.md');
        expect(opened).not.toHaveBeenCalled();
    });

    it('leaves a folder closed on a single click and opens it on a double click', async () => {
        click('docs');
        await flush();
        expect(State.expandedFolders.has('C:/root/docs')).toBe(false);
        click('docs');
        await flush();
        expect(State.expandedFolders.has('C:/root/docs')).toBe(true);
    });

    it('opens on a single click when the setting says so', () => {
        setExplorerOpensOn('single');
        click('b.md');
        expect(opened).toHaveBeenCalledWith('C:/root/b.md');
    });
});
