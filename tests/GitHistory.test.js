import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
   The history: a graph you can follow, a filter for whose history it is, and
   comparisons started from the rows themselves, opening in an editor tab
   rather than the strip under the list.
*/

const calls = [];
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'git_log') return LOG;
        if (cmd === 'git_diff_files') return [{ status: 'M', path: 'a.txt' }];
        if (cmd === 'git_commit_files') return [{ status: 'M', path: 'a.txt' }, { status: 'A', path: 'b.txt' }];
        if (cmd === 'git_exec' && args.args[0] === 'merge-base') return 'base000\n';
        if (cmd === 'git_exec' && args.args[0] === 'rev-parse') return 'feat111\n';
        return '';
    }),
}));

const menus = [];
vi.mock('../src/modules/ui/ContextMenu.js', () => ({
    ContextMenu: { show: (e, items) => menus.push(items), hide: () => {} },
}));

const { default: GitPanel } = await import('../src/modules/ui/GitPanel.js');
const { State } = await import('../src/modules/core/Store.js');

const LOG = [
    { hash: 'm1', short_hash: 'm1', message: 'Merge <feature>', author: 'A', author_email: 'a@x', date: 'now', iso_date: '', parents: ['b1', 'f1'], refs: 'HEAD -> master, tag: v1' },
    { hash: 'f1', short_hash: 'f1', message: 'feat', author: 'A', author_email: 'a@x', date: 'now', iso_date: '', parents: ['b0'], refs: 'feature' },
    { hash: 'b1', short_hash: 'b1', message: 'fix', author: 'A', author_email: 'a@x', date: 'now', iso_date: '', parents: ['b0'], refs: '' },
    { hash: 'b0', short_hash: 'b0', message: 'root', author: 'A', author_email: 'a@x', date: 'now', iso_date: '', parents: [], refs: '' },
];

let panel;
let opened;
beforeEach(() => {
    calls.length = 0;
    menus.length = 0;
    opened = [];
    window.app = { openGitCompareTab: (spec) => opened.push(spec) };
    State.gitRoot = 'C:/repo';
    panel = new GitPanel();
    document.body.appendChild(panel.element);
    panel._activeBranch = 'master';
});
afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
});

const rows = () => [...panel.element.querySelectorAll('#git-list-history .git-history-item-compact-v4')];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('history graph', () => {
    it('draws every row as one SVG of the same width, merge lines included', () => {
        panel._renderHistory(LOG);
        const svgs = rows().map((r) => r.querySelector('svg.git-graph-svg'));
        expect(svgs.every(Boolean)).toBe(true);
        expect(new Set(svgs.map((s) => s.getAttribute('width'))).size).toBe(1);
        // The merge commit curves out to the feature lane, in another colour.
        expect(svgs[0].innerHTML).toContain('--git-lane-1');
        expect(rows()[0].classList.contains('is-head')).toBe(true);
    });

    it('drops the graph while searching, since the rows are no longer contiguous', () => {
        panel._historyFilter = 'root';
        panel._renderHistory(LOG);
        expect(rows()).toHaveLength(1);
        expect(panel.element.querySelector('svg.git-graph-svg')).toBeNull();
    });

    it('finds commits by branch name too', () => {
        panel._historyFilter = 'v1';
        panel._renderHistory(LOG);
        expect(rows().map((r) => r.dataset.hash)).toEqual(['m1']);
    });

    it('prints a commit subject as text, not markup', () => {
        panel._renderHistory(LOG);
        expect(rows()[0].querySelector('.git-hist-msg-v4').textContent).toBe('Merge <feature>');
        expect(rows()[0].querySelector('feature')).toBeNull();
    });

    it('marks branch badges with their ref and their lane colour', () => {
        panel._renderHistory(LOG);
        const head = rows()[0].querySelector('.git-ref-head-v4');
        expect(head.dataset.ref).toBe('master');
        expect(head.getAttribute('style')).toContain('--git-lane-');
        const tag = rows()[0].querySelector('.git-ref-tagname-v4');
        expect(tag.dataset.ref).toBe('v1');
    });
});

describe('whose history', () => {
    it('asks git for the chosen ref and remembers it', async () => {
        panel._setHistoryRef('--all');
        await flush();
        const log = calls.filter(([c]) => c === 'git_log').at(-1);
        expect(log[1]).toMatchObject({ rev: '--all', count: 100 });
        expect(localStorage.getItem('git_history_ref')).toBe('--all');
    });

    it('loads more by asking for a longer log', async () => {
        await panel._loadHistory();
        panel.element.querySelector('#git-history-more').click();
        await flush();
        expect(calls.filter(([c]) => c === 'git_log').at(-1)[1].count).toBe(200);
    });
});

