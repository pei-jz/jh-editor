import { invoke } from '@tauri-apps/api/core';
import { showAlert, showConfirm, showDialog } from './Dialog.js';
import { createFilterSelect } from './FilterSelect.js';
import { State } from '../core/Store.js';
import { ContextMenu } from './ContextMenu.js';
import AIAgent from '../ai/AIAgent.js';
import { open } from '@tauri-apps/plugin-shell';

/**
 * Strip quoting that leaked out of the shell.
 *
 * `run_command` runs through `cmd /C` on Windows, and Rust escapes the command
 * line it hands to cmd — but cmd does not understand that escaping, so a `"` in
 * the command survives as a literal character in the child's argv. A branch
 * listed with `--format="%(refname:short)"` therefore came back as `"master"`,
 * quotes included, and checking it out asked git for a *file* by that name:
 *
 *     pathspec '"memory-audit-fixes"' did not match any file(s) known to git
 *
 * The format strings no longer carry quotes. This is the belt to that braces —
 * a ref name can never legally contain a quote or a backslash, so anything of
 * the sort is quoting, not part of the name.
 */
export function cleanRef(name) {
    return String(name).trim().replace(/^["'\\]+|["'\\]+$/g, '').trim();
}
/**
 * Split a git remote into the pieces a web URL needs.
 *
 * Handles the four shapes a remote actually comes in: `git@host:owner/repo.git`,
 * `ssh://git@host/owner/repo.git`, `https://host/owner/repo.git` and the same
 * with a username in it. GitLab nests groups, so `owner` keeps every path
 * segment before the last one.
 *
 * @returns {{host: string, owner: string, repo: string}|null}
 */
export function parseRemoteUrl(url) {
    let rest = String(url || '').trim();
    if (!rest) return null;

    let host;
    const scp = rest.match(/^[^/@]+@([^:/]+):(.+)$/);   // git@github.com:owner/repo.git
    if (scp) {
        host = scp[1];
        rest = scp[2];
    } else {
        const m = rest.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
        if (!m) return null;
        host = m[1].replace(/:\d+$/, '');   // strip a port
        rest = m[2];
    }

    const parts = rest.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { host, repo: parts.pop(), owner: parts.join('/') };
}

/**
 * The forge's own "open a pull request" page, with the branches and text
 * prefilled. This is the route for anyone without the GitHub CLI: it needs
 * nothing installed, and the forge itself asks for confirmation before the PR
 * actually opens.
 *
 * @returns {string|null} null when the host is not one we know how to address.
 */
export function pullRequestUrl(repo, base, head, { title = '', body = '' } = {}) {
    if (!repo || !base || !head) return null;
    // Branch names may contain `/`, which is a path separator in these URLs and
    // is expected literally there.
    const ref = (r) => encodeURIComponent(r).replace(/%2F/gi, '/');
    const q = (s) => encodeURIComponent(s);
    const { host, owner, repo: name } = repo;
    const root = `https://${host}/${owner}/${name}`;

    if (/(^|\.)github\.com$/i.test(host) || /(^|\.)github\./i.test(host)) {
        const extra = [title && `title=${q(title)}`, body && `body=${q(body)}`].filter(Boolean);
        return `${root}/compare/${ref(base)}...${ref(head)}?expand=1${extra.length ? '&' + extra.join('&') : ''}`;
    }
    if (/(^|\.)gitlab\./i.test(host)) {
        const p = [
            `merge_request%5Bsource_branch%5D=${q(head)}`,
            `merge_request%5Btarget_branch%5D=${q(base)}`,
            title && `merge_request%5Btitle%5D=${q(title)}`,
            body && `merge_request%5Bdescription%5D=${q(body)}`,
        ].filter(Boolean);
        return `${root}/-/merge_requests/new?${p.join('&')}`;
    }
    if (/(^|\.)bitbucket\.org$/i.test(host)) {
        return `${root}/pull-requests/new?source=${q(head)}&dest=${q(base)}`;
    }
    return null;
}


/**
 * Group flat `a/b/c.js` paths into a directory tree, collapsing runs of
 * single-child directories into one node (`src/modules/ui` rather than three
 * nested rows) — the way every file explorer shows a deep, sparse tree.
 *
 * Pure, so the shape can be tested without a repository.
 *
 * @param {Array<{path: string, status: string}>} files
 * @returns {{name: string, path: string, dirs: object[], files: object[]}} root
 */
export function buildFileTree(files) {
    const root = { name: '', path: '', dirs: [], files: [] };

    for (const file of files) {
        const parts = String(file.path || '').split('/').filter(Boolean);
        const name = parts.pop();
        if (!name) continue;
        let node = root;
        let sofar = '';
        for (const part of parts) {
            sofar = sofar ? `${sofar}/${part}` : part;
            let next = node.dirs.find((d) => d.name === part);
            if (!next) {
                next = { name: part, path: sofar, dirs: [], files: [] };
                node.dirs.push(next);
            }
            node = next;
        }
        node.files.push({ ...file, name });
    }

    // A directory whose only child is another directory is shown as one row.
    const collapse = (node) => {
        node.dirs.forEach(collapse);
        while (node.dirs.length === 1 && node.files.length === 0 && node !== root) {
            const only = node.dirs[0];
            node.name = `${node.name}/${only.name}`;
            node.path = only.path;
            node.dirs = only.dirs;
            node.files = only.files;
        }
    };
    collapse(root);
    return root;
}

/** Total files under a tree node, including every nested directory. */
function countFiles(node) {
    return node.files.length + node.dirs.reduce((n, d) => n + countFiles(d), 0);
}

/**
 * Which revision the LEFT side of a branch comparison should actually use.
 *
 * `base...head` (three-dot) is what review tools mean by "compare branches":
 * only what happened on `head` since the two diverged. But when `head` is
 * already contained in `base` — comparing a tag against the branch that moved
 * past it, say — the merge base IS `head`, so the three-dot diff is empty by
 * definition and reads as a broken comparison. Fall back to the direct diff
 * there, and say why.
 *
 * Pure so the rule can be tested without a repository.
 *
 * @param {object} o
 * @param {string} o.base           left ref as the user picked it
 * @param {string} o.head           right ref ('' = working tree)
 * @param {boolean} o.useMergeBase  the "common ancestor" checkbox
 * @param {string} o.mergeBase      resolved merge-base commit ('' if none)
 * @param {string} o.headCommit     commit `head` points at
 * @returns {{fromRev: string, fromLabel: string, note: string}}
 */
export function resolveCompareBase({ base, head, useMergeBase, mergeBase, headCommit }) {
    if (!useMergeBase || head === '') {
        return { fromRev: base, fromLabel: base, note: '' };
    }
    if (!mergeBase) {
        return {
            fromRev: base, fromLabel: base,
            note: 'No common ancestor; showing the direct comparison.',
        };
    }
    if (mergeBase === headCommit) {
        return {
            fromRev: base, fromLabel: base,
            note: `${head} is already part of ${base}; showing the direct comparison.`,
        };
    }
    return { fromRev: mergeBase, fromLabel: `${base} (merge-base)`, note: '' };
}

class GitPanel {
    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'git-panel-v2';
        this.element.innerHTML = `
            <div class="git-v2-repo" id="git-repo-row" style="display:none;">
                <span class="git-icon">📁</span>
                <select id="git-repo-select" class="git-branch-dropdown"></select>
            </div>
            <div class="git-v2-header">
                <div class="git-v2-branch">
                    <span class="git-icon">🌿</span>
                    <div id="git-branch-select" class="git-branch-dropdown-host"></div>
                </div>
                <div class="git-v2-toolbar">
                    <button id="git-compare-btn" title="Compare Branches">⇄</button>
                    <button id="git-fetch-btn" title="Fetch All">⟳</button>
                    <button id="git-pull-btn" title="Pull">⤓</button>
                    <button id="git-push-btn" title="Push">⤒</button>
                    <button id="git-pr-btn" title="New Pull Request">PR</button>
                    <button id="git-refresh-btn" title="Refresh Status">↺</button>
                </div>
            </div>
            
            <div class="git-v2-content">
                <section class="git-section" id="git-section-changes">
                    <div class="git-section-header">
                        <span class="git-section-arrow">▼</span>
                        <span>CHANGES</span>
                        <span class="git-count" id="git-count-changes">0</span>
                        <div class="git-section-actions">
                            <button id="git-stage-all-btn" title="Stage All"><svg viewBox="0 0 12 12" width="10" height="10"><line x1="6" y1="2" x2="6" y2="10" stroke="currentColor" stroke-width="2"/><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="2"/></svg></button>
                        </div>
                    </div>
                    <div class="git-section-list" id="git-list-changes"></div>
                </section>

                <section class="git-section" id="git-section-staged">
                    <div class="git-section-header">
                        <span class="git-section-arrow">▼</span>
                        <span>STAGED CHANGES</span>
                        <span class="git-count" id="git-count-staged">0</span>
                        <div class="git-section-actions">
                            <button id="git-unstage-all-btn" title="Unstage All"><svg viewBox="0 0 12 12" width="10" height="10"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="2"/></svg></button>
                            <button id="git-commit-modal-btn" title="Commit" class="git-commit-btn-icon">✓</button>
                        </div>
                    </div>
                    <div class="git-section-list" id="git-list-staged"></div>
                </section>

                <section class="git-section" id="git-section-history">
                    <div class="git-section-header">
                        <span class="git-section-arrow">▼</span>
                        <span>HISTORY</span>
                        <span class="git-compare-hint" id="git-compare-hint" style="margin-left:auto;margin-right:8px;font-size:10px;color:var(--primary-color);display:none;"></span>
                    </div>
                    <div class="git-history-search" style="padding:4px 10px;">
                        <input type="text" id="git-history-search-input" placeholder="Search commits (message / hash / author)…"
                            style="width:100%;box-sizing:border-box;padding:4px 8px;font-size:11px;background:var(--bg-color-secondary,var(--bg-color));color:var(--text-color);border:1px solid var(--border-color);border-radius:4px;" />
                    </div>
                    <div class="git-section-list" id="git-list-history"></div>
                </section>
            </div>

            <!-- Commit detail panel (shown below the history, not over it),
                 with a divider to trade space between the two. Both are hidden
                 until a commit is actually selected. -->
            <div id="git-detail-resizer" class="git-detail-resizer" style="display:none;"></div>
            <div id="git-commit-detail-panel" class="git-commit-detail-panel" style="display:none;"></div>

            <!-- Commit Modal -->
            <div id="git-commit-overlay" class="git-modal-overlay" style="display:none;">
                <div class="git-modal">
                    <h3>Commit Changes</h3>
                    <textarea id="git-commit-input" placeholder="Commit message (Required)"></textarea>
                    <div class="git-modal-btns">
                        <button id="git-commit-ai-btn" title="Generate a commit message from the staged diff">✨ AI</button>
                        <button id="git-commit-cancel">Cancel</button>
                        <button id="git-commit-confirm" class="primary-btn">Commit</button>
                    </div>
                </div>
            </div>
        `;

        this.expandedNodes = new Set(); // For tree view
        this._initEvents();
    }

    _initEvents() {
        this.element.querySelector('#git-repo-select').onchange = (e) => {
            State.gitRoot = e.target.value;
            this.refresh();
        };

        this.element.querySelector('#git-refresh-btn').onclick = () => this.refresh();
        this.element.querySelector('#git-compare-btn').onclick = () => this.compareBranches();
        this._bindDetailResizer();
        this.element.querySelector('#git-fetch-btn').onclick = () => this.executeGit('git_fetch');
        this.element.querySelector('#git-pull-btn').onclick = () => this.executeGit('git_pull');
        this.element.querySelector('#git-push-btn').onclick = () => this.push();
        this.element.querySelector('#git-pr-btn').onclick = () => this.createPullRequest();
        
        this.element.querySelector('#git-stage-all-btn').onclick = () => this.stageFile('.');
        this.element.querySelector('#git-unstage-all-btn').onclick = () => this.unstageFile('.');

        this.element.querySelector('#git-commit-modal-btn').onclick = () => {
            const overlay = this.element.querySelector('#git-commit-overlay');
            overlay.style.display = 'flex';
            this.element.querySelector('#git-commit-input').focus();
        };

        this.element.querySelector('#git-commit-cancel').onclick = () => {
            this.element.querySelector('#git-commit-overlay').style.display = 'none';
        };

        this.element.querySelector('#git-commit-confirm').onclick = () => this.commit();
        this.element.querySelector('#git-commit-ai-btn').onclick = () => this.generateCommitMessage();

        // Section Toggles
        this.element.querySelectorAll('.git-section-header').forEach(header => {
            header.onclick = (e) => {
                if (e.target.tagName === 'BUTTON') return;
                const section = header.parentElement;
                section.classList.toggle('collapsed');
                header.querySelector('.git-section-arrow').textContent = section.classList.contains('collapsed') ? '▶' : '▼';
            };
        });

        // History search: filter the already-loaded commit list live.
        const searchInput = this.element.querySelector('#git-history-search-input');
        if (searchInput) {
            searchInput.oninput = () => {
                this._historyFilter = searchInput.value.trim();
                this._renderHistory();
            };
            // Keep clicks inside the input from toggling the section header.
            searchInput.onclick = (e) => e.stopPropagation();
        }
    }

    async executeGit(command) {
        if (!State.gitRoot) return;
        try {
            const result = await invoke(command, { path: State.gitRoot });
            this.refresh();
        } catch (e) {
            showAlert(`Git Error: ${e}`, { title: 'Git', kind: 'error' });
        }
    }

    _renderRepoSelector() {
        const row = this.element.querySelector('#git-repo-row');
        const select = this.element.querySelector('#git-repo-select');
        if (!row || !select) return;
        const repos = State.gitRepos || [];
        if (repos.length > 1) {
            const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            select.innerHTML = repos.map(r =>
                `<option value="${esc(r.path)}" ${r.path === State.gitRoot ? 'selected' : ''}>${esc(r.name)}</option>`
            ).join('');
            row.style.display = 'flex';
        } else {
            row.style.display = 'none';
        }
    }

    /**
     * Let the divider trade height between the history and the detail pane.
     *
     * Bound once — the panel's markup is built once, and re-binding on every
     * refresh would pile up live document listeners.
     */
    _bindDetailResizer() {
        const resizer = this.element.querySelector('#git-detail-resizer');
        const panel = this.element.querySelector('#git-commit-detail-panel');
        if (!resizer || !panel || this._detailResizerBound) return;
        this._detailResizerBound = true;

        let dragging = false;

        resizer.addEventListener('mousedown', (e) => {
            dragging = true;
            resizer.classList.add('resizing');
            document.body.style.cursor = 'row-resize';
            // Text selection while dragging turns the whole panel blue.
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const root = this.element.getBoundingClientRect();
            // Dragging UP grows the detail pane, which sits at the bottom.
            const height = root.bottom - e.clientY;
            const max = Math.max(80, root.height * 0.8);
            const next = Math.round(Math.min(Math.max(height, 80), max));
            panel.style.height = `${next}px`;
            localStorage.setItem('git_detail_height', String(next));
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            resizer.classList.remove('resizing');
            document.body.style.cursor = 'default';
        });
    }

    /**
     * Reveal the detail pane and its divider together.
     *
     * @returns {HTMLElement|null} the pane, ready to be filled.
     */
    _showDetailPanel() {
        const panel = this.element.querySelector('#git-commit-detail-panel');
        const resizer = this.element.querySelector('#git-detail-resizer');
        if (!panel) return null;
        panel.style.display = 'block';
        if (resizer) resizer.style.display = 'block';
        // Whatever height the divider was last dragged to.
        const saved = parseInt(localStorage.getItem('git_detail_height'), 10);
        if (saved > 0) panel.style.height = `${saved}px`;
        return panel;
    }

    /** Nothing is selected: the pane and its divider go away entirely. */
    _hideDetailPanel() {
        const panel = this.element.querySelector('#git-commit-detail-panel');
        const resizer = this.element.querySelector('#git-detail-resizer');
        if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
        if (resizer) resizer.style.display = 'none';
    }

    async refresh() {
        this._renderRepoSelector();
        // The selection does not survive a reload of the log: a stale commit
        // detail hanging below a freshly rendered history reads as "something
        // is selected" when nothing is.
        this._hideDetailPanel();
        
        // Show git init button if no git repo detected
        const contentEl = this.element.querySelector('.git-v2-content');
        if (!State.gitRoot || !State.gitRepos || State.gitRepos.length === 0) {
            const hasGitDir = await this._checkGitDir(State.currentDir);
            if (!hasGitDir) {
                contentEl.style.display = 'none';
                this._showGitInitPrompt();
                return;
            }
        }
        contentEl.style.display = '';
        this._hideGitInitPrompt();

        try {
            const status = await invoke('git_status', { path: State.gitRoot });
            this._renderStatus(status);
            
            const history = await invoke('git_log', { path: State.gitRoot, count: 50 });
            this._renderHistory(history);

            window.dispatchEvent(new CustomEvent('git-status-updated', { detail: status }));
        } catch (e) {
            console.error('Git refresh failed:', e);
        }
    }

    async _checkGitDir(path) {
        if (!path) return false;
        try {
            const result = await invoke('run_command', { command: 'git rev-parse --git-dir', cwd: path });
            return result && result.trim().length > 0;
        } catch (e) {
            return false;
        }
    }

    _showGitInitPrompt() {
        let prompt = this.element.querySelector('.git-init-prompt');
        if (!prompt) {
            prompt = document.createElement('div');
            prompt.className = 'git-init-prompt';
            prompt.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px 20px;text-align:center;';
            prompt.innerHTML = `
                <div style="font-size:36px;opacity:0.4;">📁</div>
                <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;">No Git repository here</div>
                <button id="git-init-btn" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:var(--primary-color, #3b82f6);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;transition:opacity 0.15s;">
                    <span style="font-size:14px;">＋</span> Create a repository
                </button>
            `;
            this.element.querySelector('.git-v2-header').after(prompt);
            prompt.querySelector('#git-init-btn').onclick = async () => {
                try {
                    await invoke('git_init', { path: State.currentDir });
                    // Re-detect repos after init
                    const repos = await invoke('find_git_repos', { path: State.currentDir });
                    const toAbs = (r) => (r === '.' ? State.currentDir : `${State.currentDir}/${r}`.replace(/\\/g, '/'));
                    State.gitRepos = repos.map(r => ({
                        name: r === '.' ? 'Root Repository' : r,
                        path: toAbs(r)
                    }));
                    State.gitRoot = repos.length > 0 ? toAbs(repos[0]) : State.currentDir;
                    if (window.app?.gitPanel) window.app.gitPanel.refresh();
                    if (window.showToast) window.showToast('Initialized a Git repository');
                } catch (e) {
                    showAlert(`Git init failed: ${e}`, { title: 'Git', kind: 'error' });
                }
            };
        }
    }

    _hideGitInitPrompt() {
        const prompt = this.element.querySelector('.git-init-prompt');
        if (prompt) prompt.style.display = 'none';
    }

    _renderStatus(status) {
        this._loadBranches(status.branch);
        
        const changesList = this.element.querySelector('#git-list-changes');
        const stagedList = this.element.querySelector('#git-list-staged');
        
        const changes = [
            ...(status.modified || []).map(f => ({ path: f, status: 'M' })),
            ...(status.deleted || []).map(f => ({ path: f, status: 'D' })),
            ...(status.untracked || []).map(f => ({ path: f, status: 'U' }))
        ];
        
        this.element.querySelector('#git-count-changes').textContent = changes.length;
        this.element.querySelector('#git-count-staged').textContent = status.staged.length;

        this._renderFileList(changesList, changes, 'stage');
        this._renderFileList(stagedList, status.staged.map(f => ({ path: f, status: 'S' })), 'unstage');
    }

    async _loadBranches(activeBranch) {
        if (!State.gitRoot) return;
        // The picker replaced a <select>, so `#git-branch-select.value` no
        // longer answers "which branch am I on".
        this._activeBranch = activeBranch || '';
        try {
            const output = await invoke('run_command', { 
                command: 'git branch --format=%(refname:short)', 
                cwd: State.gitRoot 
            });
            const branches = output.split('\n').map(cleanRef).filter(b => b.length > 0);
            
            // A repo with dozens of branches makes a native dropdown a scroll
            // hunt, so the switcher is a type-to-filter picker.
            const host = this.element.querySelector('#git-branch-select');
            if (host) {
                const checkout = async (newBranch) => {
                    if (!newBranch || newBranch === activeBranch) return;
                    try {
                        await invoke('run_command', {
                            command: `git checkout ${newBranch}`,
                            cwd: State.gitRoot,
                        });
                        this.refresh();
                    } catch (err) {
                        showAlert(`Checkout failed: ${err.message || err}`,
                            { title: 'Git', kind: 'error' });
                        this.refresh();
                    }
                };

                // Reuse the picker across refreshes so typing is not interrupted
                // every time the status polls.
                if (this._branchPicker && host.contains(this._branchPicker.element)) {
                    this._branchPicker.setOptions([{ label: '', items: branches }]);
                    this._branchPicker.setValue(activeBranch || branches[0] || '');
                } else {
                    host.innerHTML = '';
                    this._branchPicker = createFilterSelect({
                        items: branches,
                        value: activeBranch || branches[0] || '',
                        placeholder: 'branch…',
                        title: 'Switch branch (type to filter)',
                        onChange: checkout,
                    });
                    this._branchPicker.element.style.width = '100%';
                    host.appendChild(this._branchPicker.element);
                }
            }
        } catch (e) {
            console.error('Failed to load git branches:', e);
        }
    }

    _renderFileList(container, files, actionType) {
        container.innerHTML = '';
        if (files.length === 0) {
            container.innerHTML = '<div class="git-empty-msg">No changes</div>';
            return;
        }

        // Normalize paths: strip trailing slashes EXCEPT for untracked folders.
        // git returns "folder/" for an untracked directory; that trailing slash
        // is the ONLY signal we have that it is a directory (a green U with no
        // discoverable contents). We keep it so the tree can expand it.
        const normalizedFiles = files.map(f => ({
            ...f,
            path: f.path.replace(/[/\\]+$/, ''),
            isDir: f.path.endsWith('/') || f.path.endsWith('\\')
        }));

        const root = { children: {}, files: [] };
        normalizedFiles.forEach(f => {
            const parts = f.path.split(/[/\\]/);
            let current = root;
            // An untracked folder ("docs") has no discoverable children via git
            // status alone, but it IS a real directory on disk. Represent it as
            // a tree node so the user can expand it; the actual files appear
            // after it is staged (or we could walk the disk — out of scope).
            if (f.isDir) {
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    if (!current.children[part]) current.children[part] = { name: part, children: {}, files: [] };
                    current = current.children[part];
                }
                return;
            }
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                if (!current.children[part]) current.children[part] = { name: part, children: {}, files: [] };
                current = current.children[part];
            }
            current.files.push(f);
        });

        const renderNode = (node, pathPrefix, level) => {
            const keys = Object.keys(node.children);
            if (keys.length === 1 && node.files.length === 0 && node.name !== undefined) {
                const childName = keys[0];
                const child = node.children[childName];
                const mergedName = node.name + '/' + childName;
                const newNode = { ...child, name: mergedName };
                return renderNode(newNode, pathPrefix, level);
            }

            const name = node.name || '';
            const fullPath = pathPrefix ? pathPrefix + '/' + name : name;
            const isExpanded = this.expandedNodes.has(fullPath) || node.name === undefined;
            // A folder node with no children and no files is an empty untracked
            // directory (git reported it as "dir/"). Show it as a folder row the
            // user can stage — clicking it has nothing to expand, so open its
            // diff-ish view is not possible; the stage button speaks for it.
            if (node.name !== undefined) {
                const hasNoChildren = keys.length === 0 && node.files.length === 0;
                const div = document.createElement('div');
                div.className = 'git-tree-item git-folder' + (hasNoChildren ? ' git-folder-empty' : '');
                div.style.paddingLeft = `${level * 16 + 10}px`;

                // Folder-level stage/unstage button
                let folderActionHtml = '';
                if (actionType === 'stage') {
                    folderActionHtml = `<button class="git-action-btn git-stage-btn git-folder-action" data-folder-path="${fullPath}" title="Stage All in Folder"><svg viewBox="0 0 12 12"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg></button>`;
                } else if (actionType === 'unstage') {
                    folderActionHtml = `<button class="git-action-btn git-unstage-btn git-folder-action" data-folder-path="${fullPath}" title="Unstage All in Folder"><svg viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6"/></svg></button>`;
                }

                div.innerHTML = `
                    <span class="git-tree-arrow" style="display: inline-block; width: 12px; text-align: center; margin-right: 6px; font-size: 10px; opacity: ${hasNoChildren ? '0.3' : '0.7'};">${isExpanded && !hasNoChildren ? '▼' : '▶'}</span>
                    <span class="git-tree-icon" style="margin-right: 6px;">${hasNoChildren ? '📂' : '📁'}</span>
                    <span class="git-tree-label" style="font-weight: 500;">${node.name}</span>
                    <div class="git-file-actions" style="margin-left: auto;">
                        ${folderActionHtml}
                    </div>
                `;
                div.onclick = (e) => {
                    if (e.target.closest('.git-folder-action')) return;
                    if (this.expandedNodes.has(fullPath)) this.expandedNodes.delete(fullPath);
                    else this.expandedNodes.add(fullPath);
                    this.refresh();
                };

                // Bind folder action button
                const folderActionBtn = div.querySelector('.git-folder-action');
                if (folderActionBtn) {
                    folderActionBtn.onclick = (e) => {
                        e.stopPropagation();
                        if (actionType === 'stage') {
                            this.stageFile(fullPath + '/');
                        } else {
                            this.unstageFile(fullPath + '/');
                        }
                    };
                }

                container.appendChild(div);
            }
 
            if (isExpanded) {
                keys.sort().forEach(k => renderNode(node.children[k], fullPath, level + 1));
                node.files.forEach(file => {
                    const div = document.createElement('div');
                    div.className = 'git-tree-item git-file';
                    div.style.paddingLeft = `${level * 16 + 53}px`;
                    const filename = file.path.split(/[/\\]/).pop() || file.path;
                    
                    let actionHtml = '';
                    if (actionType === 'stage') {
                        const isUntracked = file.status === 'U';
                        const isDeleted = file.status === 'D';
                        actionHtml = `
                            <button class="git-action-btn git-discard-btn" data-path="${file.path}" title="${isDeleted ? 'Restore File' : 'Discard Changes'}"><svg viewBox="0 0 12 12"><path d="M3 6a3 3 0 1 1 5.1 2.1L7 9"/></svg></button>
                            ${isUntracked ? `<button class="git-action-btn git-ignore-btn" data-path="${file.path}" title="Ignore File"><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4"/><line x1="3" y1="6" x2="9" y2="6"/></svg></button>` : ''}
                            ${!isDeleted ? `<button class="git-action-btn git-stage-btn" data-path="${file.path}" title="Stage Change"><svg viewBox="0 0 12 12"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg></button>` : ''}
                        `;
                    } else {
                        actionHtml = `
                            <button class="git-action-btn git-unstage-btn" data-path="${file.path}" title="Unstage Change"><svg viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6"/></svg></button>
                        `;
                    }

                    div.innerHTML = `
                        <span class="git-status-badge ${file.status.toLowerCase()}" title="${this._statusLabel(file.status)}" style="margin-right: 6px; display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; font-size: 8px; font-weight: bold; border-radius: 2px;">${file.status}</span>
                        <span class="git-tree-label" title="${file.path}">${filename}</span>
                        <div class="git-file-actions">
                            ${actionHtml}
                        </div>
                    `;
                    
                    div.onclick = () => this.showDiff(file.path, actionType === 'unstage');
                    
                    const discardBtn = div.querySelector('.git-discard-btn');
                    if (discardBtn) {
                        discardBtn.onclick = async (e) => {
                            e.stopPropagation();
                            const confirmMsg = file.status === 'U' 
                                ? `Are you sure you want to delete "${filename}"? This action cannot be undone.` 
                                : `Are you sure you want to discard changes in "${filename}"? This will revert the file to the last committed state.`;
                            const yes = await showConfirm(confirmMsg, { title: 'Discard Changes', kind: 'warning', okLabel: 'Discard' });
                            if (yes) {
                                try {
                                    await invoke('git_discard', { path: State.gitRoot, file: file.path, status: file.status });
                                    this.refresh();
                                } catch (err) {
                                    showAlert(`Discard failed: ${err}`, { title: 'Git', kind: 'error' });
                                }
                            }
                        };
                    }

                    const ignoreBtn = div.querySelector('.git-ignore-btn');
                    if (ignoreBtn) {
                        ignoreBtn.onclick = async (e) => {
                            e.stopPropagation();
                            const yes = await showConfirm(`Are you sure you want to add "${filename}" to .gitignore?`, { title: 'Ignore File', kind: 'info' });
                            if (yes) {
                                try {
                                    await invoke('git_ignore', { path: State.gitRoot, file: file.path });
                                    this.refresh();
                                } catch (err) {
                                    showAlert(`Ignore failed: ${err}`, { title: 'Git', kind: 'error' });
                                }
                            }
                        };
                    }

                    const stageBtn = div.querySelector('.git-stage-btn');
                    if (stageBtn) {
                        stageBtn.onclick = (e) => {
                            e.stopPropagation();
                            this.stageFile(file.path);
                        };
                    }

                    const unstageBtn = div.querySelector('.git-unstage-btn');
                    if (unstageBtn) {
                        unstageBtn.onclick = (e) => {
                            e.stopPropagation();
                            this.unstageFile(file.path);
                        };
                    }

                    container.appendChild(div);
                });
            }
        };

        renderNode(root, '', -1);
    }

    _renderHistory(history) {
        // Keep the full, unfiltered list so the search box can filter without a
        // round-trip to git.
        if (history !== undefined) this._fullHistory = history;
        const source = this._fullHistory || [];

        const q = (this._historyFilter || '').toLowerCase();
        const filtered = q
            ? source.filter(e =>
                (e.message || '').toLowerCase().includes(q) ||
                (e.hash || '').toLowerCase().includes(q) ||
                (e.short_hash || '').toLowerCase().includes(q) ||
                (e.author || '').toLowerCase().includes(q) ||
                (e.author_email || '').toLowerCase().includes(q))
            : source;

        this._lastHistory = filtered;
        const container = this.element.querySelector('#git-list-history');
        container.innerHTML = '';

        if (filtered.length === 0) {
            container.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--text-secondary);text-align:center;">${q ? 'No commits match the search.' : 'No history.'}</div>`;
            return;
        }

        const lanes = [];

        // When filtering, the parent-based graph lanes are meaningless (commits
        // are non-contiguous), so hide the graph column noise by skipping it.
        const showGraph = !q;

        filtered.forEach((entry, idx) => {
            const item = document.createElement('div');
            item.className = 'git-history-item-compact-v4';
            
            let laneIndex = lanes.indexOf(entry.hash);
            if (laneIndex === -1) {
                laneIndex = lanes.findIndex(l => l === null);
                if (laneIndex === -1) laneIndex = lanes.length;
                lanes[laneIndex] = entry.hash;
            }
            
            const currentLane = laneIndex;
            const isFirst = idx === 0;
            const isLast = idx === filtered.length - 1;

            const graphCol = document.createElement('div');
            graphCol.className = 'git-graph-col';
            if (showGraph) lanes.forEach((laneHash, lIdx) => {
                const lane = document.createElement('div');
                lane.className = 'git-graph-lane';
                if (lIdx === currentLane) {
                    lane.classList.add('commit-dot');
                    lane.innerHTML = '<span class="dot"></span>';
                } else if (laneHash !== null) {
                    lane.classList.add('vertical-line');
                }
                
                if (isFirst) lane.classList.add('lane-initial');
                if (isLast) lane.classList.add('lane-terminal');
                
                graphCol.appendChild(lane);
            });

            const refsHtml = this._formatRefs(entry.refs);

            // User Request: Compact 1-line layout
            // [ID] [Author] [Date] [Message] [Refs]
            item.innerHTML = `
                <div class="git-hist-graph-part"></div>
                <div class="git-hist-content-v4">
                    <span class="git-hist-hash-v4">${entry.short_hash}</span>
                    <span class="git-hist-author-v4" title="${entry.author}">${this._truncate(entry.author, 8)}</span>
                    <span class="git-hist-date-v4">${entry.date}</span>
                    <span class="git-hist-msg-v4" title="${entry.message}">${this._truncate(entry.message, 30)}</span>
                    ${refsHtml}
                </div>
            `;
            item.querySelector('.git-hist-graph-part').appendChild(graphCol);
            container.appendChild(item);

            // Highlight the commit currently marked as the compare base.
            if (this._compareBase && this._compareBase.hash === entry.hash) {
                item.classList.add('git-compare-base');
            }

            item.onclick = (e) => {
                // Shift-click compares the shift-clicked commit against the base
                // (or, if no base yet, just selects it as the base).
                if (e.shiftKey && this._compareBase && this._compareBase.hash !== entry.hash) {
                    this._compareCommits(this._compareBase, entry);
                    return;
                }
                this.showCommitDiff(entry.hash, entry.message);
            };

            item.oncontextmenu = (e) => this._showHistoryContextMenu(e, entry);

            if (entry.parents && entry.parents.length > 0) {
                lanes[currentLane] = entry.parents[0];
                for (let i = 1; i < entry.parents.length; i++) {
                    const p = entry.parents[i];
                    if (!lanes.includes(p)) {
                        let nextFree = lanes.indexOf(null);
                        if (nextFree === -1) lanes.push(p);
                        else lanes[nextFree] = p;
                    }
                }
            } else {
                lanes[currentLane] = null;
            }
        });
    }

    // ── History compare ──────────────────────────────────────────────────────

    _setCompareBase(entry) {
        this._compareBase = entry;
        const hint = this.element.querySelector('#git-compare-hint');
        if (hint) {
            hint.style.display = 'inline';
            hint.textContent = `Base: ${entry.short_hash} — Shift+click another`;
            hint.title = entry.message || '';
        }
        this._renderHistory(); // re-render to show the base highlight
    }

    _clearCompareBase() {
        this._compareBase = null;
        const hint = this.element.querySelector('#git-compare-hint');
        if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
        this._renderHistory();
    }

    _showHistoryContextMenu(e, entry) {
        const items = [
            { label: 'Select for Compare', action: () => this._setCompareBase(entry) },
        ];
        if (this._compareBase && this._compareBase.hash !== entry.hash) {
            items.push({
                label: `Compare with base (${this._compareBase.short_hash})`,
                action: () => this._compareCommits(this._compareBase, entry),
            });
        }
        items.push({
            label: 'Compare with Working Tree',
            action: () => this._compareWithWorkingTree(entry),
        });
        if (this._compareBase) {
            items.push({ label: 'Clear Base', action: () => this._clearCompareBase() });
        }
        ContextMenu.show(e, items);
    }

    /** Compare two commits: fromEntry (older base) → toEntry. */
    /**
     * Push the current branch, publishing it if it has never been pushed.
     *
     * A plain `git push` fails on a branch with no upstream, which is exactly
     * the branch you most want to push. Creating a remote branch is a visible,
     * shared act though, so it is confirmed rather than done silently.
     */
    async push() {
        if (!State.gitRoot) return;
        try {
            const upstream = await invoke('git_upstream', { path: State.gitRoot });
            if (upstream) {
                await invoke('git_push', { path: State.gitRoot });
            } else {
                const branch = this._activeBranch;
                if (!branch) {
                    await showAlert('No branch is checked out.', { title: 'Push', kind: 'warning' });
                    return;
                }
                const ok = await showConfirm(
                    `'${branch}' has never been pushed.\n\nPublish it as origin/${branch} and track it from now on?`,
                    { title: 'Push', kind: 'warning', okLabel: 'Push' });
                if (!ok) return;
                await invoke('git_push', {
                    path: State.gitRoot, remote: 'origin', branch, setUpstream: true,
                });
            }
            this.refresh();
        } catch (e) {
            showAlert(`Push failed: ${e}`, { title: 'Git', kind: 'error' });
        }
    }

    /**
     * Open a pull request for the current branch.
     *
     * Two routes, because neither covers everyone: the GitHub CLI creates the PR
     * outright when it is installed AND signed in, and otherwise the forge's own
     * "new pull request" page is opened with the title and body prefilled, which
     * needs nothing installed and works from a browser session.
     */
    async createPullRequest() {
        if (!State.gitRoot) {
            await showAlert('No Git repository is open.', { title: 'Pull Request', kind: 'info' });
            return;
        }
        const head = this._activeBranch;
        if (!head) {
            await showAlert('No branch is checked out.', { title: 'Pull Request', kind: 'warning' });
            return;
        }

        const [{ local }, remoteUrl, defaultBranch] = await Promise.all([
            this._listRefs(),
            invoke('git_remote_url', { path: State.gitRoot }).catch(() => ''),
            invoke('git_default_branch', { path: State.gitRoot }).catch(() => null),
        ]);
        if (!remoteUrl) {
            await showAlert('This repository has no "origin" remote to open a pull request against.',
                { title: 'Pull Request', kind: 'warning' });
            return;
        }
        const repo = parseRemoteUrl(remoteUrl);

        // A branch cannot be reviewed until it exists on the remote.
        const upstream = await invoke('git_upstream', { path: State.gitRoot });
        if (!upstream) {
            const ok = await showConfirm(
                `'${head}' has not been pushed yet, so there is nothing to review.\n\nPush it to origin first?`,
                { title: 'Pull Request', kind: 'warning', okLabel: 'Push' });
            if (!ok) return;
            try {
                await invoke('git_push', {
                    path: State.gitRoot, remote: 'origin', branch: head, setUpstream: true,
                });
                this.refresh();
            } catch (e) {
                showAlert(`Push failed: ${e}`, { title: 'Git', kind: 'error' });
                return;
            }
        }

        // The last commit's subject is the title nine times out of ten.
        let subject = '';
        try {
            const log = await invoke('git_log', { path: State.gitRoot, count: 1 });
            subject = String(log?.[0]?.message || '').split('\n')[0];
        } catch (e) { /* a fresh repo has no log */ }

        const bases = local.filter((b) => b !== head);
        const base = defaultBranch && bases.includes(defaultBranch) ? defaultBranch
            : bases.find((b) => b === 'main' || b === 'master') || bases[0] || defaultBranch || '';
        if (!base) {
            await showAlert('There is no other branch to merge into.',
                { title: 'Pull Request', kind: 'warning' });
            return;
        }

        const form = document.createElement('div');
        form.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:8px 10px;align-items:center;margin-top:4px;';
        const label = (text) => {
            const el = document.createElement('label');
            el.textContent = text;
            el.style.cssText = 'font-size:12px;color:var(--text-secondary);white-space:nowrap;';
            return el;
        };

        const baseSel = createFilterSelect({
            items: bases.length ? bases : [base], value: base, placeholder: 'base branch…',
        });
        baseSel.element.style.width = '100%';

        const headEl = document.createElement('div');
        headEl.textContent = head;
        headEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--primary-color);';

        const INPUT_CSS = 'width:100%;box-sizing:border-box;padding:5px 7px;font:inherit;font-size:12px;color:var(--text-color);background:var(--bg-color-secondary);border:1px solid var(--border-color);border-radius:3px;';
        const titleEl = document.createElement('input');
        titleEl.type = 'text';
        titleEl.value = subject;
        titleEl.placeholder = 'Pull request title';
        titleEl.style.cssText = INPUT_CSS;

        const bodyEl = document.createElement('textarea');
        bodyEl.rows = 6;
        bodyEl.placeholder = 'Description (optional)';
        bodyEl.style.cssText = INPUT_CSS + 'resize:vertical;line-height:1.5;';
        // Enter must insert a newline here, not fire the dialog's primary button.
        bodyEl.dataset.dialogKeys = 'own';

        const draftRow = document.createElement('label');
        draftRow.style.cssText = 'grid-column:1 / -1;display:flex;align-items:center;gap:7px;font-size:12px;';
        const draftCb = document.createElement('input');
        draftCb.type = 'checkbox';
        draftRow.append(draftCb, Object.assign(document.createElement('span'),
            { textContent: 'Open as a draft' }));

        form.append(label('Base'), baseSel.element, label('Compare'), headEl,
            label('Title'), titleEl, label('Description'), bodyEl, draftRow);

        const go = await showDialog({
            title: 'New Pull Request',
            message: repo ? `${repo.owner}/${repo.repo}` : remoteUrl,
            kind: 'info',
            width: 'min(620px, 92vw)',
            content: form,
            buttons: [
                { label: 'Cancel', value: false, cancel: true },
                { label: 'Create', value: true, primary: true },
            ],
        });
        if (!go) return;

        const chosenBase = baseSel.getValue();
        const title = titleEl.value.trim() || subject || head;
        const body = bodyEl.value;
        if (chosenBase === head) {
            await showAlert('A branch cannot be merged into itself.',
                { title: 'Pull Request', kind: 'warning' });
            return;
        }

        const gh = await invoke('gh_available', { path: State.gitRoot }).catch(() => false);
        if (gh) {
            try {
                const url = await invoke('gh_pr_create', {
                    path: State.gitRoot, base: chosenBase, head, title, body,
                    draft: draftCb.checked,
                });
                const wantsOpen = await showDialog({
                    title: 'Pull Request', kind: 'info',
                    message: `Created:\n${url}`,
                    buttons: [
                        { label: 'Close', value: false, cancel: true },
                        { label: 'Open in Browser', value: true, primary: true },
                    ],
                });
                if (wantsOpen) this._openExternal(url);
                return;
            } catch (e) {
                // gh knows things the URL route does not (a PR already open for
                // this branch, a protected base). Say so rather than silently
                // opening a page that will report the same thing.
                showAlert(`gh could not create the pull request:\n${e}`,
                    { title: 'Pull Request', kind: 'error' });
                return;
            }
        }

        const url = pullRequestUrl(repo, chosenBase, head, { title, body });
        if (!url) {
            await showAlert(`Install the GitHub CLI (gh) to open pull requests from here, or do it on the web:\n${remoteUrl}`,
                { title: 'Pull Request', kind: 'info' });
            return;
        }
        this._openExternal(url);
    }

    _openExternal(url) {
        open(url).catch((err) => {
            console.warn('Failed to open URL:', err);
            try { window.open(url, '_blank'); } catch (e) { /* ignore */ }
        });
    }

    /**
     * Every ref worth comparing: local branches first, then remote-tracking ones
     * (`%(refname:short)` renders those as `origin/main`), then tags.
     */
    async _listRefs() {
        const run = async (cmd) => {
            try {
                const out = await invoke('run_command', { command: cmd, cwd: State.gitRoot });
                return String(out || '').split('\n').map(cleanRef).filter(Boolean);
            } catch (e) {
                return [];
            }
        };
        const local = await run('git branch --format=%(refname:short)');
        const remote = (await run('git branch -r --format=%(refname:short)'))
            // origin/HEAD is a symbolic pointer, not something to diff against.
            .filter((r) => !r.endsWith('/HEAD'));
        const tags = await run('git tag --sort=-creatordate');
        return { local, remote, tags };
    }

    /** The commit a ref points at. `^{commit}` peels annotated tags. */
    async _revCommit(ref) {
        try {
            const out = await invoke('run_command', {
                command: `git rev-parse ${ref}^{commit}`, cwd: State.gitRoot,
            });
            return String(out || '').trim().split('\n')[0] || '';
        } catch (e) {
            return '';
        }
    }

    /**
     * Compare two refs and list the files that differ.
     *
     * Defaults to the three-dot form (`base...compare`), which is what every
     * review tool means by "compare branches": only what happened on the compare
     * side since the two diverged, not the base's own newer commits. The merge
     * base is resolved to a real hash up front so the file list and each file's
     * diff are computed against exactly the same revision.
     */
    async compareBranches() {
        if (!State.gitRoot) {
            await showAlert('No Git repository is open.', { title: 'Compare', kind: 'info' });
            return;
        }

        const { local, remote, tags } = await this._listRefs();
        if (local.length + remote.length === 0) {
            await showAlert('No branches to compare.', { title: 'Compare', kind: 'info' });
            return;
        }

        const current = this._activeBranch || local[0];
        const form = document.createElement('div');
        form.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:8px 10px;align-items:center;margin-top:4px;';

        const groupsFor = (extra) => [
            ...(extra ? [{ label: '', items: extra }] : []),
            { label: 'Local', items: local },
            { label: 'Remote', items: remote },
            { label: 'Tags', items: tags },
        ].filter((g) => g.items.length);

        const label = (text) => {
            const el = document.createElement('label');
            el.textContent = text;
            el.style.cssText = 'font-size:12px;color:var(--text-secondary);white-space:nowrap;';
            return el;
        };

        // The working tree is only meaningful as the RIGHT side of a comparison.
        const WORKING_TREE = 'Working Tree';
        const baseSel = createFilterSelect({
            groups: groupsFor(null), value: current, placeholder: 'base ref…',
        });
        const headSel = createFilterSelect({
            groups: groupsFor([WORKING_TREE]),
            value: remote.find((r) => r.endsWith('/' + current))
                || local.find((b) => b !== current)
                || WORKING_TREE,
            placeholder: 'compare ref…',
        });
        baseSel.element.style.width = '100%';
        headSel.element.style.width = '100%';

        const mergeBaseRow = document.createElement('label');
        mergeBaseRow.style.cssText = 'grid-column:1 / -1;display:flex;align-items:center;gap:7px;font-size:12px;';
        const mergeBaseCb = document.createElement('input');
        mergeBaseCb.type = 'checkbox';
        mergeBaseCb.checked = true;
        mergeBaseRow.append(mergeBaseCb,
            Object.assign(document.createElement('span'),
                { textContent: 'Compare from the common ancestor (base...compare)' }));

        form.append(label('Base'), baseSel.element, label('Compare'), headSel.element, mergeBaseRow);

        const go = await showDialog({
            title: 'Compare Branches',
            message: 'Pick the two refs to diff.',
            kind: 'info',
            // Ref names are long (`origin/feature/something-descriptive`) and
            // there are two of them plus a label column.
            width: 'min(620px, 92vw)',
            content: form,
            buttons: [
                { label: 'Cancel', value: false, cancel: true },
                { label: 'Compare', value: true, primary: true },
            ],
        });
        if (!go) return;

        const base = baseSel.getValue();
        // '' is what git_diff_files reads as "the working tree".
        const head = headSel.getValue() === WORKING_TREE ? '' : headSel.getValue();
        if (base === head) {
            await showAlert('Pick two different refs.', { title: 'Compare', kind: 'warning' });
            return;
        }

        // The merge base only matters against a committed right-hand side.
        const useMergeBase = mergeBaseCb.checked && head !== '';
        let mergeBase = '';
        let headCommit = '';
        if (useMergeBase) {
            try {
                const mb = await invoke('run_command', {
                    command: `git merge-base ${base} ${head}`, cwd: State.gitRoot,
                });
                mergeBase = String(mb || '').trim().split('\n')[0];
                headCommit = await this._revCommit(head);
            } catch (e) {
                // Unrelated histories, or a ref git can't resolve.
                console.warn('merge-base failed, using a direct diff:', e);
            }
        }
        const { fromRev, fromLabel, note } = resolveCompareBase({
            base, head, useMergeBase, mergeBase, headCommit,
        });

        try {
            const files = await invoke('git_diff_files', {
                path: State.gitRoot, fromRev, toRev: head,
            });
            this._showCompareFileList(
                { rev: fromRev, short: base, label: fromLabel },
                { rev: head, short: head || 'WT', label: head || 'Working Tree' },
                files,
                `${base} … ${head || 'Working Tree'}`,
                note,
            );
        } catch (err) {
            console.error('git_diff_files (branches) failed:', err);
            await showAlert('Comparison failed: ' + (err && err.message ? err.message : err),
                { title: 'Compare', kind: 'error' });
        }
    }

    async _compareCommits(fromEntry, toEntry) {
        try {
            const files = await invoke('git_diff_files', {
                path: State.gitRoot, fromRev: fromEntry.hash, toRev: toEntry.hash,
            });
            this._showCompareFileList(
                { rev: fromEntry.hash, short: fromEntry.short_hash, label: fromEntry.short_hash },
                { rev: toEntry.hash, short: toEntry.short_hash, label: toEntry.short_hash },
                files,
                `${fromEntry.short_hash} … ${toEntry.short_hash}`,
            );
        } catch (err) {
            console.error('git_diff_files (commits) failed:', err);
            showAlert('Comparison failed: ' + (err && err.message ? err.message : err), { title: 'Compare', kind: 'error' });
        }
    }

    /** Compare a commit against the current working tree. */
    async _compareWithWorkingTree(entry) {
        try {
            const files = await invoke('git_diff_files', {
                path: State.gitRoot, fromRev: entry.hash, toRev: '',
            });
            this._showCompareFileList(
                { rev: entry.hash, short: entry.short_hash, label: entry.short_hash },
                { rev: '', short: 'WT', label: 'Working Tree' },
                files,
                `${entry.short_hash} … Working Tree`,
            );
        } catch (err) {
            console.error('git_diff_files (working tree) failed:', err);
            showAlert('Comparison failed: ' + (err && err.message ? err.message : err), { title: 'Compare', kind: 'error' });
        }
    }

    /** Read a file at a revision; rev === '' means the working-tree copy on disk. */
    async _readFileAtRev(rev, file) {
        if (rev === '') {
            try {
                const fullPath = `${State.gitRoot}/${file}`.replace(/\\/g, '/');
                const data = await invoke('read_file_auto_detect', { path: fullPath });
                return data.content;
            } catch (e) { return ''; } // deleted in working tree
        }
        try {
            return await invoke('git_show', { path: State.gitRoot, revision: rev, file });
        } catch (e) { return ''; } // absent in that revision (added/deleted)
    }

    async _showCompareDiff(from, to, file) {
        const original = await this._readFileAtRev(from.rev, file);
        const modified = await this._readFileAtRev(to.rev, file);
        window.app.openDiffEditor(original, modified, file, null, null, null, {
            compareMode: true,
            leftLabel: `${file} (${from.label})`,
            rightLabel: `${file} (${to.label})`,
        });
    }

    /** File list for a two-revision comparison (reuses the commit file-list UI). */
    _showCompareFileList(from, to, files, title, note = '') {
        const panel = this._showDetailPanel();
        if (!panel) return;
        panel.innerHTML = '';

        const listContainer = document.createElement('div');
        listContainer.className = 'git-commit-file-list-container';

        const header = document.createElement('div');
        header.style.cssText = 'padding:8px 12px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:8px;';
        header.innerHTML = `<span style="font-weight:600;font-size:12px;">⇄ ${title}</span>
            <span style="color:var(--text-secondary);font-size:11px;flex:1;text-align:right;">${files.length} files</span>
            <button class="git-commit-file-close" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:2px 4px;" title="Close">✕</button>`;
        header.querySelector('.git-commit-file-close').onclick = () => this._hideDetailPanel();
        listContainer.appendChild(header);

        if (note) {
            const hint = document.createElement('div');
            hint.style.cssText = 'padding:6px 12px;font-size:11px;color:var(--text-secondary);'
                + 'border-bottom:1px solid var(--border-color);';
            hint.textContent = note;
            listContainer.appendChild(hint);
        }

        if (files.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:10px 12px;font-size:11px;color:var(--text-secondary);';
            empty.textContent = `No differences between ${from.label} and ${to.label}.`;
            listContainer.appendChild(empty);
        } else {
            const tree = document.createElement('div');
            tree.className = 'git-cmp-tree';
            this._renderCompareTree(tree, buildFileTree(files), from, to, 0);
            listContainer.appendChild(tree);
        }

        panel.appendChild(listContainer);
    }

    /**
     * One level of the comparison tree. Directories are collapsible; the rows
     * are deliberately dense — a 245-file comparison is unusable as a flat list.
     */
    _renderCompareTree(host, node, from, to, depth) {
        const pad = (d) => 8 + d * 12;

        for (const dir of node.dirs) {
            const row = document.createElement('div');
            row.className = 'git-cmp-dir';
            row.style.paddingLeft = `${pad(depth)}px`;
            const caret = document.createElement('span');
            caret.className = 'git-cmp-caret';
            caret.textContent = '▾';
            const name = document.createElement('span');
            name.className = 'git-cmp-dir-name';
            name.textContent = dir.name;
            const count = document.createElement('span');
            count.className = 'git-cmp-count';
            count.textContent = String(countFiles(dir));
            row.append(caret, name, count);

            const children = document.createElement('div');
            this._renderCompareTree(children, dir, from, to, depth + 1);

            row.onclick = () => {
                const hidden = children.style.display === 'none';
                children.style.display = hidden ? '' : 'none';
                caret.textContent = hidden ? '▾' : '▸';
            };

            host.append(row, children);
        }

        for (const file of node.files) {
            const item = document.createElement('div');
            item.className = 'git-cmp-file';
            item.style.paddingLeft = `${pad(depth) + 12}px`;
            item.title = file.path;
            const status = document.createElement('span');
            status.className = `git-cmp-status git-cmp-status-${file.status}`;
            status.textContent = file.status;
            const name = document.createElement('span');
            name.className = 'git-cmp-file-name';
            name.textContent = file.name;
            item.append(status, name);
            item.onclick = () => this._showCompareDiff(from, to, file.path);
            host.appendChild(item);
        }
    }

    async showCommitDiff(hash, message) {
        try {
            // Show commit detail info header first
            this._showCommitDetail(hash);

            const files = await invoke('git_commit_files', { path: State.gitRoot, hash: hash });
            if (files.length === 0) return;

            // If only one file changed, show its diff directly
            if (files.length === 1) {
                await this._showCommitFileDiff(hash, files[0].path);
                return;
            }

            // Multiple files: show a file list in the Git panel for the user to pick.
            this._showCommitFileList(hash, message, files);
        } catch (e) {
            console.error('Failed to get commit diff:', e);
        }
    }

    /** Show commit detail info (hash, author, email, date, branches, tags). */
    _showCommitDetail(hash) {
        // Find the full entry from lastHistory
        const entry = (this._lastHistory || []).find(e => e.hash === hash);
        if (!entry) return;

        const panel = this._showDetailPanel();
        if (!panel) return;

        // Fresh panel for the selected commit (shown below the history graph).
        panel.innerHTML = '';

        const detail = document.createElement('div');
        detail.className = 'git-commit-detail-container';
        detail.style.cssText = 'padding:10px 12px;';

        // Parse refs for branches and tags
        let branchesHtml = '';
        let tagsHtml = '';
        if (entry.refs) {
            const refs = entry.refs.split(', ').map(r => r.trim()).filter(Boolean);
            refs.forEach(r => {
                if (r.includes('tag:')) {
                    const tagName = r.replace('tag:', '').trim();
                    tagsHtml += `<span style="background:rgba(56,139,253,0.15);color:#58a6ff;padding:1px 6px;border-radius:3px;font-size:10px;white-space:nowrap;">🏷 ${tagName}</span>`;
                } else if (r.startsWith('HEAD ->') || r.includes('origin/') || r.includes('->')) {
                    branchesHtml += `<span style="background:rgba(63,185,80,0.15);color:#3fb950;padding:1px 6px;border-radius:3px;font-size:10px;white-space:nowrap;">🌿 ${r}</span>`;
                } else {
                    branchesHtml += `<span style="background:rgba(63,185,80,0.15);color:#3fb950;padding:1px 6px;border-radius:3px;font-size:10px;white-space:nowrap;">${r}</span>`;
                }
            });
        }

        detail.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <span style="font-size:12px;font-weight:600;font-family:monospace;color:var(--text-color);">${entry.hash}</span>
                <button class="git-commit-detail-close" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:2px 4px;" title="Close">✕</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-secondary);">
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="min-width:50px;opacity:0.7;">Author:</span>
                    <span style="color:var(--text-color);">${entry.author}</span>
                    <span style="opacity:0.5;">&lt;${entry.author_email || ''}&gt;</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="min-width:50px;opacity:0.7;">Date:</span>
                    <span>${entry.date}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="min-width:50px;opacity:0.7;">Message:</span>
                    <span style="color:var(--text-color);">${entry.message}</span>
                </div>
                ${(branchesHtml || tagsHtml) ? `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <span style="min-width:50px;opacity:0.7;">Refs:</span>
                    <div style="display:flex;gap:4px;flex-wrap:wrap;">${branchesHtml}${tagsHtml}</div>
                </div>` : ''}
                ${entry.parents && entry.parents.length > 1 ? `<div style="display:flex;align-items:center;gap:6px;">
                    <span style="min-width:50px;opacity:0.7;">Merge:</span>
                    <span style="font-family:monospace;font-size:10px;">${entry.parents.map(p => p.substring(0, 7)).join(', ')}</span>
                </div>` : ''}
            </div>
        `;

        detail.querySelector('.git-commit-detail-close').onclick = () => this._hideDetailPanel();

        panel.appendChild(detail);
    }

    /** Show a clickable file list inside the Git panel for multi-file commits. */
    _showCommitFileList(hash, message, files) {
        const panel = this._showDetailPanel();
        if (!panel) return;

        // Remove any existing file list (keep the detail info above it).
        const existing = panel.querySelector('.git-commit-file-list-container');
        if (existing) existing.remove();

        const listContainer = document.createElement('div');
        listContainer.className = 'git-commit-file-list-container';
        listContainer.style.cssText = 'border-top:1px solid var(--border-color);';

        // Commit info header
        const header = document.createElement('div');
        header.style.cssText = 'padding:8px 12px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:8px;';
        header.innerHTML = `<span style="font-weight:600;font-size:12px;">${hash.substring(0, 7)}</span>
            <span style="color:var(--text-secondary);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._truncate(message, 40)}</span>
            <span style="color:var(--text-secondary);font-size:11px;">${files.length} files</span>
            <button class="git-commit-file-close" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:2px 4px;" title="Close">✕</button>`;
        listContainer.appendChild(header);

        // Close button handler
        header.querySelector('.git-commit-file-close').onclick = () => listContainer.remove();

        // File list
        files.forEach(f => {
            const item = document.createElement('div');
            item.className = 'git-commit-file-item';
            item.style.cssText = 'padding:5px 12px 5px 24px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px;border-bottom:1px solid var(--border-color);';
            
            const statusColor = f.status === 'A' ? '#3fb950' : f.status === 'D' ? '#f85149' : '#d29922';
            item.innerHTML = `<span style="color:${statusColor};font-weight:600;font-size:10px;min-width:12px;">${f.status}</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-family);">${f.path}</span>`;
            
            item.onmouseenter = () => item.style.background = 'var(--bg-color-hover, rgba(127,127,127,0.1))';
            item.onmouseleave = () => item.style.background = '';
            item.onclick = async () => {
                await this._showCommitFileDiff(hash, f.path);
            };
            
            listContainer.appendChild(item);
        });

        panel.appendChild(listContainer);
    }

    /** Show the before/after diff for a single file within a commit. */
    async _showCommitFileDiff(hash, file) {
        try {
            // Get the parent commit's version of this file
            let original = '';
            try {
                original = await invoke('git_show', { path: State.gitRoot, revision: `${hash}^`, file: file });
            } catch (err) {
                // First commit or new file — no parent
                original = '';
            }

            // Get this commit's version
            const modified = await invoke('git_show', { path: State.gitRoot, revision: hash, file: file });

            window.app.openDiffEditor(original, modified, file, null, null, null, {
                compareMode: true,
                leftLabel: `${file} (Before — ${hash.substring(0, 7)}^)`,
                rightLabel: `${file} (After — ${hash.substring(0, 7)})`
            });
        } catch (e) {
            console.error('Failed to show file diff:', e);
        }
    }

    _truncate(str, n) {
        if (!str) return '';
        return str.length > n ? str.substr(0, n - 1) + '…' : str;
    }

    _formatRefs(refs) {
        if (!refs) return '';
        const parts = refs.split(', ').map(r => r.trim());
        let html = '<div class="git-refs-container-v4">';
        parts.forEach(r => {
            let className = 'git-ref-tag-v4';
            if (r.startsWith('HEAD ->')) {
                className += ' git-ref-head-v4';
                r = r.replace('HEAD ->', 'HEAD:');
            } else if (r.includes('origin/')) {
                className += ' git-ref-remote-v4';
            }
            html += `<span class="${className}">${r}</span>`;
        });
        html += '</div>';
        return html;
    }

    async stageFile(path) {
        await invoke('git_add', { path: State.gitRoot, file: path });
        this.refresh();
    }

    async unstageFile(path) {
        await invoke('git_unstage', { path: State.gitRoot, file: path });
        this.refresh();
    }

    async commit() {
        const input = this.element.querySelector('#git-commit-input');
        const msg = input.value.trim();
        if (!msg) {
            showAlert('Commit message is required', { title: 'Commit', kind: 'warning' });
            return;
        }

        try {
            await invoke('git_commit', { path: State.gitRoot, message: msg });
            input.value = '';
            this.element.querySelector('#git-commit-overlay').style.display = 'none';
            this.refresh();
        } catch (e) {
            showAlert(`Commit failed: ${e}`, { title: 'Commit', kind: 'error' });
        }
    }

    /**
     * Generate a commit message from the staged diff using the AI single-shot
     * path. Writes the result into the commit textarea for the user to review
     * (never commits automatically).
     */
    async generateCommitMessage() {
        const input = this.element.querySelector('#git-commit-input');
        if (!State.gitRoot) return;

        let diff = '';
        try {
            diff = await invoke('git_diff', { path: State.gitRoot, filePath: null, staged: true });
        } catch (e) {
            diff = '';
        }
        // No staged diff: fall back to the unstaged working-tree diff so the
        // button is still useful before the user stages.
        if (!diff || !diff.trim()) {
            try {
                diff = await invoke('git_diff', { path: State.gitRoot, filePath: null, staged: false });
            } catch (e) {
                diff = '';
            }
        }

        if (!diff || !diff.trim()) {
            showAlert('Nothing staged yet — stage the changes you want described.', { title: 'Commit Message', kind: 'info' });
            return;
        }

        input.placeholder = '✨ Generating…';
        input.value = '';

        try {
            const message = await AIAgent.runSingleShot({
                prompt: `以下は git diff です。これに対する規約準拠のコミットメッセージを1件だけ生成してください。

制約:
- 1行目に summary（50文字以内、prefix 付き）。
- 必要なら空行の後に詳細な説明。
- 説明や注釈は含めず、コミットメッセージのみを返す。

--- git diff ---
${diff.slice(0, 12000)}`,
                systemPrompt: 'You generate a concise conventional-commit message from a git diff. Respond in English.',
            });
            const cleaned = (message || '').trim().replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '').trim();
            input.value = cleaned || '';
            input.placeholder = 'Commit message (Required)';
            if (cleaned) input.focus();
        } catch (e) {
            input.placeholder = 'Commit message (Required)';
            const msg = (e && e.message) || String(e);
            if (/not reachable|failed to fetch|connection refused/i.test(msg)) {
                showAlert('Cannot reach J.H AI Agent. Start the agent and try again.', { title: 'Commit Message', kind: 'error' });
            } else {
                showAlert(`Could not generate a commit message: ${msg}`, { title: 'Commit Message', kind: 'error' });
            }
        }
    }

    async showDiff(filePath, isStaged) {
        if (!State.gitRoot || !window.app?.openDiffEditor) return;
        
        try {
            // Original: Fetch from HEAD
            let original = '';
            try {
                original = await invoke('git_show', { 
                    path: State.gitRoot, 
                    revision: 'HEAD', 
                    file: filePath 
                });
            } catch (e) {
                original = ''; // new file, nothing in HEAD
            }

            let modified = "";
            if (isStaged) {
                // Modified: Fetch from Index
                try {
                    modified = await invoke('git_show', { 
                        path: State.gitRoot, 
                        revision: '', 
                        file: filePath 
                    });
                } catch (e) {
                    modified = '';
                }
            } else {
                // Modified: Fetch from Disk (deleted files are empty — the diff
                // then correctly shows HEAD content on the left, nothing on the
                // right).
                const fullPath = `${State.gitRoot}/${filePath}`.replace(/\\/g, '/');
                try {
                    const fileData = await invoke('read_file_auto_detect', { path: fullPath });
                    modified = fileData ? fileData.content : '';
                } catch (e) {
                    modified = '';
                }
            }

            // Build ordered file list for Ctrl+Up/Down navigation between diffs
            const fileList = this._getDiffFileList(isStaged);
            const currentIndex = fileList.findIndex(f => f.path === filePath);

            // Expose navigation callbacks so DiffEditor can use Ctrl+Down/Up
            window.app._gitDiffNav = {
                fileList,
                currentIndex,
                isStaged,
                onNextFile: () => this._navigateDiffFile(fileList, currentIndex, 1, isStaged),
                onPrevFile: () => this._navigateDiffFile(fileList, currentIndex, -1, isStaged),
            };

            window.app.openDiffEditor(original, modified, filePath, async (editedContent) => {
                // Option to save changes back to disk? 
                // For now, Git Diff is mostly for viewing.
                // But we could implement 'Apply' if needed.
            });
        } catch (e) {
            console.error('Failed to show diff:', e);
        }
    }

    /** Human-readable meaning of a one-letter git status badge. */
    _statusLabel(status) {
        switch (status) {
            case 'U': return 'Untracked (new file / folder)';
            case 'M': return 'Modified';
            case 'D': return 'Deleted';
            case 'S': return 'Staged';
            case 'A': return 'Added';
            default: return status;
        }
    }

    /** Get the flat list of changed files for navigation. */
    _getDiffFileList(isStaged) {
        const section = isStaged ? 'staged' : 'changes';
        const listEl = this.element.querySelector(section === 'staged' ? '#git-list-staged' : '#git-list-changes');
        if (!listEl) return [];
        // Collect file paths from the rendered tree items
        const fileItems = listEl.querySelectorAll('.git-file');
        const files = [];
        fileItems.forEach(item => {
            const label = item.querySelector('.git-tree-label');
            const title = label ? label.getAttribute('title') : null;
            if (title) files.push({ path: title, isStaged });
        });
        return files;
    }

    /** Navigate to next/prev diff file in the list. */
    async _navigateDiffFile(fileList, currentIndex, direction, isStaged) {
        const nextIndex = currentIndex + direction;
        if (nextIndex < 0 || nextIndex >= fileList.length) return; // skip if out of bounds
        const nextFile = fileList[nextIndex];
        if (nextFile) {
            await this.showDiff(nextFile.path, isStaged);
        }
    }
}

export default GitPanel;
