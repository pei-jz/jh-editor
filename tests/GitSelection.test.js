import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invoke = vi.fn(async () => '');
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
const showConfirm = vi.fn(async () => true);
vi.mock('../src/modules/ui/Dialog.js', async (orig) => ({
    ...(await orig()),
    showConfirm: (...a) => showConfirm(...a),
    showAlert: vi.fn(),
}));

const {
    unquoteGitPath, parseStatusPath, selectedEntries, selectRange, batchPaths, splitForRevert,
    deletableEntries, pathListText,
} = await import('../src/modules/utils/GitSelection.js');
const { default: GitPanel } = await import('../src/modules/ui/GitPanel.js');
const { State } = await import('../src/modules/core/Store.js');

describe('git status paths', () => {
    it('takes off the quoting git puts around a path with a space', () => {
        expect(unquoteGitPath('"a b.txt"')).toBe('a b.txt');
        expect(unquoteGitPath('plain.txt')).toBe('plain.txt');
    });

    it('undoes escapes, octal UTF-8 included', () => {
        expect(unquoteGitPath('"a\\"b\\\\c.txt"')).toBe('a"b\\c.txt');
        expect(unquoteGitPath('"\\346\\227\\245 x.txt"')).toBe('日 x.txt');
        expect(unquoteGitPath('"日本語 x.txt"')).toBe('日本語 x.txt');
    });

    it('reads a rename as the new path plus where it came from', () => {
        expect(parseStatusPath('old.txt -> new.txt')).toEqual({ path: 'new.txt', from: 'old.txt' });
        expect(parseStatusPath('"a b.txt" -> "c d.txt"')).toEqual({ path: 'c d.txt', from: 'a b.txt' });
        expect(parseStatusPath('same.txt')).toEqual({ path: 'same.txt', from: null });
    });
});

