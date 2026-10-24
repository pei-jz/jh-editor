import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let fail = null;
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async (cmd, args) => {
        calls.push({ cmd, args });
        if (fail && cmd === 'git_exec' && fail(args.args)) throw new Error('git failed');
        return '';
    }),
}));

import {
    mergeArgs, rebaseArgs, resetArgs, sequencerArgs, hasLocalChanges, runOperation,
} from '../src/modules/ui/GitBranchOps.js';
import GitPanel from '../src/modules/ui/GitPanel.js';
import { State } from '../src/modules/core/Store.js';

describe('the commands run', () => {
    it('merges without waiting for an editor', () => {
        expect(mergeArgs('feature')).toEqual(['merge', '--no-edit', 'feature']);
        expect(mergeArgs('feature', { mode: 'no-ff' })).toEqual(['merge', '--no-edit', '--no-ff', 'feature']);
        expect(mergeArgs('feature', { mode: 'ff-only' })).toEqual(['merge', '--no-edit', '--ff-only', 'feature']);
        expect(mergeArgs('origin/x', { mode: 'squash', autostash: true })).toEqual(['merge', '--squash', '--autostash', 'origin/x']);
    });

    it('rebases and continues with the prepared messages accepted as they are', () => {
        expect(rebaseArgs('main')).toEqual(['-c', 'core.editor=true', 'rebase', 'main']);
        expect(rebaseArgs('main', { autostash: true })).toEqual(['-c', 'core.editor=true', 'rebase', '--autostash', 'main']);
        expect(sequencerArgs('rebase', 'continue')).toEqual(['-c', 'core.editor=true', 'rebase', '--continue']);
        expect(sequencerArgs('cherry-pick', 'skip')).toEqual(['cherry-pick', '--skip']);
        expect(sequencerArgs('merge', 'abort')).toEqual(['merge', '--abort']);
    });

    it('resets in the four modes and no other', () => {
        expect(resetArgs('HEAD~1')).toEqual(['reset', '--mixed', 'HEAD~1']);
        for (const m of ['soft', 'mixed', 'hard', 'keep']) expect(resetArgs('abc', m)).toEqual(['reset', `--${m}`, 'abc']);
        expect(() => resetArgs('abc', 'merge')).toThrow();
    });

    it('counts staged, modified, deleted and conflicted files as local changes, not untracked ones', () => {
        expect(hasLocalChanges({ untracked: ['n.txt'] })).toBe(false);
        expect(hasLocalChanges({ modified: ['a'] })).toBe(true);
        expect(hasLocalChanges({ staged: ['a'] })).toBe(true);
        expect(hasLocalChanges(null)).toBe(false);
    });
});

describe('after the command', () => {
    let panel;

    beforeEach(() => {
        calls.length = 0;
        fail = null;
        State.gitRoot = 'C:/repo';
        panel = new GitPanel();
        panel.refresh = vi.fn(async () => {});
    });

    it('returns git\'s output and refreshes on success', async () => {
        const out = await runOperation(panel, ['merge', '--no-edit', 'x']);
        expect(out).toBe('');
        expect(panel.refresh).toHaveBeenCalled();
    });

    it('opens the first conflict when the operation stops on conflicts', async () => {
        fail = (args) => args[0] === 'merge';
        panel.refresh = vi.fn(async () => {
            panel._lastStatus = { conflicted: [{ path: 'b.txt', code: 'UU' }, { path: 'a.txt', code: 'UU' }] };
        });
        panel.openConflict = vi.fn();
        const dialog = await import('../src/modules/ui/Dialog.js');
        const alert = vi.spyOn(dialog, 'showAlert').mockResolvedValue(undefined);
        const out = await runOperation(panel, ['merge', '--no-edit', 'x']);
        expect(out).toBeNull();
        expect(panel.openConflict).toHaveBeenCalledWith({ path: 'a.txt', code: 'UU' });
        alert.mockRestore();
    });

    it('offers Continue and Skip while a rebase is stopped, Continue only once conflicts are gone', () => {
        const op = { kind: 'rebase', name: 'topic', message: '' };
        panel._renderStatus({ branch: 'HEAD (no branch)', staged: [], modified: [], deleted: [], untracked: [], conflicted: [{ path: 'a', code: 'UU' }], operation: op });
        const banner = panel.element.querySelector('#git-operation-banner');
        expect(banner.querySelector('.git-operation-skip')).toBeTruthy();
        expect(banner.querySelector('.git-operation-continue').disabled).toBe(true);
        panel._renderStatus({ branch: 'HEAD (no branch)', staged: ['a'], modified: [], deleted: [], untracked: [], conflicted: [], operation: op });
        expect(banner.querySelector('.git-operation-continue').disabled).toBe(false);
    });

    it('lists the branch operations in the toolbar menu', () => {
        panel._activeBranch = 'main';
        panel._lastStatus = { operation: null };
        const labels = panel._moreMenuItems().map((i) => i.label).filter(Boolean);
        expect(labels).toEqual(['Merge Branch into main…', 'Rebase main…', 'Reset main…', 'Undo Last Commit']);
    });
});
