import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Finding a folder used to mean another Explorer window and a walk through its
// tree. This is the search that replaces that: what it remembers, how it ranks,
// and what each key does with the result.

const invoke = vi.fn();
const writeText = vi.fn(async () => {});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: (...a) => writeText(...a) }));

const {
    folderName, forgetFolder, formatHotkey, getPinned, getRecentJumps, hotkeyFromEvent, isPinned,
    knownFolders, looksLikePath, pin, prepareFolderIndex, recordJump, searchFolders, unpin,
} = await import('../src/modules/utils/FolderJump.js');
const { RecentFiles } = await import('../src/modules/utils/RecentFiles.js');
const { createFolderJumpPanel, toggleFolderJumpOverlay, closeFolderJumpOverlay } = await import('../src/modules/ui/FolderJumpPanel.js');
const { keyIsOwnedByPopup } = await import('../src/modules/utils/KeyOwnership.js');

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('what it remembers', () => {
    beforeEach(() => localStorage.clear());

    it('keeps pins in the order they were added, one per folder', () => {
        pin('C:/b');
        pin('C:/a');
        pin('c:\\B\\');
        expect(getPinned()).toEqual(['C:/b', 'C:/a']);
        expect(isPinned('C:\\A')).toBe(true);
        unpin('c:/b');
        expect(getPinned()).toEqual(['C:/a']);
    });

    it('keeps jumps most recent first, and caps them', () => {
        for (let i = 0; i < 35; i++) recordJump(`C:/j/${i}`);
        recordJump('c:\\j\\30');
        const jumps = getRecentJumps();
        expect(jumps).toHaveLength(30);
        expect(jumps[0]).toBe('c:\\j\\30');
        expect(jumps.filter((p) => p.toLowerCase().replace(/\\/g, '/') === 'c:/j/30')).toHaveLength(1);
    });

    it('does not let a jump push projects out of the workspace history', () => {
        RecentFiles.recordWorkspace('C:/project');
        for (let i = 0; i < 20; i++) recordJump(`C:/j/${i}`);
        expect(RecentFiles.getWorkspaces()).toEqual(['C:/project']);
    });

    it('survives a corrupt store', () => {
        localStorage.setItem('jheditor_folder_jump_pinned', '{not json');
        expect(getPinned()).toEqual([]);
        localStorage.setItem('jheditor_folder_jump_pinned', '{"a":1}');
        expect(getPinned()).toEqual([]);
    });

    it('lists pinned, then jumps, then workspaces, without repeats', () => {
        RecentFiles.recordWorkspace('C:/ws');
        RecentFiles.recordWorkspace('C:/pinned');
        recordJump('C:/jumped');
        recordJump('c:\\WS');
        pin('C:/pinned');
        expect(knownFolders().map((k) => [k.path, k.source])).toEqual([
            ['C:/pinned', 'pinned'],
            ['c:\\WS', 'recent'],
            ['C:/jumped', 'recent'],
        ]);
    });

    it('forgetting removes it from both histories but leaves a pin alone', () => {
        RecentFiles.recordWorkspace('C:/x');
        recordJump('C:/x');
        pin('C:/x');
        forgetFolder('c:\\x');
        expect(getRecentJumps()).toEqual([]);
        expect(RecentFiles.getWorkspaces()).toEqual([]);
        expect(getPinned()).toEqual(['C:/x']);
    });
});

describe('searching', () => {
    beforeEach(() => localStorage.clear());

    const paths = (hits) => hits.map((h) => h.item.path);

    it('shows the known folders as they stand before anything is typed', () => {
        pin('C:/p');
        recordJump('C:/r');
        expect(paths(searchFolders('', knownFolders(), prepareFolderIndex(['C:/p/sub'])))).toEqual(['C:/p', 'C:/r']);
    });

    it('finds a folder below a pinned one by its name, Japanese included', () => {
        pin('D:/案件');
        const index = prepareFolderIndex(['D:\\案件\\A社\\設計書', 'D:\\案件\\B社\\議事録']);
        const hits = searchFolders('設計', knownFolders(), index);
        expect(paths(hits)).toEqual(['D:\\案件\\A社\\設計書']);
        expect(hits[0].name).toBe('設計書');
        expect(hits[0].nameRanges).toEqual([[0, 2]]);
    });

    it('puts a better match first, and a known folder ahead on a tie', () => {
        pin('C:/w/docs');
        const index = prepareFolderIndex(['C:/a/docs', 'C:/a/mydocs', 'C:/a/docs2']);
        expect(paths(searchFolders('docs', knownFolders(), index))).toEqual([
            'C:/w/docs', 'C:/a/docs', 'C:/a/docs2', 'C:/a/mydocs',
        ]);
    });

    it('lists a folder once when it is both known and indexed, and keeps its source', () => {
        pin('C:/w/docs');
        const hits = searchFolders('docs', knownFolders(), prepareFolderIndex(['C:\\w\\docs']));
        expect(hits).toHaveLength(1);
        expect(hits[0].item.source).toBe('pinned');
    });

    it('matches on the path as well, and the letters in order are enough', () => {
        const index = prepareFolderIndex(['C:/proj/alpha/src', 'C:/proj/beta/lib']);
        expect(paths(searchFolders('alpha/s', [], index))).toEqual(['C:/proj/alpha/src']);
        expect(paths(searchFolders('bl', [], prepareFolderIndex(['C:/x/backlog', 'C:/y/zz'])))).toEqual(['C:/x/backlog']);
    });

    it('caps the list', () => {
        const index = prepareFolderIndex(Array.from({ length: 200 }, (_, i) => `C:/d/f${i}`));
        expect(searchFolders('f', [], index, 60)).toHaveLength(60);
    });
});

