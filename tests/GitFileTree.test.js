import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));

import { buildFileTree } from '../src/modules/ui/GitPanel.js';

// A branch comparison routinely returns hundreds of paths (the reported one had
// 245). Flat, that is a scroll hunt; grouped, it is a few foldable directories.

const f = (path, status = 'M') => ({ path, status });
const dirNames = (node) => node.dirs.map((d) => d.name);
const fileNames = (node) => node.files.map((x) => x.name);

describe('buildFileTree', () => {
    it('groups files under their directories', () => {
        const root = buildFileTree([
            f('src/a.js'), f('src/b.js'), f('README.md'),
        ]);
        expect(dirNames(root)).toEqual(['src']);
        expect(fileNames(root)).toEqual(['README.md']);
        expect(fileNames(root.dirs[0])).toEqual(['a.js', 'b.js']);
    });

    // Otherwise `src/modules/ui/x.js` costs three rows of indentation to reach
    // one file — the same reason file explorers collapse these runs.
    it('collapses a chain of single-child directories into one row', () => {
        const root = buildFileTree([f('src/modules/ui/GitPanel.js')]);
        expect(dirNames(root)).toEqual(['src/modules/ui']);
        expect(fileNames(root.dirs[0])).toEqual(['GitPanel.js']);
    });

    it('stops collapsing where the tree actually branches', () => {
        const root = buildFileTree([
            f('src/modules/ui/GitPanel.js'),
            f('src/modules/core/App.js'),
        ]);
        expect(dirNames(root)).toEqual(['src/modules']);
        expect(dirNames(root.dirs[0]).sort()).toEqual(['core', 'ui']);
    });

    it('does not collapse a directory that also holds files', () => {
        const root = buildFileTree([f('src/index.js'), f('src/ui/a.js')]);
        expect(dirNames(root)).toEqual(['src']);
        expect(fileNames(root.dirs[0])).toEqual(['index.js']);
        expect(dirNames(root.dirs[0])).toEqual(['ui']);
    });

    it('keeps the full path on each file so the diff can be opened', () => {
        const root = buildFileTree([f('src/modules/ui/GitPanel.js', 'D')]);
        const file = root.dirs[0].files[0];
        expect(file.path).toBe('src/modules/ui/GitPanel.js');
        expect(file.name).toBe('GitPanel.js');
        expect(file.status).toBe('D');
    });

    it('records the directory path for each node', () => {
        const root = buildFileTree([f('a/b/c/x.js'), f('a/b/d/y.js')]);
        expect(root.dirs[0].path).toBe('a/b');
        expect(root.dirs[0].dirs.map((d) => d.path).sort()).toEqual(['a/b/c', 'a/b/d']);
    });

    it('loses no file, however deep', () => {
        const paths = [
            'a.js', 'src/b.js', 'src/ui/c.js', 'src/ui/deep/d.js',
            'src/core/e.js', 'tests/f.test.js',
        ];
        const count = (node) =>
            node.files.length + node.dirs.reduce((n, d) => n + count(d), 0);
        expect(count(buildFileTree(paths.map((p) => f(p))))).toBe(paths.length);
    });

    it('survives an empty comparison and a missing path', () => {
        expect(buildFileTree([]).dirs).toEqual([]);
        expect(buildFileTree([]).files).toEqual([]);
        expect(buildFileTree([f(''), { status: 'M' }]).files).toEqual([]);
    });
});