describe('comparing from the history', () => {
    const rightClick = (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const labels = (items) => items.map((i) => i.label).filter(Boolean);

    it('offers the comparisons on a commit', () => {
        panel._renderHistory(LOG);
        rightClick(rows()[2].querySelector('.git-hist-msg-v4'));
        const items = labels(menus.at(-1));
        expect(items).toEqual(expect.arrayContaining([
            'Open Changes in Editor', 'Compare with Working Tree',
            'Compare with Current Branch (master)', 'Compare with Branch…', 'Select for Compare',
        ]));
    });

    it('offers branch actions on a branch badge', () => {
        panel._renderHistory(LOG);
        rightClick(rows()[1].querySelector('[data-ref="feature"]'));
        expect(labels(menus.at(-1))).toEqual(expect.arrayContaining([
            'Compare with Current Branch (master)', 'Compare with Working Tree', 'Show Only This Branch',
        ]));
    });

    it('compares a branch with the current one from their common ancestor, in a tab', async () => {
        await panel._compareRefs('master', 'feature', { useMergeBase: true });
        expect(opened).toHaveLength(1);
        expect(opened[0].compare.from.rev).toBe('base000');
        expect(opened[0].compare.to).toEqual({ rev: 'feature', label: 'feature' });
        expect(opened[0].compare.files).toEqual([{ status: 'M', path: 'a.txt' }]);
    });

    it('compares a commit with the working tree, which can then be edited', async () => {
        await panel._compareWithWorkingTree(LOG[2]);
        expect(opened[0].compare.to.rev).toBe('');
        expect(opened[0].compare.from).toMatchObject({ rev: 'b1', label: 'b1' });
        expect(opened[0].compare.reload).toEqual({ fromRev: 'b1', toRev: '' });
    });

    it('compares two Ctrl+clicked commits, older on the left', async () => {
        panel._renderHistory(LOG);
        rows()[0].dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
        expect(panel.element.querySelector('.git-compare-base').dataset.hash).toBe('m1');
        rows()[3].dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
        await flush();
        expect(opened[0].compare.from.rev).toBe('b0');
        expect(opened[0].compare.to.rev).toBe('m1');
    });

    it('opens a commit\'s own change as a tab, with the file clicked shown first', async () => {
        panel._renderHistory(LOG);
        await panel._openCommitCompare('f1', 'b.txt');
        expect(opened[0]).toMatchObject({ select: 'b.txt' });
        expect(opened[0].compare.from.rev).toBe('f1^');
        expect(calls.some(([c]) => c === 'git_commit_files')).toBe(true);
    });

    it('lists a merge against its first parent', async () => {
        panel._renderHistory(LOG);
        await panel._openCommitCompare('m1');
        const diff = calls.filter(([c]) => c === 'git_diff_files').at(-1);
        expect(diff[1]).toMatchObject({ fromRev: 'm1^1', toRev: 'm1' });
    });
});

describe('next / previous file among the working changes', () => {
    it('includes files inside folders left closed in the tree', () => {
        panel._renderStatus({
            branch: 'master', staged: [], deleted: [], untracked: ['newdir/'],
            modified: ['z.txt', 'src/deep/a.js', 'src/b.js'],
        });
        // Nothing is expanded, so none of src/'s files has a row…
        expect(panel.element.querySelector('[data-git-path="src/b.js"]')).toBeNull();
        // …and they are still walked, in tree order; the untracked folder is not.
        expect(panel._getDiffFileList(false).map((f) => f.path))
            .toEqual(['src/deep/a.js', 'src/b.js', 'z.txt']);
    });
});

/* The commit detail took most of the pane — labelled rows, then a second
   header repeating hash and subject over the files — and left room for two or
   three files. It is two lines now, with the full record a click away. */
describe('commit detail', () => {
    const box = () => panel.element.querySelector('.git-cd');

    it('sums the commit up in two lines and folds the rest away', () => {
        panel._renderHistory(LOG);
        panel._showCommitDetail('f1');
        expect(box().querySelector('.git-cd-hash').textContent).toBe('f1');
        expect(box().querySelector('.git-cd-subject').textContent).toBe('feat');
        expect(box().classList.contains('is-expanded')).toBe(false);
        // One header only: no second one over the file list.
        expect(panel.element.querySelectorAll('.git-commit-file-list-container')).toHaveLength(0);
    });

    it('opens the full record on click, and remembers that', () => {
        panel._renderHistory(LOG);
        panel._showCommitDetail('m1');
        box().querySelector('.git-cd-subject').click();
        expect(box().classList.contains('is-expanded')).toBe(true);
        expect(box().querySelector('.git-cd-full').textContent).toContain('a@x');
        panel._showCommitDetail('f1');
        expect(box().classList.contains('is-expanded')).toBe(true);
    });

    it('lists the files under the summary, with the count beside the author', () => {
        panel._renderHistory(LOG);
        panel._showCommitDetail('f1');
        panel._showCommitFileList('f1', 'feat', [
            { status: 'M', path: 'src/ui/a.js' }, { status: 'A', path: 'b.txt' },
        ]);
        expect(box().querySelector('.git-cd-count').textContent).toBe('2 files');
        const items = [...box().querySelectorAll('.git-commit-file-item')];
        expect(items.map((i) => i.querySelector('.git-cd-file-name').textContent)).toEqual(['a.js', 'b.txt']);
        expect(items[0].querySelector('.git-cd-file-dir').textContent).toBe('src/ui');
    });

    it('opens the commit in the editor from an icon button', async () => {
        panel._renderHistory(LOG);
        panel._showCommitDetail('f1');
        const btn = box().querySelector('.git-commit-open-editor');
        expect(btn.textContent.trim()).toBe('');
        expect(btn.getAttribute('aria-label')).toBe('Open Changes in Editor');
        btn.click();
        await flush();
        expect(opened[0].compare.to.rev).toBe('f1');
    });
});
