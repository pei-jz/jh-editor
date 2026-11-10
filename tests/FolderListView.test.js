import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { fileType, parentFolder, sortEntries } = await import('../src/modules/views/FolderListView.js');

const dir = (name, modified = 0) => ({ name, is_directory: true, size: 0, modified });
const file = (name, size = 0, modified = 0) => ({ name, is_directory: false, size, modified });
const names = (list) => list.map((x) => x.name);

describe('folder list sorting', () => {
    it('keeps folders first in every sort', () => {
        const entries = [file('a.txt', 9), dir('z'), file('b.txt', 1)];
        expect(names(sortEntries(entries, 'name'))).toEqual(['z', 'a.txt', 'b.txt']);
        expect(names(sortEntries(entries, 'size'))).toEqual(['z', 'b.txt', 'a.txt']);
        expect(names(sortEntries(entries, 'size', true))).toEqual(['z', 'a.txt', 'b.txt']);
    });

    it('sorts numbers in names as numbers', () => {
        expect(names(sortEntries([file('f10'), file('f2')], 'name'))).toEqual(['f2', 'f10']);
    });

    it('sorts by extension, then by name', () => {
        const entries = [file('b.md'), file('a.js'), file('c.js')];
        expect(names(sortEntries(entries, 'type'))).toEqual(['a.js', 'c.js', 'b.md']);
    });

    it('does not change the list it was given', () => {
        const entries = [file('b'), file('a')];
        sortEntries(entries);
        expect(names(entries)).toEqual(['b', 'a']);
    });
});

describe('folder list type column', () => {
    it('shows the extension in capitals', () => {
        expect(fileType('main.java', false)).toBe('JAVA');
        expect(fileType('Makefile', false)).toBe('');
        expect(fileType('.gitignore', false)).toBe('');
    });
});

describe('going up a folder', () => {
    it('keeps the slash on a drive, where "C:" alone means somewhere else', () => {
        expect(parentFolder('C:/work/src')).toBe('C:/work');
        expect(parentFolder('C:/work')).toBe('C:/');
        expect(parentFolder('C:\\work\\')).toBe('C:/');
    });

    it('stops at the top', () => {
        expect(parentFolder('C:/')).toBeNull();
        expect(parentFolder('C:')).toBeNull();
        expect(parentFolder('/home')).toBe('/');
    });
});

describe('the workspace is the top', () => {
    it('goes up inside the workspace and stops at its root', async () => {
        const { upFrom } = await import('../src/modules/views/FolderListView.js');
        expect(upFrom('C:/ws/src/a', 'C:/ws')).toBe('C:/ws/src');
        expect(upFrom('C:/ws/src', 'C:\\ws')).toBe('C:/ws');
        expect(upFrom('C:/ws', 'C:/ws')).toBeNull();
        expect(upFrom('C:/wsx/a', 'C:/ws')).toBeNull();
        expect(upFrom('C:/a', null)).toBe('C:/');
    });
});