describe('what a selection stands for', () => {
    const entries = [
        { path: 'src/a.js', status: 'M' }, { path: 'src/deep/b.js', status: 'D' },
        { path: 'srcish.js', status: 'U' }, { path: 'c.txt', status: 'U' },
    ];

    it('a folder means what is under it, not whatever shares its prefix', () => {
        expect(selectedEntries(['src'], entries).map((e) => e.path)).toEqual(['src/a.js', 'src/deep/b.js']);
    });

    it('a file and its folder picked together count it once', () => {
        expect(selectedEntries(['src', 'src/a.js'], entries)).toHaveLength(2);
    });

    it('takes a range either way, ends included', () => {
        const order = ['a', 'b', 'c', 'd'];
        expect(selectRange(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
        expect(selectRange(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
        expect(selectRange(order, 'gone', 'c')).toEqual(['c']);
    });

    it('never lets a revert treat an untracked file as restorable', () => {
        expect(splitForRevert(entries)).toEqual({
            tracked: ['src/a.js', 'src/deep/b.js'], untracked: ['srcish.js', 'c.txt'],
        });
    });

    it('has nothing to delete for a file already gone', () => {
        expect(deletableEntries(entries).map((e) => e.path)).toEqual(['src/a.js', 'srcish.js', 'c.txt']);
    });

    it('keeps command lines within the limit without losing a path', () => {
        const paths = Array.from({ length: 50 }, (_, i) => `dir/file-${i}.txt`);
        const batches = batchPaths(paths, 100);
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.flat()).toEqual(paths);
        for (const b of batches) expect(b.join('   ').length).toBeLessThanOrEqual(100);
    });

    it('sends a path longer than the limit on its own instead of dropping it', () => {
        expect(batchPaths(['x'.repeat(50), 'y'], 10)).toEqual([['x'.repeat(50)], ['y']]);
    });

    it('shortens a long list for a dialog', () => {
        expect(pathListText(['a', 'b', 'c'], 2, (n) => `+${n}`)).toBe('  a\n  b\n  +1');
    });
});

describe('GitPanel selection', () => {
    let panel;
    const status = {
        branch: 'main',
        modified: ['a.txt', 'b.txt', 'dir/c.txt'],
        deleted: ['gone.txt'],
        untracked: ['new.txt'],
        staged: ['s1.txt', 's2.txt'],
    };
    const row = (list, path) => panel.element.querySelector(`${list} [data-git-path="${path}"]`);
    // Drawing the status also lists the branches; only what changes things counts.
    const gitCalls = () => invoke.mock.calls.filter(([c]) => c === 'git_exec').map(([, a]) => a.args)
        .filter((args) => args[0] !== 'branch');
    const dataTransfer = () => ({ setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '', dropEffect: '' });
    const drag = (type, target, dt, init = {}) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, { dataTransfer: dt, ...init });
        target.dispatchEvent(e);
        return e;
    };

    beforeEach(() => {
        invoke.mockClear();
        showConfirm.mockClear();
        showConfirm.mockResolvedValue(true);
        State.gitRoot = 'C:/repo';
        panel = new GitPanel();
        panel.refresh = vi.fn(async () => {});
        panel.expandedNodes.add('dir');
        document.body.appendChild(panel.element);
        panel._renderStatus(status);
        panel.showDiff = vi.fn();
    });

    afterEach(() => {
        panel.element.remove();
        document.body.innerHTML = '';
    });

    it('a plain click opens the file and selects only it', () => {
        row('#git-list-changes', 'a.txt').click();
        expect(panel.showDiff).toHaveBeenCalledWith('a.txt', false);
        expect(row('#git-list-changes', 'a.txt').classList.contains('is-selected')).toBe(true);
    });

    it('Ctrl+click adds to the selection without opening anything', () => {
        row('#git-list-changes', 'a.txt').click();
        panel.showDiff.mockClear();
        row('#git-list-changes', 'b.txt').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        expect(panel.showDiff).not.toHaveBeenCalled();
        expect([...panel._gitSelection.stage]).toEqual(['a.txt', 'b.txt']);
        expect(panel.element.querySelector('#git-selection-stage').hidden).toBe(false);
    });

    it('Shift+click takes the range in the order shown', () => {
        const rows = [...panel.element.querySelectorAll('#git-list-changes .git-tree-item')];
        const paths = rows.map((r) => r.dataset.gitPath);
        rows[0].click();
        rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        expect([...panel._gitSelection.stage]).toEqual(paths.slice(0, 3));
    });

    it('selecting in one list clears the other: their actions differ', () => {
        row('#git-list-changes', 'a.txt').click();
        row('#git-list-staged', 's1.txt').click();
        expect(panel._gitSelection.stage.size).toBe(0);
        expect([...panel._gitSelection.unstage]).toEqual(['s1.txt']);
    });

    it('a selection survives a refresh, minus the files that left the list', () => {
        panel._setSelection('stage', ['a.txt', 'b.txt']);
        panel._renderStatus({ ...status, modified: ['a.txt', 'dir/c.txt'] });
        expect([...panel._gitSelection.stage]).toEqual(['a.txt']);
        expect(row('#git-list-changes', 'a.txt').classList.contains('is-selected')).toBe(true);
    });

    it('stages everything picked in one command, deletions included', async () => {
        panel._setSelection('stage', ['a.txt', 'gone.txt', 'dir']);
        await panel.stageSelected();
        expect(gitCalls().at(-1)).toEqual(['--literal-pathspecs', 'add', '-A', '--', 'a.txt', 'dir/c.txt', 'gone.txt']);
        expect(panel._gitSelection.stage.size).toBe(0);
    });

    it('a row button acts on the whole selection when the row is part of it', async () => {
        panel._setSelection('stage', ['a.txt', 'b.txt']);
        row('#git-list-changes', 'a.txt').querySelector('.git-stage-btn').click();
        await vi.waitFor(() => expect(gitCalls().at(-1)).toContain('add'));
        expect(gitCalls().at(-1)).toEqual(['--literal-pathspecs', 'add', '-A', '--', 'a.txt', 'b.txt']);
    });

    it('unstages a rename under both of its names', async () => {
        panel._renderStatus({ ...status, staged: ['old.txt -> new.txt'] });
        panel._setSelection('unstage', ['new.txt']);
        await panel.unstageSelected();
        expect(gitCalls().at(-1)).toEqual(['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', 'new.txt', 'old.txt']);
    });

    it('unstages from a repository with no commit yet', async () => {
        invoke.mockImplementation(async (cmd, a) => {
            if (cmd === 'git_exec' && a.args.includes('reset')) throw new Error("fatal: ambiguous argument 'HEAD'");
            return '';
        });
        panel._setSelection('unstage', ['s1.txt']);
        await panel.unstageSelected();
        expect(gitCalls().at(-1)).toEqual(['--literal-pathspecs', 'rm', '-r', '-q', '--cached', '--', 's1.txt']);
        invoke.mockImplementation(async () => '');
    });

    it('reverts tracked files with git, untracked ones to the Recycle Bin', async () => {
        panel._setSelection('stage', ['a.txt', 'gone.txt', 'new.txt']);
        await panel.revertSelected();
        expect(showConfirm).toHaveBeenCalledTimes(1);
        expect(showConfirm.mock.calls[0][0]).toContain('new.txt');
        expect(gitCalls().at(-1)).toEqual(['--literal-pathspecs', 'checkout', '--', 'a.txt', 'gone.txt']);
        expect(invoke).toHaveBeenCalledWith('trash_paths', { paths: ['C:/repo/new.txt'] });
    });

    it('does nothing at all when the revert is not confirmed', async () => {
        showConfirm.mockResolvedValue(false);
        panel._setSelection('stage', ['a.txt', 'new.txt']);
        await panel.revertSelected();
        expect(gitCalls()).toEqual([]);
        expect(invoke).not.toHaveBeenCalledWith('trash_paths', expect.anything());
        expect(panel._gitSelection.stage.size).toBe(2);
    });

    it('deletes to the Recycle Bin, skipping what is already gone', async () => {
        invoke.mockImplementation(async (cmd) => (cmd === 'exists' ? true : ''));
        panel._setSelection('stage', ['a.txt', 'gone.txt']);
        await panel.deleteSelected('stage');
        expect(invoke).toHaveBeenCalledWith('trash_paths', { paths: ['C:/repo/a.txt'] });
        expect(gitCalls()).toEqual([]);
        invoke.mockImplementation(async () => '');
    });

    it('deleting from the staged list takes the file out of the index too', async () => {
        invoke.mockImplementation(async (cmd, a) => (cmd === 'exists' ? a.path.endsWith('s1.txt') : ''));
        panel._setSelection('unstage', ['s1.txt', 's2.txt']);
        await panel.deleteSelected('unstage');
        expect(invoke).toHaveBeenCalledWith('trash_paths', { paths: ['C:/repo/s1.txt'] });
        expect(gitCalls().at(-1)).toEqual(['--literal-pathspecs', 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', 's1.txt', 's2.txt']);
        invoke.mockImplementation(async () => '');
    });

    it('dragging the selection to the staged section stages all of it', async () => {
        panel._setSelection('stage', ['a.txt', 'b.txt']);
        const dt = dataTransfer();
        drag('dragstart', row('#git-list-changes', 'a.txt'), dt);
        const staged = panel.element.querySelector('#git-section-staged');
        expect(drag('dragover', staged, dt).defaultPrevented).toBe(true);
        expect(staged.classList.contains('git-drop-target')).toBe(true);
        drag('drop', staged, dt);
        await vi.waitFor(() => expect(gitCalls().at(-1)).toEqual(['--literal-pathspecs', 'add', '-A', '--', 'a.txt', 'b.txt']));
        expect(staged.classList.contains('git-drop-target')).toBe(false);
    });

    it('dragging a row outside the selection takes that row alone', () => {
        panel._setSelection('stage', ['a.txt', 'b.txt']);
        const dt = dataTransfer();
        drag('dragstart', row('#git-list-changes', 'new.txt'), dt);
        expect(panel._gitDrag.paths).toEqual(['new.txt']);
        panel._endGitDrag();
    });

    it('dragging back to CHANGES unstages', async () => {
        const dt = dataTransfer();
        drag('dragstart', row('#git-list-staged', 's1.txt'), dt);
        const changes = panel.element.querySelector('#git-section-changes');
        drag('dragover', changes, dt);
        drag('drop', changes, dt);
        await vi.waitFor(() => expect(gitCalls().at(-1)).toEqual(['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', 's1.txt']));
    });

    it('a section does not take a drop from its own list', () => {
        const dt = dataTransfer();
        drag('dragstart', row('#git-list-changes', 'a.txt'), dt);
        const changes = panel.element.querySelector('#git-section-changes');
        expect(drag('dragover', changes, dt).defaultPrevented).toBe(false);
        drag('drop', changes, dt);
        expect(gitCalls()).toEqual([]);
        panel._endGitDrag();
    });

    it('a refresh during a drag waits for it to end', () => {
        const dt = dataTransfer();
        const source = row('#git-list-changes', 'a.txt');
        drag('dragstart', source, dt);
        panel._renderStatus({ ...status, modified: ['a.txt'] });
        expect(source.isConnected).toBe(true);
        panel._endGitDrag();
        expect(row('#git-list-changes', 'b.txt')).toBeNull();
    });

    it('the keyboard stretches the selection and clears it', () => {
        const first = panel.element.querySelector('#git-list-changes .git-tree-item');
        const key = (target, init) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
        key(first, { key: 'ArrowDown', shiftKey: true });
        expect(panel._gitSelection.stage.size).toBe(2);
        key(first, { key: 'Escape' });
        expect(panel._gitSelection.stage.size).toBe(0);
        key(first, { key: 'a', ctrlKey: true });
        expect(panel._gitSelection.stage.size).toBe(panel.element.querySelectorAll('#git-list-changes .git-tree-item').length);
    });
});
