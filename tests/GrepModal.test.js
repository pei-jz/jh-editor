import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Ctrl+G starts beside the file being edited, and can search that file alone.
// Where to search is a choice of its own, kept apart from how the text matches.

const invoke = vi.hoisted(() => vi.fn(async () => null));
const openDialog = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openDialog }));
vi.mock('@tauri-apps/plugin-fs', () => ({}));

const { GrepModal, canSearchInMemory, clipAroundHit, defaultSearchFolder } = await import('../src/modules/ui/GrepModal.js');
const { State } = await import('../src/modules/core/Store.js');

const file = (over = {}) => ({
    name: 'note.md', path: 'C:/ws/docs/sub/note.md', content: 'alpha\nbeta needle\nNEEDLE gamma\n', ...over,
});

describe('GrepModal', () => {
    let opened;

    const overlay = () => document.getElementById('grep-overlay');
    const input = () => overlay().querySelector('input[type="text"]');
    const seg = (label) => [...overlay().querySelectorAll('.grep-seg-btn')].find((b) => b.textContent === label);
    const pressed = () => [...overlay().querySelectorAll('.grep-seg-btn[aria-pressed="true"]')]
        .filter((b) => b.closest('.grep-row').style.display !== 'none')
        .map((b) => b.textContent);
    const path = () => overlay().querySelector('.grep-path');
    const labels = () => [...overlay().querySelectorAll('.grep-row')]
        .filter((r) => r.style.display !== 'none')
        .map((r) => r.querySelector('.grep-row-label').textContent);
    const search = () => overlay().querySelector('.grep-btn-primary').click();
    const flush = () => new Promise((r) => setTimeout(r, 0));

    beforeEach(() => {
        invoke.mockClear();
        openDialog.mockReset();
        opened = [];
        window.app = { openSearchResults: vi.fn(async (args) => { opened.push(args); }) };
        State.currentDir = 'C:/ws';
        State.splitMode = false;
        State.openFiles = [file()];
        State.activeTabIndex = 0;
    });

    afterEach(() => {
        // The scope outlives the dialog; don't let it leak between tests.
        GrepModal.show();
        if (overlay() && !seg('Folder').disabled) seg('Folder').click();
        document.body.innerHTML = '';
    });

    it('starts in the folder of the open file, and says so', () => {
        GrepModal.show();
        expect(path().textContent).toBe('C:/ws/docs/sub');
        expect(pressed()).toEqual(['Folder', 'Current']);
    });

    it('moves between the open file\'s folder, the root and a chosen one', async () => {
        GrepModal.show();
        seg('WS Root').click();
        expect(path().textContent).toBe('C:/ws');
        expect(pressed()).toEqual(['Folder', 'WS Root']);

        seg('Current').click();
        expect(path().textContent).toBe('C:/ws/docs/sub');
        expect(pressed()).toEqual(['Folder', 'Current']);

        openDialog.mockResolvedValue('D:\\elsewhere');
        seg('Choose…').click();
        await flush();
        expect(path().textContent).toBe('D:\\elsewhere');
        expect(pressed()).toEqual(['Folder', 'Choose…']);
    });

    it('stays where it was when the folder dialog is dismissed', async () => {
        GrepModal.show();
        openDialog.mockResolvedValue(null);
        seg('Choose…').click();
        await flush();
        expect(path().textContent).toBe('C:/ws/docs/sub');
        expect(pressed()).toEqual(['Folder', 'Current']);
    });

    it('lights one location when the open file sits at the workspace root', () => {
        State.openFiles = [file({ path: 'C:\\WS\\note.md' })];
        GrepModal.show();
        expect(pressed()).toEqual(['Folder', 'Current']);
    });

    it('offers no "current folder" when the tab is not a file on disk', () => {
        State.openFiles = [{ name: 'q', path: 'search://results-1', type: 'search-results', content: '' }];
        GrepModal.show();
        expect(path().textContent).toBe('C:/ws');
        expect(pressed()).toEqual(['Folder', 'WS Root']);
        expect(seg('Current').style.display).toBe('none');
        expect(seg('Current file').disabled).toBe(true);
        expect(seg('Current file').title).toContain('cannot be searched');
    });

    it('gives a folder picked in the tree priority over the open file', () => {
        GrepModal.show('C:/ws/picked');
        expect(path().textContent).toBe('C:/ws/picked');
        expect(pressed()).toEqual(['Folder', 'Choose…']);
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
        seg('Current file').click();
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
        expect(pressed()).toEqual(['Current file']);
    });

    it('hands a large file, which is not in memory, to the backend by its own path', async () => {
        State.openFiles = [file({ path: 'C:/ws/logs/big.log', content: '', isLarge: true, largeId: 1 })];
        GrepModal.show();
        seg('Current file').click();
        input().value = 'needle';
        search();
        await flush();
        expect(invoke).toHaveBeenCalledWith('start_grep', expect.objectContaining({ dir: 'C:/ws/logs/big.log', globs: null }));
    });

    it('shows the rows of the chosen scope, with the conditions in both', () => {
        GrepModal.show();
        expect(labels()).toEqual(['Scope', 'Location', 'Files', 'Conditions']);
        seg('Current file').click();
        expect(labels()).toEqual(['Scope', 'Target', 'Conditions']);
        expect(path().title).toBe('C:/ws/docs/sub'); // the hidden row keeps its folder
        expect(overlay().textContent).toContain('note.md');
        seg('Folder').click();
        expect(labels()).toEqual(['Scope', 'Location', 'Files', 'Conditions']);
    });

    it('applies the conditions in either scope', async () => {
        GrepModal.show();
        seg('Current file').click();
        const matchCase = [...overlay().querySelectorAll('label')].find((l) => l.textContent === 'Match case');
        matchCase.querySelector('input').checked = true;
        input().value = 'NEEDLE';
        search();
        await flush();
        expect(opened[0].matches.map((m) => m.line)).toEqual([3]);
    });

    it('passes the configured limit to a folder search', async () => {
        localStorage.setItem('settings_grepMaxMatches', '20000');
        GrepModal.show();
        input().value = 'needle';
        search();
        await flush();
        expect(invoke).toHaveBeenLastCalledWith('start_grep', expect.objectContaining({ maxMatches: 20000 }));
        localStorage.removeItem('settings_grepMaxMatches');
    });

    it('stops searching the open file at the same limit', async () => {
        localStorage.setItem('settings_grepMaxMatches', '100');
        State.openFiles = [file({ content: 'needle\n'.repeat(500) })];
        GrepModal.show();
        seg('Current file').click();
        input().value = 'needle';
        search();
        await flush();
        expect(opened[0].matches.length).toBe(100);
        localStorage.removeItem('settings_grepMaxMatches');
    });

    it('keeps the whole line, however far along it the hit is', async () => {
        expect(clipAroundHit('short needle', 6)).toBe('short needle');
        const long = `${'x'.repeat(2000)}needle${'y'.repeat(2000)}`;
        expect(clipAroundHit(long, 2000)).toBe(long);

        State.openFiles = [file({ content: long })];
        GrepModal.show();
        seg('Current file').click();
        input().value = 'needle';
        search();
        await flush();
        expect(opened[0].matches[0].text).toBe(long);
    });

    it('cuts only an enormous line, around its hit, and says so', () => {
        const far = `${'x'.repeat(30000)}needle${'y'.repeat(30000)}`;
        const shown = clipAroundHit(far, 30000);
        expect(shown.startsWith('…')).toBe(true);
        expect(shown.endsWith('…')).toBe(true);
        expect(shown.indexOf('needle')).toBe(41);

        const near = `needle${'y'.repeat(30000)}`;
        const head = clipAroundHit(near, 0);
        expect(head.startsWith('needle')).toBe(true);
        expect(head.endsWith('…')).toBe(true);
    });

    it('keeps typing where it was after a scope is chosen', () => {
        GrepModal.show();
        seg('Current file').click();
        expect(document.activeElement).toBe(input());
    });

    it('offers only the file when there is no folder to search', () => {
        State.currentDir = null;
        State.openFiles = [file({ path: null, name: 'untitled' })];
        GrepModal.show();
        expect(pressed()).toEqual(['Current file']);
        expect(seg('Folder').disabled).toBe(true);
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
