import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { breadcrumbs, compareTarget, fileType, parentFolder, sortEntries, upFrom } = await import('../src/modules/views/FolderListView.js');

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

describe('folder list address', () => {
    it('links each folder inside the workspace and none above it', () => {
        const crumbs = breadcrumbs('C:/work/proj/src/ui', 'C:/work/proj');
        expect(crumbs.map((c) => c.label)).toEqual(['C:', 'work', 'proj', 'src', 'ui']);
        expect(crumbs.map((c) => c.inside)).toEqual([false, false, true, true, true]);
        expect(crumbs[0].path).toBe('C:/');
        expect(crumbs[3].path).toBe('C:/work/proj/src');
    });

    it('reads backslashes and a different case as the same workspace', () => {
        const crumbs = breadcrumbs('c:\\Work\\Proj\\a','C:/work/proj');
        expect(crumbs.map((c) => c.inside)).toEqual([false, false, true, true]);
    });

    it('does not treat a folder with a longer name as inside', () => {
        const crumbs = breadcrumbs('C:/work/proj-old/a', 'C:/work/proj');
        expect(crumbs.every((c) => !c.inside)).toBe(true);
    });

    it('handles a path from the root of a Unix file system', () => {
        const crumbs = breadcrumbs('/home/me/proj', '/home/me');
        expect(crumbs.map((c) => [c.label, c.path, c.inside])).toEqual([
            ['/', '/', false], ['home', '/home', false], ['me', '/home/me', true], ['proj', '/home/me/proj', true],
        ]);
    });

    it('stops going up at the workspace', () => {
        expect(upFrom('C:/work/proj/src', 'C:/work/proj')).toBe('C:/work/proj');
        expect(upFrom('C:/work/proj', 'C:/work/proj')).toBe(null);
    });
});

describe('folder list compare', () => {
    it('offers two files or two folders, upper one on the left', () => {
        expect(compareTarget([file('a.txt'), file('b.txt')])).toMatchObject({ folders: false, left: { name: 'a.txt' } });
        expect(compareTarget([dir('x'), dir('y')])).toMatchObject({ folders: true, right: { name: 'y' } });
    });

    it('offers nothing for one, three, a mix, or a file it cannot read', () => {
        expect(compareTarget([file('a.txt')])).toBe(null);
        expect(compareTarget([file('a'), file('b'), file('c')])).toBe(null);
        expect(compareTarget([dir('x'), file('a.txt')])).toBe(null);
        expect(compareTarget([file('a.png'), file('b.exe')])).toBe(null);
    });
});
