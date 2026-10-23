import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
   A Git comparison is one editor tab now: the changed files on the left, the
   selected file's diff beside them. It used to be a strip under the history,
   a few rows high, where every file opened a tab of its own, the working tree
   side could not be edited, and Ctrl+Up / Ctrl+Down did nothing.
*/

const disk = new Map();
const revs = new Map();
const calls = [];

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'read_file_auto_detect') {
            if (!disk.has(args.path)) throw new Error('not found');
            return { content: disk.get(args.path), encoding: 'Shift_JIS', eol: '\r\n' };
        }
        if (cmd === 'git_show') {
            const key = `${args.revision}:${args.file}`;
            if (!revs.has(key)) throw new Error('absent');
            return revs.get(key);
        }
        if (cmd === 'git_diff_files') return [{ status: 'M', path: 'a.txt' }];
        if (cmd === 'git_exec') return 'new.txt\0';
        return '';
    }),
}));

// The real comparison needs CodeMirror's layout; what is checked here is what
// the tab hands it.
const mounted = [];
vi.mock('../src/modules/editors/MergeEditor.js', () => ({
    MergeEditor: class {
        constructor(container, file, options) {
            this.container = container;
            this.merge = file.merge;
            this.options = options;
            this.focused = false;
            mounted.push(this);
        }
        focus() { this.focused = true; }
        refreshState() {}
        getSelectedText() { return ''; }
        destroy() { this.destroyed = true; }
    },
}));

const dialogAnswer = { value: 'cancel' };
vi.mock('../src/modules/ui/Dialog.js', () => ({
    showDialog: vi.fn(async () => dialogAnswer.value),
    showAlert: vi.fn(async () => {}),
    showConfirm: vi.fn(async () => true),
}));

