import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// Files open on a single click. A folder used to toggle on a single click as
// well, so selecting one to copy or rename opened and closed it; now a single
// click selects it and a double-click (Enter, ← / →, the chevron) toggles it.
// A setting puts the single-click toggle back.

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

    it('opens a file on a single click', () => {
        click('a.md');
        expect(opened).toHaveBeenCalledTimes(1);
        expect(opened).toHaveBeenCalledWith('C:/root/a.md');
        expect(row('a.md').classList.contains('selected')).toBe(true);
    });

    it('leaves a folder closed on a single click and opens it on a double click', async () => {
        click('docs');
        await flush();
        expect(State.expandedFolders.has('C:/root/docs')).toBe(false);
        expect(row('docs').classList.contains('selected')).toBe(true);
        click('docs');
        await flush();
        expect(State.expandedFolders.has('C:/root/docs')).toBe(true);
    });

    it('does not toggle when the two clicks are on different rows', async () => {
        click('a.md');
        click('docs');
        await flush();
        expect(State.expandedFolders.has('C:/root/docs')).toBe(false);
    });

    it('toggles a folder on a single click when the setting says so', async () => {
        setExplorerOpensOn('single');
        click('docs');
        await flush();
        expect(State.expandedFolders.has('C:/root/docs')).toBe(true);
    });
});
