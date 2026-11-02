import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Ctrl+G starts beside the file being edited, and can search that file alone.

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-fs', () => ({}));

const { GrepModal, canSearchInMemory, defaultSearchFolder } = await import('../src/modules/ui/GrepModal.js');
const { State } = await import('../src/modules/core/Store.js');

const file = (over = {}) => ({
    name: 'note.md', path: 'C:/ws/docs/sub/note.md', content: 'alpha\nbeta needle\nNEEDLE gamma\n', ...over,
});

describe('GrepModal', () => {
    let opened;

    const overlay = () => document.getElementById('grep-overlay');
    const input = () => overlay().querySelector('input[type="text"]');
    const check = (label) => [...overlay().querySelectorAll('label')]
        .find((l) => l.textContent === label);
    const folderShown = () => overlay().querySelector('span[title]');
    const search = () => [...overlay().querySelectorAll('button')].at(-1).click();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const toggleFileOnly = (on) => {
        const cb = check('Current file only').querySelector('input');
        cb.checked = on;
        cb.onchange();
    };

    beforeEach(() => {
        invoke.mockClear();
        opened = [];
        window.app = { openSearchResults: vi.fn(async (args) => { opened.push(args); }) };
        State.currentDir = 'C:/ws';
        State.splitMode = false;
        State.openFiles = [file()];
        State.activeTabIndex = 0;
    });

    afterEach(() => {
        toggleOffIfOpen();
        document.body.innerHTML = '';
    });

    const toggleOffIfOpen = () => {
        // The choice outlives the dialog; don't let it leak between tests.
        if (overlay() && check('Current file only')) toggleFileOnly(false);
    };

    it('starts in the folder of the open file, with the workspace root a click away', () => {
        GrepModal.show();
        expect(folderShown().textContent).toBe('C:/ws/docs/sub');
        [...overlay().querySelectorAll('button')].find((b) => b.textContent === 'WS Root').click();
        expect(folderShown().textContent).toBe('C:/ws');
    });

    it('starts at the workspace root when the tab is not a file on disk', () => {
        State.openFiles = [{ name: 'q', path: 'search://results-1', type: 'search-results', content: '' }];
        GrepModal.show();
        expect(folderShown().textContent).toBe('C:/ws');
        expect(check('Current file only').style.display).toBe('none');
    });

    it('gives a folder picked in the tree priority over the open file', () => {
        GrepModal.show('C:/ws/picked');
        expect(folderShown().textContent).toBe('C:/ws/picked');
    });

    it('searches the folder through the backend by default', async () => {
        GrepModal.show();
        input().value = 'needle';
        search();
        await flush();
        expect(invoke).toHaveBeenCalledWith('start_grep', expect.objectContaining({ dir: 'C:/ws/docs/sub', term: 'needle' }));
    });

    it('searches only the open file, unsaved text included, when asked', async () => {
        State.openFiles = [file({ content: 'needle not saved yet\nnothing\nneedle again' })];
        GrepModal.show();
        toggleFileOnly(true);
        input().value = 'needle';
        search();
        await flush();

        expect(invoke).not.toHaveBeenCalledWith('start_grep', expect.anything());
        expect(opened[0].singleFile).toBe(true);
        expect(opened[0].matches.map((m) => [m.path, m.line])).toEqual([
            ['C:/ws/docs/sub/note.md', 1],
            ['C:/ws/docs/sub/note.md', 3],
        ]);
        // Asked once, so the next Ctrl+G opens the same way.
        GrepModal.show();
        expect(check('Current file only').querySelector('input').checked).toBe(true);
    });

    it('swaps the folder controls for the file name in current-file mode', () => {
        GrepModal.show();
        const folderRow = folderShown().parentElement;
        expect(folderRow.style.display).toBe('flex');
        toggleFileOnly(true);
        expect(folderRow.style.display).toBe('none');
        expect(overlay().textContent).toContain('note.md');
    });

    it('offers only the file when there is no folder to search', async () => {
        State.currentDir = null;
        State.openFiles = [file({ path: null, name: 'untitled' })];
        GrepModal.show();
        expect(check('Current file only').querySelector('input').checked).toBe(true);
        expect(check('Current file only').style.display).toBe('none');
    });

    it('does not offer to search text that is not all in memory', () => {
        expect(canSearchInMemory(file())).toBe(true);
        expect(canSearchInMemory(file({ isLarge: true }))).toBe(false);
        expect(canSearchInMemory(file({ editId: 3 }))).toBe(false);
        expect(canSearchInMemory(file({ type: 'office', content: '' }))).toBe(false);
        expect(canSearchInMemory(null)).toBe(false);
    });

    it('takes the folder from the path, on either kind of slash', () => {
        expect(defaultSearchFolder({ path: 'C:\\ws\\a\\b.txt' })).toBe('C:/ws/a');
        expect(defaultSearchFolder({ path: 'diff://x' })).toBe('C:/ws');
        expect(defaultSearchFolder(null)).toBe('C:/ws');
    });
});
