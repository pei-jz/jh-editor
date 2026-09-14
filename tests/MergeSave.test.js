import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Saving a comparison tab: each edited side goes to its own target — a file
   on disk (with its encoding and line endings), an open tab (through that
   tab's own save), or a callback — and a read-only side is never written. */

const writeFile = vi.fn(async () => {});
const readFileWithEncoding = vi.fn(async () => ({ content: '' }));
const showConfirm = vi.fn(async () => true);
const showDialog = vi.fn(async () => 'cancel');

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(async () => null), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn(), watch: vi.fn(async () => () => {}) }));
vi.mock('../src/modules/utils/FileSystem.js', async (orig) => ({
    ...await orig(),
    writeFile: (...a) => writeFile(...a),
    readFileWithEncoding: (...a) => readFileWithEncoding(...a),
    readFileText: vi.fn(async () => null),
    getFileStats: vi.fn(async () => null),
}));
vi.mock('../src/modules/ui/Dialog.js', () => ({
    showAlert: vi.fn(async () => true),
    showConfirm: (...a) => showConfirm(...a),
    showDialog: (...a) => showDialog(...a),
}));
vi.mock('../src/modules/core/Explorer.js', async (orig) => ({
    ...await orig(),
    loadExplorer: vi.fn(async () => {}),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
document.body.innerHTML = '<div id="tab-bar"><div id="tabs-container"></div><button id="new-tab-btn"></button></div>';

const { openMergeTab, saveFile, closeTab, closeAllTabs } = await import('../src/modules/core/Editor.js');
const { State } = await import('../src/modules/core/Store.js');
const { markSaved } = await import('../src/modules/utils/DirtyState.js');

const custom = vi.fn(async () => {});

/** What the view does on an edit: change the side's text, mark the tab. */
function edit(tab, key, text) {
    tab.merge[key].text = text;
    tab.isDirty = true;
}

beforeEach(() => {
    writeFile.mockReset().mockResolvedValue(undefined);
    readFileWithEncoding.mockReset().mockResolvedValue({ content: '' });
    showConfirm.mockReset().mockResolvedValue(true);
    showDialog.mockReset().mockResolvedValue('cancel');
    custom.mockReset();
    State.splitMode = false;
    State.activePane = 'left';
    State.openFiles = [];
    State.activeTabIndex = -1;
    State.rightOpenFiles = [];
    State.rightActiveTabIndex = -1;
});

describe('saving a comparison', () => {
    it('writes a file side with the encoding and line endings it was read with', async () => {
        readFileWithEncoding.mockResolvedValue({ content: 'x\r\ny' }); // unchanged on disk
        const tab = openMergeTab({
            id: 't1', title: 'T', path: 'C:/p/a.txt',
            left: { label: 'L', text: 'x\r\ny', writable: true,
                target: { kind: 'path', path: 'C:/p/a.txt', encoding: 'Shift_JIS', eol: '\r\n' } },
            right: { label: 'R', text: 'x\nY' },
        });
        edit(tab, 'left', 'x\nY');

        await expect(saveFile(tab)).resolves.toBe(true);
        expect(writeFile).toHaveBeenCalledTimes(1);
        expect(writeFile).toHaveBeenCalledWith('C:/p/a.txt', 'x\r\nY', 'Shift_JIS');
        expect(tab.isDirty).toBe(false);
    });

    it('asks before overwriting a file that changed on disk since the comparison read it', async () => {
        readFileWithEncoding.mockResolvedValue({ content: 'someone else wrote this' });
        showConfirm.mockResolvedValue(false);
        const tab = openMergeTab({
            id: 't2', title: 'T', path: 'C:/p/a.txt',
            left: { label: 'L', text: 'old', writable: true, target: { kind: 'path', path: 'C:/p/a.txt' } },
            right: { label: 'R', text: 'new' },
        });
        edit(tab, 'left', 'new');

        await expect(saveFile(tab)).resolves.toBe(false);
        expect(showConfirm).toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(tab.isDirty).toBe(true);
    });

    it('saves an open tab through that tab, with its own encoding and line endings', async () => {
        const buffer = { path: 'C:/p/b.txt', name: 'b.txt', content: 'one\ntwo', encoding: 'UTF-8', eol: '\r\n', isDirty: false };
        markSaved(buffer);
        State.openFiles = [buffer];
        State.activeTabIndex = 0;
        const tab = openMergeTab({
            id: 't3', title: 'T', path: buffer.path,
            left: { label: 'disk', text: 'one\ntwo' },
            right: { label: 'tab', text: buffer.content, writable: true, target: { kind: 'buffer', file: buffer } },
        });
        edit(tab, 'right', 'one\nTWO');

        await expect(saveFile(tab)).resolves.toBe(true);
        expect(buffer.content).toBe('one\nTWO');
        expect(buffer.isDirty).toBe(false);
        expect(writeFile).toHaveBeenCalledWith('C:/p/b.txt', 'one\r\nTWO', 'UTF-8');
    });

    it('does not silently replace edits made in the tab after the comparison opened', async () => {
        const buffer = { path: 'C:/p/c.txt', name: 'c.txt', content: 'base', encoding: 'UTF-8', eol: '\n', isDirty: false };
        State.openFiles = [buffer];
        State.activeTabIndex = 0;
        const tab = openMergeTab({
            id: 't4', title: 'T', path: buffer.path,
            left: { label: 'disk', text: 'base' },
            right: { label: 'tab', text: 'base', writable: true, target: { kind: 'buffer', file: buffer } },
        });
        buffer.content = 'typed in the tab meanwhile';
        edit(tab, 'right', 'from the comparison');
        showConfirm.mockResolvedValue(false);

        await expect(saveFile(tab)).resolves.toBe(false);
        expect(buffer.content).toBe('typed in the tab meanwhile');
        expect(writeFile).not.toHaveBeenCalled();
    });

    it('routes a file side through its tab when that file is open', async () => {
        const buffer = { path: 'C:/p/d.txt', name: 'd.txt', content: 'v1', encoding: 'UTF-8', eol: '\n', isDirty: false };
        State.openFiles = [buffer];
        State.activeTabIndex = 0;
        const tab = openMergeTab({
            id: 't5', title: 'T', path: buffer.path,
            left: { label: 'L', text: 'v1', writable: true, target: { kind: 'path', path: 'C:\\p\\d.txt' } },
            right: { label: 'R', text: 'v2' },
        });
        edit(tab, 'left', 'v2');

        await expect(saveFile(tab)).resolves.toBe(true);
        expect(buffer.content).toBe('v2');
        expect(readFileWithEncoding).not.toHaveBeenCalled();
    });

    it('hands a custom side its text, and never writes a read-only side', async () => {
        const tab = openMergeTab({
            id: 't6', title: 'T', path: 'a.js',
            left: { label: 'code', text: 'a', writable: true, target: { kind: 'custom', save: custom } },
            right: { label: 'suggestion', text: 'b' },
        });
        edit(tab, 'left', 'b');
        tab.merge.right.text = 'changed anyway';

        await expect(saveFile(tab)).resolves.toBe(true);
        expect(custom).toHaveBeenCalledWith('b');
        expect(writeFile).not.toHaveBeenCalled();
    });

    it('reopening the same comparison keeps unsaved edits in it', () => {
        const spec = {
            id: 't7', title: 'T', path: 'a.js',
            left: { label: 'L', text: 'a', writable: true, target: { kind: 'custom', save: custom } },
            right: { label: 'R', text: 'b' },
        };
        const tab = openMergeTab(spec);
        edit(tab, 'left', 'mine');
        const again = openMergeTab({ ...spec, left: { ...spec.left, text: 'fresh' } });
        expect(again).toBe(tab);
        expect(tab.merge.left.text).toBe('mine');
    });
});

describe('closing a comparison with unsaved edits', () => {
    it('asks, like any other unsaved tab', async () => {
        const tab = openMergeTab({
            id: 'c1', title: 'T', path: 'a.js',
            left: { label: 'L', text: 'a', writable: true, target: { kind: 'custom', save: custom } },
            right: { label: 'R', text: 'b' },
        });
        edit(tab, 'left', 'b');
        await closeTab(State.openFiles.indexOf(tab), 'left');
        expect(showDialog).toHaveBeenCalled();
        expect(State.openFiles).toContain(tab);
    });

    it('is saved by Close All (Save)', async () => {
        const tab = openMergeTab({
            id: 'c2', title: 'T', path: 'a.js',
            left: { label: 'L', text: 'a', writable: true, target: { kind: 'custom', save: custom } },
            right: { label: 'R', text: 'b' },
        });
        edit(tab, 'left', 'b');
        await expect(closeAllTabs(true)).resolves.toBe(true);
        expect(custom).toHaveBeenCalledWith('b');
    });
});