const { GitCompareView, listChangedFiles } = await import('../src/modules/views/GitCompareView.js');
const { fileOrder, buildFileTree, sortTree, filterFiles, stepFile, summarizeFiles, looksBinary } =
    await import('../src/modules/utils/GitCompare.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

function tab(files, { to = { rev: '', label: 'Working Tree' } } = {}) {
    return {
        name: 'cmp', path: 'diff://gitcompare:x', type: 'diff', viewMode: 'diff', isDirty: false, merge: null,
        gitCompare: {
            root: 'C:/repo', from: { rev: 'HEAD', label: 'HEAD' }, to, files, note: '',
            reload: { fromRev: 'HEAD', toRev: to.rev },
        },
    };
}

const FILES = [
    { status: 'M', path: 'src/b.js' },
    { status: 'A', path: 'src/ui/c.js' },
    { status: 'D', path: 'a.txt' },
    { status: 'R', path: 'docs/new.md', old_path: 'docs/old.md' },
];

let container;
beforeEach(() => {
    disk.clear(); revs.clear(); calls.length = 0; mounted.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
});
afterEach(() => { document.body.innerHTML = ''; });

describe('GitCompare helpers', () => {
    it('walks the files in the order the tree draws them', () => {
        const order = fileOrder(sortTree(buildFileTree(FILES)));
        // Folders first (docs, src → src/ui), then the root's own files.
        expect(order).toEqual(['docs/new.md', 'src/ui/c.js', 'src/b.js', 'a.txt']);
    });

    it('filters by every word, in any order', () => {
        expect(filterFiles(FILES, 'ui src').map((f) => f.path)).toEqual(['src/ui/c.js']);
        expect(filterFiles(FILES, '  ')).toBe(FILES);
    });

    it('stops at either end instead of wrapping', () => {
        const order = ['a', 'b'];
        expect(stepFile(order, 'a', 1)).toBe('b');
        expect(stepFile(order, 'b', 1)).toBeNull();
        expect(stepFile(order, 'a', -1)).toBeNull();
        expect(stepFile(order, 'gone', 1)).toBe('a');
    });

    it('counts what changed', () => {
        expect(summarizeFiles(FILES)).toEqual({ A: 1, M: 1, D: 1, R: 1 });
        expect(looksBinary('a\u0000b')).toBe(true);
        expect(looksBinary('plain')).toBe(false);
    });

    it('lists files the working tree has but git does not track yet', async () => {
        const files = await listChangedFiles('C:/repo', 'HEAD', '');
        expect(files.map((f) => [f.status, f.path])).toEqual([['M', 'a.txt'], ['A', 'new.txt']]);
        // Between two commits there is no such thing.
        calls.length = 0;
        await listChangedFiles('C:/repo', 'HEAD~1', 'HEAD');
        expect(calls.some(([cmd]) => cmd === 'git_exec')).toBe(false);
    });
});

describe('GitCompareView', () => {
    it('lists every file in a tall pane and opens the first one', async () => {
        revs.set('HEAD:docs/old.md', 'old\n');
        disk.set('C:/repo/docs/new.md', 'new\n');
        const file = tab(FILES);
        new GitCompareView(container, file, {});
        await flush();
        expect(container.querySelectorAll('.gcv-file')).toHaveLength(4);
        expect(file.gitCompare.selected).toBe('docs/new.md');
        // A rename reads the left side under its old name.
        expect(file.merge.left.text).toBe('old\n');
        expect(container.querySelector('.gcv-file.is-selected').dataset.path).toBe('docs/new.md');
    });

    it('makes the working tree side editable, saved with its own encoding', async () => {
        revs.set('HEAD:src/b.js', 'x\n');
        disk.set('C:/repo/src/b.js', 'y\r\n');
        const file = tab(FILES);
        const view = new GitCompareView(container, file, {});
        await view.select('src/b.js');
        expect(file.merge.left.writable).toBe(false);
        expect(file.merge.right.writable).toBe(true);
        expect(file.merge.right.target).toEqual({
            kind: 'path', path: 'C:/repo/src/b.js', encoding: 'Shift_JIS', eol: '\r\n',
        });
    });

    it('keeps both sides read-only between two commits', async () => {
        revs.set('HEAD:src/b.js', 'x\n');
        revs.set('abc:src/b.js', 'y\n');
        const file = tab(FILES, { to: { rev: 'abc', label: 'abc' } });
        const view = new GitCompareView(container, file, {});
        await view.select('src/b.js');
        expect(file.merge.right.writable).toBe(false);
        expect(file.merge.right.text).toBe('y\n');
    });

    it('does not ask git for a side the file does not exist on', async () => {
        disk.set('C:/repo/src/ui/c.js', 'c\n');
        const file = tab(FILES);
        const view = new GitCompareView(container, file, {});
        await flush();
        calls.length = 0;
        await view.select('src/ui/c.js');
        expect(calls.some(([cmd]) => cmd === 'git_show')).toBe(false);
        expect(file.merge.left.text).toBe('');
    });

    it('hands the diff a next / previous file that walks the list', async () => {
        const file = tab(FILES);
        const view = new GitCompareView(container, file, {});
        await flush();
        expect(file.merge.nav).toMatchObject({ index: 0, count: 4 });
        await file.merge.nav.onNextFile();
        expect(file.gitCompare.selected).toBe('src/ui/c.js');
        expect(file.merge.nav).toMatchObject({ index: 1, count: 4 });
        // Stepping from inside the diff keeps the keyboard in the diff.
        expect(mounted.at(-1).focused).toBe(true);
        await file.merge.nav.onPrevFile();
        expect(file.gitCompare.selected).toBe('docs/new.md');
        await view.step(-1);
        expect(file.gitCompare.selected).toBe('docs/new.md');
    });

    it('answers Ctrl+Down and plain arrows in the list', async () => {
        const file = tab(FILES);
        new GitCompareView(container, file, {});
        await flush();
        const tree = container.querySelector('.gcv-tree');
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true }));
        await flush();
        expect(file.gitCompare.selected).toBe('src/ui/c.js');
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await flush();
        expect(file.gitCompare.selected).toBe('src/b.js');
        tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        await flush();
        expect(file.gitCompare.selected).toBe('a.txt');
    });

    it('opens a file in a folded folder by unfolding it', async () => {
        const file = tab(FILES);
        file.gitCompare.collapsed = ['src'];
        const view = new GitCompareView(container, file, {});
        await flush();
        expect(container.querySelector('[data-path="src/b.js"]')).toBeNull();
        await view.select('src/b.js');
        expect(container.querySelector('[data-path="src/b.js"]').classList.contains('is-selected')).toBe(true);
    });

    it('does not throw away unsaved edits when moving on', async () => {
        disk.set('C:/repo/docs/new.md', 'new\n');
        const file = tab(FILES);
        const view = new GitCompareView(container, file, {});
        await flush();
        file.merge.right.text = 'edited\n';

        dialogAnswer.value = 'cancel';
        expect(await view.step(1)).toBe(false);
        expect(file.gitCompare.selected).toBe('docs/new.md');
        expect(file.merge.right.text).toBe('edited\n');

        const onSave = vi.fn(async () => { file.merge.right.savedText = file.merge.right.text; return true; });
        view.options.onSave = onSave;
        dialogAnswer.value = 'save';
        expect(await view.step(1)).toBe(true);
        expect(onSave).toHaveBeenCalled();
        expect(file.gitCompare.selected).toBe('src/ui/c.js');
    });

    it('filters the list and walks only what is left', async () => {
        const file = tab(FILES);
        const view = new GitCompareView(container, file, {});
        await flush();
        const input = container.querySelector('.gcv-filter');
        input.value = '.js';
        input.dispatchEvent(new Event('input'));
        expect([...container.querySelectorAll('.gcv-file')].map((r) => r.dataset.path))
            .toEqual(['src/ui/c.js', 'src/b.js']);
        await view.step(1);
        expect(file.gitCompare.selected).toBe('src/ui/c.js');
    });

    it('shows a binary file as such instead of garbage', async () => {
        revs.set('HEAD:src/b.js', 'PNG\u0000\u0001');
        disk.set('C:/repo/src/b.js', 'PNG\u0000\u0002');
        const file = tab(FILES);
        const view = new GitCompareView(container, file, {});
        await view.select('src/b.js');
        expect(file.merge.left.text).toMatch(/binary/);
        expect(file.merge.right.writable).toBe(false);
    });

    it('comes back to the same file, edits and all, after a redraw', async () => {
        const file = tab(FILES);
        const first = new GitCompareView(container, file, {});
        await first.select('src/b.js');
        file.merge.right.text = 'kept\n';
        first.destroy();
        calls.length = 0;
        new GitCompareView(container, file, {});
        await flush();
        expect(file.merge.right.text).toBe('kept\n');
        expect(calls.some(([cmd]) => cmd === 'read_file_auto_detect' || cmd === 'git_show')).toBe(false);
    });
});
