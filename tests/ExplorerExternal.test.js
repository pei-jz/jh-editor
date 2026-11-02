import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Files the editor has no view for used to be dropped from the tree. They can be
// listed now, and go to the OS's default app — which for a program means running
// it, so programs are listed and never launched.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(repo, ...p), 'utf8').replace(/\r\n/g, '\n');

const dialog = vi.hoisted(() => ({ showDialog: vi.fn(async () => false), showAlert: vi.fn(async () => {}) }));
const search = vi.hoisted(() => ({
    searchFiles: vi.fn(async () => [
        { entry: 'a.md', type: 'FILE', path: 'C:/root/a.md' },
        { entry: 'photo.png', type: 'FILE', path: 'C:/root/photo.png' },
    ]),
}));

vi.mock('../src/modules/utils/FileSystem.js', async (orig) => {
    const real = await orig();
    return {
        ...real,
        ...search,
        onSearchProgress: vi.fn(async () => () => {}),
        readDirectory: vi.fn(async () => [
            { entry: 'pics.zip', type: 'DIRECTORY' },
            { entry: 'a.md', type: 'FILE' },
            { entry: 'b.md', type: 'FILE' },
            { entry: 'photo.png', type: 'FILE' },
            { entry: 'setup.exe', type: 'FILE' },
        ]),
    };
});

vi.mock('../src/modules/ui/Dialog.js', () => dialog);

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