describe('small helpers', () => {
    it('names a folder by its last segment, and a drive by itself', () => {
        expect(folderName('C:\\a\\b\\')).toBe('b');
        expect(folderName('C:/a/b')).toBe('b');
        expect(folderName('D:\\')).toBe('D:\\');
    });

    it('recognises what is written as a path', () => {
        for (const q of ['C:\\x', 'c:/x', '\\\\server\\share', '%TEMP%\\x', '  D:\\y  ']) {
            expect(looksLikePath(q), q).toBe(true);
        }
        for (const q of ['', 'docs', 'a/b', 'C:', '100%']) expect(looksLikePath(q), q).toBe(false);
    });
});

describe('capturing a hotkey', () => {
    const press = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

    it('writes it in the form the backend registers', () => {
        expect(hotkeyFromEvent(press('KeyE', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+KeyE');
        expect(hotkeyFromEvent(press('KeyE', { metaKey: true, shiftKey: true }))).toBe('Shift+Super+KeyE');
        expect(hotkeyFromEvent(press('F9'))).toBe('F9');
    });

    it('waits while only modifiers are down', () => {
        expect(hotkeyFromEvent(press('ControlLeft', { ctrlKey: true }))).toBeNull();
        expect(hotkeyFromEvent(press('MetaRight', { metaKey: true }))).toBeNull();
    });

    it('refuses a bare key, which could then not be typed anywhere', () => {
        expect(hotkeyFromEvent(press('KeyE'))).toBeNull();
        expect(hotkeyFromEvent(press('Space'))).toBeNull();
        expect(hotkeyFromEvent(press('Unidentified', { ctrlKey: true }))).toBeNull();
    });

    it('shows it as the keyboard writes it', () => {
        expect(formatHotkey('Super+Shift+KeyE')).toBe('Win+Shift+E');
        expect(formatHotkey('Ctrl+Alt+Digit1')).toBe('Ctrl+Alt+1');
        expect(formatHotkey('Ctrl+Space')).toBe('Ctrl+Space');
    });
});

describe('the panel', () => {
    let host;
    let panel;

    const input = () => panel.element.querySelector('.fj-input');
    const rows = () => [...panel.element.querySelectorAll('.fj-row')];
    const names = () => rows().map((r) => r.querySelector('.fj-row-name').textContent);
    const key = (k, mods = {}) => panel.element.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
    const type = (text) => { input().value = text; input().dispatchEvent(new Event('input', { bubbles: true })); };

    beforeEach(async () => {
        localStorage.clear();
        document.body.innerHTML = '';
        invoke.mockReset();
        writeText.mockClear();
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'list_subfolders') return { folders: [], partial: false };
            if (cmd === 'expand_env_path') return 'C:\\typed';
            if (cmd === 'path_is_dir') return true;
            return null;
        });
        host = { openWorkspace: vi.fn(async () => {}), close: vi.fn() };
        recordJump('C:/two');
        recordJump('C:/one');
        panel = createFolderJumpPanel(host);
        document.body.appendChild(panel.element);
        panel.reset();
        await flush();
    });

    afterEach(() => { document.body.innerHTML = ''; });

    it('starts on the known folders, with the box focused', () => {
        expect(names()).toEqual(['one', 'two']);
        expect(document.activeElement).toBe(input());
    });

    it('Enter shows the selected folder in Explorer, records it and closes', async () => {
        key('ArrowDown');
        key('Enter');
        await flush();
        expect(invoke).toHaveBeenCalledWith('open_folder_in_explorer', { path: 'C:/two' });
        expect(getRecentJumps()[0]).toBe('C:/two');
        expect(host.close).toHaveBeenCalledTimes(1);
    });

    it('Ctrl+Enter is the host\'s workspace action, Alt+Enter the terminal', async () => {
        key('Enter', { ctrlKey: true });
        await flush();
        expect(host.openWorkspace).toHaveBeenCalledWith('C:/one');
        key('Enter', { altKey: true });
        await flush();
        expect(invoke).toHaveBeenCalledWith('open_terminal_at', { path: 'C:/one' });
        expect(invoke).not.toHaveBeenCalledWith('open_folder_in_explorer', expect.anything());
    });

    it('stays open and says so when the folder cannot be opened', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'open_folder_in_explorer') throw new Error('Folder not found');
            return { folders: [], partial: false };
        });
        key('Enter');
        await flush();
        expect(host.close).not.toHaveBeenCalled();
        expect(panel.element.querySelector('.fj-status').classList.contains('error')).toBe(true);
        expect(panel.element.querySelector('.fj-status').textContent).toContain('C:/one');
    });

    it('wraps the selection around', () => {
        key('ArrowUp');
        expect(rows()[1].classList.contains('selected')).toBe(true);
        key('ArrowDown');
        expect(rows()[0].classList.contains('selected')).toBe(true);
    });

    it('Ctrl+D pins the selected folder, and the folders below it get searched', async () => {
        key('d', { ctrlKey: true });
        await flush();
        expect(isPinned('C:/one')).toBe(true);
        expect(invoke).toHaveBeenCalledWith('list_subfolders', { roots: ['C:/one'] });
    });

    it('Ctrl+C copies the path with backslashes, unless text is selected in the box', async () => {
        key('c', { ctrlKey: true });
        expect(writeText).toHaveBeenCalledWith('C:\\one');
        writeText.mockClear();
        type('one');
        input().setSelectionRange(0, 3);
        key('c', { ctrlKey: true });
        expect(writeText).not.toHaveBeenCalled();
    });

    it('Delete on an empty box forgets the selected folder; while typing it edits the text', () => {
        type('o');
        key('Delete');
        expect(getRecentJumps()).toHaveLength(2);
        type('');
        key('Delete');
        expect(getRecentJumps()).toEqual(['C:/two']);
    });

    it('offers a typed path that exists, first', async () => {
        type('C:\\typed');
        await flush();
        expect(names()[0]).toBe('typed');
        key('Enter');
        await flush();
        expect(invoke).toHaveBeenCalledWith('open_folder_in_explorer', { path: 'C:\\typed' });
    });

    it('leaves the keys alone while an IME is composing', () => {
        key('Enter', { isComposing: true });
        expect(invoke).not.toHaveBeenCalledWith('open_folder_in_explorer', expect.anything());
    });

    it('draws folder names as text, never as markup', () => {
        recordJump('C:/<img src=x onerror=alert(1)>');
        panel.reset();
        expect(panel.element.querySelector('.fj-row img')).toBeNull();
    });

    it('says so when a limit cut the list', async () => {
        document.body.innerHTML = '';
        invoke.mockImplementation(async (cmd) => (cmd === 'list_subfolders' ? { folders: ['C:/big/a'], partial: true } : null));
        pin('C:/big');
        panel = createFolderJumpPanel(host);
        document.body.appendChild(panel.element);
        panel.reset();
        await flush();
        expect(panel.element.querySelector('.fj-status').textContent).toMatch(/part/i);
    });
});

