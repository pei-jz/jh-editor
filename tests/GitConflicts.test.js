import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calls = [];
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async (cmd, args) => {
        calls.push({ cmd, args });
        return '';
    }),
}));

import GitPanel, { hasConflictMarkers, stagePlan } from '../src/modules/ui/GitPanel.js';
import { State } from '../src/modules/core/Store.js';

const status = (extra = {}) => ({
    branch: 'main', staged: [], modified: [], deleted: [], untracked: [], conflicted: [], operation: null, ...extra,
});

describe('conflict markers', () => {
    it('needs both ends of a conflict, at the start of a line', () => {
        expect(hasConflictMarkers('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\nb')).toBe(true);
        expect(hasConflictMarkers('<<<<<<<\nx\n>>>>>>>\n')).toBe(true);
        // A Markdown setext heading, or one end alone, is not a conflict.
        expect(hasConflictMarkers('Title\n=======\n')).toBe(false);
        expect(hasConflictMarkers('<<<<<<< HEAD\nonly the start')).toBe(false);
        expect(hasConflictMarkers('  <<<<<<< HEAD\n  >>>>>>> x')).toBe(false);
        expect(hasConflictMarkers('<<<<<<<< eight\n>>>>>>>> eight')).toBe(false);
    });
});

describe('staging around conflicts', () => {
    const s = status({
        modified: ['src/a.js', 'docs/readme.md'],
        deleted: ['src/old.js'],
        untracked: ['src/new/'],
        conflicted: [{ path: 'src/both.js', code: 'UU' }],
    });

    it('stages normally when no conflict is inside the path', () => {
        expect(stagePlan('docs/', s)).toEqual({ blocked: [], paths: null });
        expect(stagePlan('src/a.js', s).paths).toBeNull();
        expect(stagePlan('.', status()).paths).toBeNull();
    });

    it('names the other changes instead when Stage All would reach a conflict', () => {
        const plan = stagePlan('.', s);
        expect(plan.blocked).toEqual(['src/both.js']);
        expect(plan.paths).toEqual(['src/a.js', 'docs/readme.md', 'src/old.js', 'src/new/']);
    });

    it('limits a folder to its own changes', () => {
        const plan = stagePlan('src/', s);
        expect(plan.blocked).toEqual(['src/both.js']);
        expect(plan.paths).toEqual(['src/a.js', 'src/old.js', 'src/new/']);
        // A sibling folder whose name starts the same is not inside.
        expect(stagePlan('sr/', s).paths).toBeNull();
    });
});

describe('GitPanel conflict rendering', () => {
    let panel;

    beforeEach(() => {
        calls.length = 0;
        State.gitRoot = 'C:/repo';
        panel = new GitPanel();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('hides the section and the banner when nothing is in progress', () => {
        panel._renderStatus(status({ modified: ['a.js'] }));
        expect(panel.element.querySelector('#git-section-conflicts').hidden).toBe(true);
        expect(panel.element.querySelector('#git-operation-banner').hidden).toBe(true);
    });

    it('lists conflicts flat, sorted, with the folder beside the name', () => {
        panel._renderStatus(status({
            conflicted: [{ path: 'src/z.js', code: 'UU' }, { path: 'a.txt', code: 'DU' }],
        }));
        expect(panel.element.querySelector('#git-section-conflicts').hidden).toBe(false);
        expect(panel.element.querySelector('#git-count-conflicts').textContent).toBe('2');
        const rows = [...panel.element.querySelectorAll('#git-list-conflicts .git-conflict-item')];
        expect(rows.map((r) => r.dataset.gitPath)).toEqual(['a.txt', 'src/z.js']);
        expect(rows[1].querySelector('.git-tree-label').textContent).toBe('z.js');
        expect(rows[1].querySelector('.git-conflict-dir').textContent).toBe('src');
        expect(rows[0].querySelector('.git-status-badge').textContent).toBe('!');
        // Conflicts are not counted as ordinary changes any more.
        expect(panel.element.querySelector('#git-count-changes').textContent).toBe('0');
    });

    it('names the merge and holds the commit back until every conflict is resolved', () => {
        const op = { kind: 'merge', name: 'feature-x', message: "Merge branch 'feature-x'" };
        panel._renderStatus(status({ operation: op, conflicted: [{ path: 'a', code: 'UU' }] }));
        const banner = panel.element.querySelector('#git-operation-banner');
        expect(banner.hidden).toBe(false);
        expect(banner.textContent).toContain('feature-x');
        expect(banner.classList.contains('has-conflicts')).toBe(true);
        expect(banner.querySelector('.git-operation-commit').disabled).toBe(true);

        panel._renderStatus(status({ operation: op, staged: ['a'] }));
        const commit = banner.querySelector('.git-operation-commit');
        expect(commit.disabled).toBe(false);
        commit.click();
        expect(panel.element.querySelector('#git-commit-overlay').style.display).toBe('flex');
        expect(panel.element.querySelector('#git-commit-input').value).toBe("Merge branch 'feature-x'");
    });

    it('offers only Abort for a rebase', () => {
        panel._renderStatus(status({ operation: { kind: 'rebase', name: 'topic', message: '' } }));
        const banner = panel.element.querySelector('#git-operation-banner');
        expect(banner.querySelector('.git-operation-abort')).toBeTruthy();
        expect(banner.querySelector('.git-operation-commit')).toBeNull();
    });

    it('turns a deleted side into "accept deletion" in the menu', () => {
        panel._renderStatus(status({ operation: { kind: 'merge', name: 'feature-x', message: '' } }));
        const labels = (code) => panel._conflictMenuItems({ path: 'f', code }).map((i) => i.label).filter(Boolean);
        expect(labels('UU')).toEqual(expect.arrayContaining(['Keep Current Version (main)', 'Take Incoming Version (feature-x)']));
        expect(labels('DU')).toContain('Accept Deletion (current)');
        expect(labels('UD')).toContain('Accept Deletion (incoming)');
        expect(labels('DD')).not.toContain('Open File as Text');
        expect(labels('UU')).toContain('Open in 3-Way Merge');
        expect(labels('DU')).not.toContain('Open in 3-Way Merge');
    });

    it('opens a conflicted file as plain text, so markers are not read as markup', async () => {
        const openFile = vi.fn(async () => {});
        window.app = { openFile };
        await panel.openConflictAsText({ path: 'docs/added.md', code: 'AA' });
        expect(openFile).toHaveBeenCalledWith('C:/repo/docs/added.md', false, null, true);
        await panel.openConflictAsText({ path: 'gone.md', code: 'DD' });
        expect(openFile).toHaveBeenCalledTimes(1);
        delete window.app;
    });

    it('Stage All leaves a conflicted file out', async () => {
        panel._lastStatus = status({ modified: ['a.js'], conflicted: [{ path: 'b.js', code: 'UU' }] });
        await panel.stageFile('.');
        const add = calls.find((c) => c.cmd === 'git_exec' || c.cmd === 'git_add');
        expect(add.cmd).toBe('git_exec');
        expect(add.args.args).toEqual(['add', '-A', '--', 'a.js']);
    });
});