describe('what counts as external', () => {
    let externalKind;
    beforeAll(async () => {
        ({ externalKind } = await import('../src/modules/utils/ExternalFiles.js'));
    });

    it('sorts viewers from programs, in any case', () => {
        expect(externalKind('a.PNG')).toBe('open');
        expect(externalKind('a.pdf')).toBe('open');
        expect(externalKind('a.exe')).toBe('program');
        expect(externalKind('report.pdf.exe')).toBe('program');
        expect(externalKind('tool.jar')).toBe('program');
    });

    it('leaves to the editor what the editor opens', () => {
        for (const name of ['a.md', 'run.bat', 'run.ps1', 'book.xlsx', 'deck.pptx', 'report.docx']) {
            expect(externalKind(name), name).toBe(null);
        }
    });

    it('does not take a bare name for an extension', () => {
        expect(externalKind('bin')).toBe(null);
        expect(externalKind('png')).toBe(null);
        expect(externalKind('.png')).toBe(null);
    });

    // The two lists cannot share code. What the UI offers to open and what the
    // backend agrees to open have to stay the same list, or the UI offers an open
    // that fails, or the backend opens something the UI calls a program.
    it('agrees with the list the backend enforces', () => {
        const list = (src, re) => [...src.match(re)[1].matchAll(/['"]([a-z0-9]+)['"]/g)].map((m) => m[1]).sort();
        const front = read('src/modules/utils/ExternalFiles.js');
        const openable = list(front, /const OPENABLE = new Set\(\[([\s\S]*?)\]\)/);
        const programs = list(front, /const PROGRAMS = new Set\(\[([\s\S]*?)\]\)/);
        const back = list(read('src-tauri/src/commands/app.rs'), /const OPENABLE_EXTENSIONS: &\[&str\] = &\[([\s\S]*?)\];/);
        expect(openable.length).toBeGreaterThan(0);
        expect(back).toEqual(openable);
        expect(programs.filter((e) => back.includes(e))).toEqual([]);
    });

    it('runs the launcher off the main thread and registers it', () => {
        expect(read('src-tauri/src/commands/app.rs')).toMatch(/#\[command\(async\)\]\npub fn open_with_default_app/);
        expect(read('src-tauri/src/lib.rs')).toContain('commands::app::open_with_default_app');
    });
});

describe('external files in the tree', () => {
    let Explorer;
    let State;
    let invoke;
    let setExplorerOpensOn;
    let setExplorerShowsExternal;
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
                    <button id="explorer-show-external"></button>
                    <div id="file-list"></div>
                </div>
            </div>
        `;
        ({ invoke } = await import('@tauri-apps/api/core'));
        ({ State } = await import('../src/modules/core/Store.js'));
        ({ setExplorerOpensOn, setExplorerShowsExternal } = await import('../src/modules/utils/ExplorerPrefs.js'));
        Explorer = await import('../src/modules/core/Explorer.js');
        await Explorer.initExplorer(opened, {});
    });

    afterAll(() => {
        global.ResizeObserver = originalResizeObserver;
        document.body.innerHTML = '';
    });

    beforeEach(async () => {
        localStorage.clear();
        opened.mockClear();
        invoke.mockClear();
        dialog.showDialog.mockClear();
        search.searchFiles.mockClear();
        State.currentDir = 'C:/root';
        State.explorerSearchTerm = '';
        State.expandedFolders = new Set();
        setExplorerShowsExternal(true);
        await Explorer.loadExplorer(true);
        await wait(450); // out of the previous test's double-click window
    });

    const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
    const names = () => [...document.querySelectorAll('#file-list .tree-label')].map((l) => l.textContent);
    const row = (name) => [...document.querySelectorAll('#file-list .tree-label')]
        .find((l) => l.textContent === name).parentElement;
    const click = (name, init = {}) => row(name).dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
    const launches = () => invoke.mock.calls.filter(([cmd]) => cmd === 'open_with_default_app');
    const key = (name, init = {}) => {
        click(name, { ctrlKey: true }); // moves the cursor without opening anything
        document.getElementById('file-list').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    };

    it('hides them by default, and never a folder that looks like one', async () => {
        localStorage.clear();
        await Explorer.loadExplorer(true);
        expect(names()).toEqual(['pics.zip', 'a.md', 'b.md']);
    });

    it('the button switches them on and off without reading the folder again', async () => {
        const FS = await import('../src/modules/utils/FileSystem.js');
        localStorage.clear();
        await Explorer.loadExplorer(true);
        FS.readDirectory.mockClear();
        const btn = document.getElementById('explorer-show-external');

        btn.click();
        await wait();
        expect(names()).toContain('photo.png');
        expect(names()).toContain('setup.exe');
        expect(btn.getAttribute('aria-pressed')).toBe('true');

        btn.click();
        await wait();
        expect(names()).not.toContain('photo.png');
        expect(btn.getAttribute('aria-pressed')).toBe('false');
        expect(FS.readDirectory).not.toHaveBeenCalled();
    });

    it('marks the rows, and only those rows', () => {
        expect(row('photo.png').classList.contains('tree-external')).toBe(true);
        expect(row('photo.png').querySelector('.tree-external-mark')).not.toBe(null);
        expect(row('setup.exe').classList.contains('tree-external')).toBe(true);
        expect(row('a.md').classList.contains('tree-external')).toBe(false);
        expect(row('pics.zip').classList.contains('tree-external')).toBe(false);
    });

    it('a single click only selects, a double click opens once', () => {
        click('photo.png');
        expect(launches()).toEqual([]);
        expect(opened).not.toHaveBeenCalled();
        expect(row('photo.png').classList.contains('selected')).toBe(true);
        click('photo.png');
        expect(launches()).toEqual([['open_with_default_app', { path: 'C:/root/photo.png' }]]);
        expect(opened).not.toHaveBeenCalled();
    });

    it('in single-click mode opens on the first click and swallows the second', () => {
        setExplorerOpensOn('single');
        click('photo.png');
        click('photo.png');
        expect(launches().length).toBe(1);
    });

    it('still opens an ordinary file on one click, in the editor', () => {
        click('a.md');
        expect(opened).toHaveBeenCalledWith('C:/root/a.md');
        expect(launches()).toEqual([]);
    });

    it('modified clicks select and never launch', () => {
        click('photo.png', { ctrlKey: true });
        click('photo.png', { ctrlKey: true });
        click('a.md');
        click('setup.exe', { shiftKey: true });
        expect(launches()).toEqual([]);
    });

    it('never launches a program: it offers the file manager instead', async () => {
        dialog.showDialog.mockResolvedValueOnce(true);
        click('setup.exe');
        click('setup.exe');
        await wait(100);
        expect(launches()).toEqual([]);
        expect(dialog.showDialog).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith('reveal_in_file_manager', { path: 'C:/root/setup.exe' });
    });

    it('cancelling that dialog does nothing', async () => {
        click('setup.exe');
        click('setup.exe');
        await wait(100);
        expect(dialog.showDialog).toHaveBeenCalledTimes(1);
        expect(invoke).not.toHaveBeenCalledWith('reveal_in_file_manager', expect.anything());
    });

    it('Enter opens once, key repeat does not, and → never does', () => {
        key('photo.png', { key: 'ArrowRight' });
        expect(launches()).toEqual([]);
        expect(opened).not.toHaveBeenCalled();
        key('photo.png', { key: 'Enter', repeat: true });
        expect(launches()).toEqual([]);
        key('photo.png', { key: 'Enter' });
        expect(launches().length).toBe(1);
    });

    it('the filter box follows the switch, from the same search', async () => {
        State.explorerSearchTerm = 'o';
        await Explorer.loadExplorer();
        expect(names()).toContain('photo.png');
        expect(row('photo.png').classList.contains('tree-external')).toBe(true);

        document.getElementById('explorer-show-external').click();
        await wait();
        expect(names()).toEqual(['a.md']);
        expect(search.searchFiles).toHaveBeenCalledTimes(1);
    });
});
