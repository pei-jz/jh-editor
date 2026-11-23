import { describe, it, expect } from 'vitest';
import { buildPathTree, flattenTree } from '../src/modules/utils/PathTree.js';

const f = (path) => {
    const p = path.replace(/\\/g, '/');
    const at = p.lastIndexOf('/');
    return { name: at >= 0 ? p.slice(at + 1) : p, dir: at >= 0 ? p.slice(0, at) : '' };
};
const dirOf = (it) => it.dir;

/** The tree as indented text, which reads far better in a failure than nested objects. */
const show = (nodes, collapsed) => flattenTree(nodes, collapsed)
    .map((n) => '  '.repeat(n.depth) + (n.type === 'dir' ? `${n.label}/ (${n.count})` : n.item.name));

describe('buildPathTree', () => {
    const ws = 'C:/work/app';

    it('nests workspace folders under the workspace, folders first, by name', () => {
        const items = [
            f('C:/work/app/src/ui/Panel.js'),
            f('C:/work/app/README.md'),
            f('C:/work/app/src/core/Editor.js'),
            f('C:/work/app/src/core/App.js'),
        ];
        expect(show(buildPathTree(items, dirOf, { workspace: ws }))).toEqual([
            'app/ (4)',
            '  src/ (3)',
            '    core/ (2)',
            '      App.js',
            '      Editor.js',
            '    ui/ (1)',
            '      Panel.js',
            '  README.md',
        ]);
    });

    // A deep path costs one line, not one per folder.
    it('merges folders that only hold one folder', () => {
        const items = [
            f('C:/work/app/test_data/standards-main/020_dev/020_test/unit.xlsx'),
            f('C:/work/app/test_data/standards-main/020_dev/010_design/db.docx'),
        ];
        expect(show(buildPathTree(items, dirOf, { workspace: ws }))).toEqual([
            'app/ (2)',
            '  test_data/standards-main/020_dev/ (2)',
            '    010_design/ (1)',
            '      db.docx',
            '    020_test/ (1)',
            '      unit.xlsx',
        ]);
    });

    it('never merges the workspace node into its only folder', () => {
        const tree = buildPathTree([f('C:/work/app/src/a.js')], dirOf, { workspace: ws });
        expect(tree[0].label).toBe('app');
        expect(tree[0].children[0].label).toBe('src');
    });

    it('puts files outside the workspace after it, from their drive', () => {
        const items = [f('D:/notes/daily/today.md'), f('C:/work/app/a.js')];
        expect(show(buildPathTree(items, dirOf, { workspace: ws }))).toEqual([
            'app/ (1)',
            '  a.js',
            'D:/notes/daily/ (1)',
            '  today.md',
        ]);
    });

    it('collects things with no folder in one group at the end', () => {
        const items = [{ name: 'Terminal', dir: '' }, f('C:/work/app/a.js'), { name: 'Untitled-1', dir: '' }];
        const tree = buildPathTree(items, dirOf, { workspace: ws, otherLabel: 'Other' });
        expect(show(tree)).toEqual(['app/ (1)', '  a.js', 'Other/ (2)', '  Terminal', '  Untitled-1']);
        expect(tree.at(-1).other).toBe(true);
    });

    // Windows has no case in paths: one folder, not two.
    it('treats drive-letter and folder case as the same folder on Windows', () => {
        const items = [f('c:/work/app/SRC/a.js'), f('C:/work/app/src/b.js')];
        expect(show(buildPathTree(items, dirOf, { workspace: ws }))).toEqual(['app/ (2)', '  SRC/ (2)', '    a.js', '    b.js']);
    });

    it('keeps the items’ own order with order: "rank", a folder sitting at its best item', () => {
        const items = [
            f('C:/work/app/z/best.js'),
            f('C:/work/app/a/second.js'),
            f('C:/work/app/z/third.js'),
        ];
        expect(show(buildPathTree(items, dirOf, { workspace: ws, order: 'rank' }))).toEqual([
            'app/ (3)',
            '  z/ (2)',
            '    best.js',
            '    third.js',
            '  a/ (1)',
            '    second.js',
        ]);
    });

    it('works with no workspace and with POSIX paths', () => {
        const items = [f('/home/me/notes/a.md'), f('/home/me/notes/b.md')];
        expect(show(buildPathTree(items, dirOf))).toEqual(['/home/me/notes/ (2)', '  a.md', '  b.md']);
    });
});

describe('flattenTree', () => {
    it('skips the contents of folded folders but still counts them', () => {
        const tree = buildPathTree([f('C:/w/src/a.js'), f('C:/w/src/b.js'), f('C:/w/c.js')], dirOf, { workspace: 'C:/w' });
        expect(show(tree, new Set(['C:/w/src']))).toEqual(['w/ (3)', '  src/ (2)', '  c.js']);
    });
});
