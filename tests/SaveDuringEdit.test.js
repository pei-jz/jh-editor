import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Saving no longer freezes the window, so the user can keep typing while a
 * write is on its way to the disk. These pin down what that must not cost:
 * text typed during a save is not marked as saved, two saves of one file do
 * not overlap, and a file with undecodable bytes is not rewritten unasked.
 */

const writeFile = vi.fn();
const getFileStats = vi.fn(async () => ({ size: 1, mtime: 1000 }));
const showConfirm = vi.fn(async () => true);

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn(), watch: vi.fn(async () => () => {}) }));
vi.mock('../src/modules/utils/FileSystem.js', async (orig) => ({
    ...await orig(),
    writeFile: (...a) => writeFile(...a),
    getFileStats: (...a) => getFileStats(...a),
}));
vi.mock('../src/modules/ui/Dialog.js', () => ({
    showAlert: vi.fn(async () => true),
    showConfirm: (...a) => showConfirm(...a),
    showDialog: vi.fn(async () => 'cancel'),
}));

// The tab bar exists before Editor.js reads its elements, as in the app.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
document.body.innerHTML = '<div id="tab-bar"><div id="tabs-container"></div><button id="new-tab-btn"></button></div>';

const { saveFile } = await import('../src/modules/core/Editor.js');

const fileWith = (content) => ({
    path: 'C:/proj/notes.md', name: 'notes.md', content, encoding: 'UTF-8', eol: '\n',
    isDirty: true, stats: { size: 1, mtime: 1000 },
});

/** A write that finishes only when told to. */
const heldWrite = () => {
    let release;
    writeFile.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    return () => release();
};

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    writeFile.mockReset();
    writeFile.mockImplementation(async () => {});
    showConfirm.mockReset();
    showConfirm.mockImplementation(async () => true);
});

describe('saving while the user keeps typing', () => {
    it('marks the file saved when nothing changed during the write', async () => {
        const file = fileWith('hello');
        expect(await saveFile(file, null, { refresh: false })).toBe(true);
        expect(file.isDirty).toBe(false);
        expect(file.savedContent).toBe('hello');
    });

    it('keeps text typed during the write dirty — it is not on disk', async () => {
        const file = fileWith('version 1');
        const release = heldWrite();
        const saving = saveFile(file, null, { refresh: false });
        await tick();
        expect(writeFile).toHaveBeenCalledWith('C:/proj/notes.md', 'version 1', 'UTF-8');

        file.content = 'version 1, and more';   // typed while the disk was busy
        release();
        await saving;

        expect(file.isDirty).toBe(true);
        expect(file.savedContent).toBe('version 1');
    });

    it('runs a second save of the same file only after the first has landed', async () => {
        const file = fileWith('first');
        const release = heldWrite();
        const a = saveFile(file, null, { refresh: false });
        await tick();
        file.content = 'second';
        const b = saveFile(file, null, { refresh: false });
        await tick();
        expect(writeFile).toHaveBeenCalledTimes(1);

        release();
        await Promise.all([a, b]);
        expect(writeFile).toHaveBeenCalledTimes(2);
        expect(writeFile.mock.calls[1][1]).toBe('second');
        expect(file.isDirty).toBe(false);
    });
});

describe('a file that did not decode cleanly', () => {
    it('asks before writing replacement characters, and writes nothing on cancel', async () => {
        const file = fileWith('caf\uFFFD');
        file.decodeLossy = true;
        showConfirm.mockImplementationOnce(async () => false);
        expect(await saveFile(file, null, { refresh: false })).toBe(false);
        expect(writeFile).not.toHaveBeenCalled();
        expect(file.isDirty).toBe(true);
    });

    it('asks only once per open', async () => {
        const file = fileWith('caf\uFFFD');
        file.decodeLossy = true;
        await saveFile(file, null, { refresh: false });
        file.content = 'caf\uFFFD!';
        await saveFile(file, null, { refresh: false });
        expect(showConfirm).toHaveBeenCalledTimes(1);
        expect(writeFile).toHaveBeenCalledTimes(2);
    });
});
