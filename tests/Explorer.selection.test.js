import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// The tree as a file manager: every selected row looks selected, and the keys
// act on the whole selection. Delete used to take only the row under the
// cursor, while the context menu's Delete took them all; and once anything
// had been copied inside the tree, files copied in Explorer could never be
// pasted.

const fsMock = vi.hoisted(() => ({
    trashPaths: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    copyPath: vi.fn(async () => {}),
    movePath: vi.fn(async () => {}),
    pasteFiles: vi.fn(async () => []),
    setClipboardFiles: vi.fn(async () => 7),
    clipboardSequence: vi.fn(async () => 7),
    exists: vi.fn(async () => false),
}));

vi.mock('../src/modules/utils/FileSystem.js', async (orig) => {
    const real = await orig();
    return {
        ...real,
        ...fsMock,
        readDirectory: vi.fn(async (dir) => (/root$/.test(dir)
            ? [{ entry: 'docs', type: 'DIRECTORY' }, { entry: 'a.md', type: 'FILE' },
               { entry: 'b.md', type: 'FILE' }, { entry: 'c.md', type: 'FILE' }]
            : [{ entry: 'inner.md', type: 'FILE' }])),
    };
});

vi.mock('../src/modules/ui/Modal.js', () => ({
    showCustomConfirm: vi.fn(async () => true),
    showCustomInput: vi.fn(async () => null),
    showNewFileModal: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async (cmd) => (cmd === 'path_is_dir' ? false : null)),
}));

describe('explorer selection', () => {
    let Explorer;
    let State;
    let list;
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
        list = document.getElementById('file-list');
        ({ State } = await import('../src/modules/core/Store.js'));
        Explorer = await import('../src/modules/core/Explorer.js');
        await Explorer.initExplorer(() => {}, {});
    });

    afterAll(() => {
        global.ResizeObserver = originalResizeObserver;
        document.body.innerHTML = '';
    });

    beforeEach(async () => {
        Object.values(fsMock).forEach((f) => f.mockClear());
        State.currentDir = 'C:/root';
        State.expandedFolders = new Set();
        await Explorer.loadExplorer(true);
        // Plain click on a file opens nothing interesting here; it resets the selection.
        click('a.md');
    });

    const row = (name) => [...document.querySelectorAll('#file-list .tree-label')]
        .find((l) => l.textContent === name).parentElement;
    const click = (name, opts = {}) => row(name).dispatchEvent(new MouseEvent('click', { bubbles: true, ...opts }));
    const key = (k, opts = {}) => list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
    const selected = () => [...document.querySelectorAll('#file-list .tree-item.selected .tree-label')].map((l) => l.textContent);
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it('marks every Ctrl+clicked row as selected, not only the last', () => {
        click('c.md', { ctrlKey: true });
        expect(selected()).toEqual(['a.md', 'c.md']);
    });

    it('selects a range with Shift+click', () => {
        click('c.md', { shiftKey: true });
        expect(selected()).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('extends the selection with Shift+arrow and moves it with a plain arrow', () => {
        key('ArrowDown', { shiftKey: true });
        expect(selected()).toEqual(['a.md', 'b.md']);
        key('ArrowDown');
        expect(selected()).toEqual(['c.md']);
    });

    it('Delete sends the whole selection to the Recycle Bin', async () => {
        click('b.md', { ctrlKey: true });
        key('Delete');
        await settle();
        expect(fsMock.trashPaths).toHaveBeenCalledWith(['C:/root/a.md', 'C:/root/b.md']);
        expect(fsMock.removeFile).not.toHaveBeenCalled();
    });

    it('Shift+Delete deletes for good instead', async () => {
        key('Delete', { shiftKey: true });
        await settle();
        expect(fsMock.removeFile).toHaveBeenCalledWith('C:/root/a.md');
        expect(fsMock.trashPaths).not.toHaveBeenCalled();
    });

    it('Ctrl+A selects every row', () => {
        key('a', { ctrlKey: true });
        expect(selected()).toEqual(['docs', 'a.md', 'b.md', 'c.md']);
    });

    it('pastes our own copy while it is still the latest thing on the clipboard', async () => {
        key('c', { ctrlKey: true });
        await settle();
        expect(fsMock.setClipboardFiles).toHaveBeenCalledWith(['C:/root/a.md']);
        key('v', { ctrlKey: true });
        await settle();
        expect(fsMock.pasteFiles).not.toHaveBeenCalled();
        expect(fsMock.copyPath).toHaveBeenCalledWith('C:/root/a.md', 'C:/root/a.md');
    });

    it('pastes files copied in Explorer afterwards, not the older copy from the tree', async () => {
        key('c', { ctrlKey: true });
        await settle();
        fsMock.clipboardSequence.mockResolvedValueOnce(8); // something newer was copied
        fsMock.pasteFiles.mockResolvedValueOnce(['D:\\outside\\photo.png']);
        key('v', { ctrlKey: true });
        await settle();
        expect(fsMock.copyPath).toHaveBeenCalledWith('D:/outside/photo.png', 'C:/root/photo.png');
    });
});

describe('explorer path helpers', () => {
    let Explorer;
    beforeAll(async () => {
        Explorer = await import('../src/modules/core/Explorer.js');
    });

    it('drops paths that sit inside another selected folder', () => {
        expect(Explorer.outermostPaths(['C:/r/docs', 'C:/r/docs/x.md', 'C:/r/a.md', 'C:/r/a.md']))
            .toEqual(['C:/r/docs', 'C:/r/a.md']);
        // A shared prefix is not nesting.
        expect(Explorer.outermostPaths(['C:/r/doc', 'C:/r/docs'])).toEqual(['C:/r/doc', 'C:/r/docs']);
    });

    it('names a copy so nothing is overwritten', async () => {
        const taken = new Set(['C:/r/a.md', 'C:/r/a copy.md', 'C:/r/v1.0']);
        const exists = async (p) => taken.has(p);
        expect(await Explorer.freeCopyName('C:/r', 'b.md', false, exists)).toBe('b.md');
        expect(await Explorer.freeCopyName('C:/r', 'a.md', false, exists)).toBe('a copy 2.md');
        // A folder's dot is not an extension.
        expect(await Explorer.freeCopyName('C:/r', 'v1.0', true, exists)).toBe('v1.0 copy');
    });
});