describe('the overlay', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '';
        invoke.mockReset();
        invoke.mockResolvedValue({ folders: [], partial: false });
    });
    afterEach(() => closeFolderJumpOverlay());

    it('owns its keys, so ShortcutManager stays out', () => {
        toggleFolderJumpOverlay({ openWorkspace: vi.fn() });
        const box = document.querySelector('.fj-input');
        expect(keyIsOwnedByPopup(box)).toBe(true);
    });

    it('its key closes it again and focus goes back where it was', () => {
        document.body.innerHTML = '<button id="b">x</button>';
        const before = document.getElementById('b');
        before.focus();
        toggleFolderJumpOverlay({ openWorkspace: vi.fn() });
        expect(document.querySelector('.fj-overlay')).not.toBeNull();
        toggleFolderJumpOverlay({ openWorkspace: vi.fn() });
        expect(document.querySelector('.fj-overlay')).toBeNull();
        expect(document.activeElement).toBe(before);
    });

    it('offers a new window and a folder picker only when the host has them', () => {
        toggleFolderJumpOverlay({ openWorkspace: vi.fn(), openInNewWindow: vi.fn(), pickFolder: vi.fn() });
        expect(document.querySelector('.fj-add')).not.toBeNull();
        expect(document.querySelector('.fj-foot').textContent).toContain('Shift+Enter');
        closeFolderJumpOverlay();
        toggleFolderJumpOverlay({ openWorkspace: vi.fn() });
        expect(document.querySelector('.fj-add')).toBeNull();
        expect(document.querySelector('.fj-foot').textContent).not.toContain('Shift+Enter');
    });
});

describe('structure', () => {
    const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

    it('builds the jump window\'s page, and that page leaves the editor out', () => {
        expect(read('vite.config.js')).toContain("'folder-jump': 'folder-jump.html'");
        expect(read('folder-jump.html')).toContain('/src/folder-jump.js');
        const page = read('src/folder-jump.js');
        expect(page).not.toMatch(/core\/(App|Editor)\.js/);
        expect(page).not.toContain('SettingsModal');
    });

    it('keeps the jump window out of the windows a double-clicked file can land in', () => {
        expect(read('src-tauri/src/commands/window.rs')).toContain('folder_jump::WINDOW_LABEL');
    });

    it('stays off until it is turned on', () => {
        expect(read('src-tauri/src/commands/folder_jump.rs')).toMatch(/enabled: false, hotkey: DEFAULT_HOTKEY/);
    });
});
