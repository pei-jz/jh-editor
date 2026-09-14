import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Close All (Save), quit and "Save and close" all save buffers that are not
   necessarily the one in front. They used to write file.content raw (LF, the
   default encoding), or front the tab by index without switching the pane. */

const writeFile = vi.fn(async () => {});
const invoke = vi.fn(async () => null);
const showAlert = vi.fn(async () => true);
const showDialog = vi.fn(async () => 'save');
const saveDialog = vi.fn(async () => null);

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...a) => saveDialog(...a), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn(), watch: vi.fn(async () => () => {}) }));
vi.mock('../src/modules/utils/FileSystem.js', async (orig) => ({
    ...await orig(),
    writeFile: (...a) => writeFile(...a),
    getFileStats: vi.fn(async () => null),
    readFileText: vi.fn(async () => null),
}));
vi.mock('../src/modules/ui/Dialog.js', () => ({
    showAlert: (...a) => showAlert(...a),
    showConfirm: vi.fn(async () => true),
    showDialog: (...a) => showDialog(...a),
}));
vi.mock('../src/modules/core/Explorer.js', async (orig) => ({
    ...await orig(),
    loadExplorer: vi.fn(async () => {}),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
document.body.innerHTML = '<div id="tab-bar"><div id="tabs-container"></div><button id="new-tab-btn"></button></div>';

const { closeAllTabs, closeTab } = await import('../src/modules/core/Editor.js');
const { State } = await import('../src/modules/core/Store.js');
const { makeSide } = await import('../src/modules/utils/MergeSides.js');

const doc = (name, over = {}) => ({
    path: `C:/proj/${name}`, name, content: 'a\nb', encoding: 'UTF-8', eol: '\n',
    isDirty: true, stats: { size: 3, mtime: 0 }, ...over,
});

beforeEach(() => {
    writeFile.mockReset().mockResolvedValue(undefined);
    invoke.mockReset().mockResolvedValue(null);
    showAlert.mockClear();
    showDialog.mockReset().mockResolvedValue('save');
    saveDialog.mockReset().mockResolvedValue(null);
    State.splitMode = false;
    State.activePane = 'left';
    State.openFiles = [];
    State.activeTabIndex = -1;
    State.rightOpenFiles = [];
    State.rightActiveTabIndex = -1;
});

describe('Close All (Save)', () => {
    it("writes each file with its own line ending and encoding", async () => {
        const sjis = doc('sjis.txt', { eol: '\r\n', encoding: 'Shift_JIS' });
        const clean = doc('clean.txt', { isDirty: false });
        State.openFiles = [sjis, clean];
        State.activeTabIndex = 1;

        await expect(closeAllTabs(true)).resolves.toBe(true);
        expect(writeFile).toHaveBeenCalledTimes(1);
        expect(writeFile).toHaveBeenCalledWith('C:/proj/sjis.txt', 'a\r\nb', 'Shift_JIS');
        expect(State.openFiles).toEqual([]);
    });

    it('does not write diff tabs as if "diff://" were a path', async () => {
        // A read-only comparison: nothing in it can be saved, so it just closes.
        const diff = {
            path: 'diff://C:/proj/a.txt', name: 'Diff: a.txt', type: 'diff', content: '', isDirty: true,
            merge: { title: 'Diff: a.txt', path: 'C:/proj/a.txt', left: makeSide({ text: 'a' }), right: makeSide({ text: 'b' }) },
        };
        State.openFiles = [diff];
        State.activeTabIndex = 0;

        await expect(closeAllTabs(true)).resolves.toBe(true);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it('closes nothing when an untitled buffer is not given a location', async () => {
        const named = doc('a.txt');
        const untitled = { name: 'Untitled.txt', path: null, content: 'draft', isDirty: true };
        State.openFiles = [untitled, named];
        State.activeTabIndex = 0;

        await expect(closeAllTabs(true)).resolves.toBe(false);
        // Buffers that need no dialog are written first either way.
        expect(writeFile).toHaveBeenCalledWith('C:/proj/a.txt', 'a\nb', 'UTF-8');
        expect(saveDialog).toHaveBeenCalled();
        expect(State.openFiles).toEqual([untitled, named]);
        expect(untitled.isDirty).toBe(true);
        expect(showAlert).toHaveBeenCalled();
    });

    it('closes nothing when a write fails', async () => {
        writeFile.mockRejectedValueOnce(new Error('EACCES'));
        const f = doc('locked.txt');
        State.openFiles = [f];
        State.activeTabIndex = 0;

        await expect(closeAllTabs(true)).resolves.toBe(false);
        expect(State.openFiles).toEqual([f]);
        expect(f.isDirty).toBe(true);
    });

    it('does not count a failed rope-backed save as saved', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'editable_save') throw new Error('disk full');
            return null;
        });
        const huge = doc('huge.log', { isEditing: true, editId: 7, content: '' });
        State.openFiles = [huge];
        State.activeTabIndex = -1; // not in front: no view to delegate to

        await expect(closeAllTabs(true)).resolves.toBe(false);
        expect(huge.isDirty).toBe(true);
        expect(State.openFiles).toEqual([huge]);
    });

    it('saves a buffer open in both panes once', async () => {
        const shared = doc('shared.txt');
        State.openFiles = [shared];
        State.rightOpenFiles = [shared];

        await expect(closeAllTabs(true)).resolves.toBe(true);
        expect(writeFile).toHaveBeenCalledTimes(1);
    });
});

describe('Save and close on a tab in the other pane', () => {
    it('saves that tab, not the one in the focused pane', async () => {
        const left = doc('left.txt');
        const right = doc('right.txt', { content: 'r' });
        const front = doc('front.txt', { isDirty: false });
        State.splitMode = true;
        State.activePane = 'left';
        State.openFiles = [left];
        State.activeTabIndex = 0;
        State.rightOpenFiles = [right, front];
        State.rightActiveTabIndex = 1;

        await closeTab(0, 'right');
        expect(writeFile).toHaveBeenCalledTimes(1);
        expect(writeFile).toHaveBeenCalledWith('C:/proj/right.txt', 'r', 'UTF-8');
        expect(State.rightOpenFiles).toEqual([front]);
        expect(left.isDirty).toBe(true);
    });
});
