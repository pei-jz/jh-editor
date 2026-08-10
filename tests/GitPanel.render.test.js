import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Tauri invoke so _loadBranches (called by _renderStatus) does not
// blow up in jsdom. We only test pure DOM rendering logic here.
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(async () => ''),
}));

import GitPanel from '../src/modules/ui/GitPanel.js';

// jsdom provides document; GitPanel builds its own .element. We only need the
// rendering logic (_renderFileList / _renderStatus), which is pure DOM work —
// the Tauri `invoke` calls in _loadBranches are never triggered in these tests
// because we call the private render methods directly.

describe('GitPanel status rendering', () => {
    let panel;

    beforeEach(() => {
        panel = new GitPanel();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('renders deleted (D) files in the changes list with a D badge', () => {
        panel._renderStatus({
            branch: 'main',
            modified: [],
            deleted: ['old.txt'],
            untracked: [],
            staged: [],
        });

        const list = panel.element.querySelector('#git-list-changes');
        const badge = list.querySelector('.git-status-badge');
        expect(badge).toBeTruthy();
        expect(badge.textContent.trim()).toBe('D');
        expect(list.querySelector('.git-tree-label').textContent).toBe('old.txt');
    });

    it('renders modified (M) and untracked (U) files alongside deleted', () => {
        panel._renderStatus({
            branch: 'main',
            modified: ['a.js'],
            deleted: ['b.txt'],
            untracked: ['c.md'],
            staged: [],
        });

        const list = panel.element.querySelector('#git-list-changes');
        const badges = [...list.querySelectorAll('.git-status-badge')].map(b => b.textContent.trim());
        expect(badges).toContain('M');
        expect(badges).toContain('D');
        expect(badges).toContain('U');
        expect(panel.element.querySelector('#git-count-changes').textContent).toBe('3');
    });

    it('keeps an untracked folder expandable as a tree node (not a flat file)', () => {
        // git status --porcelain -uall reports untracked files individually,
        // e.g. docs/a.md. The tree must nest it under a docs/ folder node.
        panel._renderStatus({
            branch: 'main',
            modified: [],
            deleted: [],
            untracked: ['docs/a.md', 'docs/b.md'],
            staged: [],
        });

        const list = panel.element.querySelector('#git-list-changes');
        const folder = list.querySelector('.git-folder');
        expect(folder).toBeTruthy();
        expect(folder.querySelector('.git-tree-label').textContent).toBe('docs');

        // Files appear only when the folder is expanded.
        expect(list.querySelectorAll('.git-file').length).toBe(0);
        panel.expandedNodes.add('docs');
        panel._renderStatus({
            branch: 'main',
            modified: [],
            deleted: [],
            untracked: ['docs/a.md', 'docs/b.md'],
            staged: [],
        });
        const files = list.querySelectorAll('.git-file .git-tree-label');
        expect(files.length).toBe(2);
        expect(files[0].textContent).toBe('a.md');
        expect(files[1].textContent).toBe('b.md');
    });

    it('maps status letters to human-readable tooltips', () => {
        expect(panel._statusLabel('U')).toContain('Untracked');
        expect(panel._statusLabel('M')).toContain('Modified');
        expect(panel._statusLabel('D')).toContain('Deleted');
        expect(panel._statusLabel('S')).toContain('Staged');
    });
});
