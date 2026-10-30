import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* The file search modal on top of FileSearchRank: the list comes out ranked,
   the highlight follows the match, a file name is never parsed as markup, and
   a workspace over the index limit is walked once, not once per keystroke. */

const listAllFiles = vi.fn();
const openFile = vi.fn();

vi.mock('../src/modules/utils/FileSystem.js', () => ({
    listAllFiles: (...a) => listAllFiles(...a),
    joinPath: (a, b) => `${a}/${b}`,
}));
vi.mock('../src/modules/core/Editor.js', () => ({ openFile: (...a) => openFile(...a) }));

const { State } = await import('../src/modules/core/Store.js');
const { FileSearchModal } = await import('../src/modules/ui/FileSearchModal.js');

const WS = 'C:/proj';
const entry = (rel) => {
    const name = rel.split('/').pop();
    const path = `${WS}/${rel}`;
    return { entry: name, path, dir: path.substring(0, path.lastIndexOf('/')), type: 'FILE' };
};

const input = () => document.querySelector('#file-search-overlay .tab-search-input');
const rows = () => [...document.querySelectorAll('#file-search-overlay .tab-search-item')];
const names = () => rows().map((li) => li.querySelector('.file-search-name').textContent);

async function search(text) {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
    await vi.runAllTimersAsync();
}

beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    Element.prototype.scrollIntoView = () => {};
    localStorage.clear();
    listAllFiles.mockReset();
    openFile.mockReset();
    FileSearchModal.invalidateCache();
    State.currentDir = WS;
});

afterEach(() => {
    vi.useRealTimers();
    delete Element.prototype.scrollIntoView;
});

describe('file search modal', () => {
    it('lists the best match first and opens it on Enter', async () => {
        listAllFiles.mockResolvedValue([
            entry('src/legacy/OldApp.js'), entry('src/AppShell.js'), entry('src/App.js'),
        ]);
        FileSearchModal.show();
        await search('app.js');

        expect(names()).toEqual(['App.js', 'OldApp.js', 'AppShell.js']);
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(openFile).toHaveBeenCalledWith(`${WS}/src/App.js`);
    });

    it('highlights each matched character of a fuzzy match', async () => {
        listAllFiles.mockResolvedValue([entry('src/ui/FileSearchModal.js')]);
        FileSearchModal.show();
        await search('fsm');

        const hits = [...rows()[0].querySelectorAll('.file-search-name .file-search-hit')];
        expect(hits.map((h) => h.textContent)).toEqual(['F', 'S', 'M']);
    });

    it('highlights a path match in the folder column', async () => {
        listAllFiles.mockResolvedValue([entry('docs/design/basic.xlsx')]);
        FileSearchModal.show();
        await search('design');

        expect(rows()[0].querySelector('.dir').textContent).toBe('docs/design');
        expect(rows()[0].querySelector('.dir .file-search-hit').textContent).toBe('design');
    });

    it('shows a file name containing markup as text', async () => {
        listAllFiles.mockResolvedValue([entry('<img src=x onerror=alert(1)>.md')]);
        FileSearchModal.show();
        await search('img');

        expect(rows()[0].querySelector('img')).toBeNull();
        expect(names()[0]).toBe('<img src=x onerror=alert(1)>.md');
    });

    it('walks a workspace over the limit once, not on every keystroke', async () => {
        const many = Array.from({ length: 50001 }, (_, i) => entry(`d/f${i}.txt`));
        listAllFiles.mockResolvedValue(many);
        FileSearchModal.show();
        await search('f1');
        await search('f12');
        document.getElementById('file-search-overlay').remove();
        FileSearchModal.show();
        await search('f123');

        expect(listAllFiles).toHaveBeenCalledTimes(1);
        expect(document.querySelector('#file-search-overlay .tab-search-list')
            .previousElementSibling.textContent).toContain('limit applied');
    });

    it('walks again after the cache is invalidated (F5)', async () => {
        listAllFiles.mockResolvedValue([entry('a.txt')]);
        FileSearchModal.show();
        await search('a');
        FileSearchModal.invalidateCache();
        await search('a.');
        expect(listAllFiles).toHaveBeenCalledTimes(2);
    });
});
