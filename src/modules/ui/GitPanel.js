import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { State } from '../core/Store.js';
import { ContextMenu } from './ContextMenu.js';

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
                    <select id="git-branch-select" class="git-branch-dropdown"></select>
                </div>
                <div class="git-v2-toolbar">
                    <button id="git-fetch-btn" title="Fetch All">⟳</button>
                    <button id="git-pull-btn" title="Pull">⤓</button>
                    <button id="git-push-btn" title="Push">⤒</button>
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

            <!-- Commit detail panel (shown below the history, not over it) -->
            <div id="git-commit-detail-panel" class="git-commit-detail-panel" style="display:none;"></div>

            <!-- Commit Modal -->
            <div id="git-commit-overlay" class="git-modal-overlay" style="display:none;">
                <div class="git-modal">
                    <h3>Commit Changes</h3>
                    <textarea id="git-commit-input" placeholder="Commit message (Required)"></textarea>
                    <div class="git-modal-btns">
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
        this.element.querySelector('#git-fetch-btn').onclick = () => this.executeGit('git_fetch');
        this.element.querySelector('#git-pull-btn').onclick = () => this.executeGit('git_pull');
        this.element.querySelector('#git-push-btn').onclick = () => this.executeGit('git_push');
        
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
            alert(`Git Error: ${e}`);
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

    async refresh() {
        this._renderRepoSelector();
        
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
                <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;">Gitリポジトリが見つかりませんでした</div>
                <button id="git-init-btn" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:var(--primary-color, #3b82f6);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;transition:opacity 0.15s;">
                    <span style="font-size:14px;">＋</span> 新規リポジトリを作成
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
                    alert(`Git init failed: ${e}`);
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
        try {
            const output = await invoke('run_command', { 
                command: 'git branch --format="%(refname:short)"', 
                cwd: State.gitRoot 
            });
            const branches = output.split('\n').map(b => b.trim()).filter(b => b.length > 0);
            
            const select = this.element.querySelector('#git-branch-select');
            if (select) {
                select.innerHTML = branches.map(b => `
                    <option value="${b}" ${b === activeBranch ? 'selected' : ''}>${b}</option>
                `).join('');
                
                select.onchange = async (e) => {
                    const newBranch = e.target.value;
                    try {
                        await invoke('run_command', { 
                            command: `git checkout ${newBranch}`, 
                            cwd: State.gitRoot 
                        });
                        this.refresh();
                    } catch (err) {
                        alert(`Checkout failed: ${err.message || err}`);
                        this.refresh();
                    }
                };
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
                            const yes = await ask(confirmMsg, { title: 'Discard Changes', kind: 'warning' });
                            if (yes) {
                                try {
                                    await invoke('git_discard', { path: State.gitRoot, file: file.path, status: file.status });
                                    this.refresh();
                                } catch (err) {
                                    alert(`Discard failed: ${err}`);
                                }
                            }
                        };
                    }

                    const ignoreBtn = div.querySelector('.git-ignore-btn');
                    if (ignoreBtn) {
                        ignoreBtn.onclick = async (e) => {
                            e.stopPropagation();
                            const yes = await ask(`Are you sure you want to add "${filename}" to .gitignore?`, { title: 'Ignore File' });
                            if (yes) {
                                try {
                                    await invoke('git_ignore', { path: State.gitRoot, file: file.path });
                                    this.refresh();
                                } catch (err) {
                                    alert(`Ignore failed: ${err}`);
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
            alert('Comparison failed: ' + (err && err.message ? err.message : err));
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
            alert('Comparison failed: ' + (err && err.message ? err.message : err));
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
    _showCompareFileList(from, to, files, title) {
        const panel = this.element.querySelector('#git-commit-detail-panel');
        if (!panel) return;
        panel.innerHTML = '';
        panel.style.display = 'block';

        const listContainer = document.createElement('div');
        listContainer.className = 'git-commit-file-list-container';

        const header = document.createElement('div');
        header.style.cssText = 'padding:8px 12px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:8px;';
        header.innerHTML = `<span style="font-weight:600;font-size:12px;">⇄ ${title}</span>
            <span style="color:var(--text-secondary);font-size:11px;flex:1;text-align:right;">${files.length} files</span>
            <button class="git-commit-file-close" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:2px 4px;" title="Close">✕</button>`;
        header.querySelector('.git-commit-file-close').onclick = () => { panel.style.display = 'none'; panel.innerHTML = ''; };
        listContainer.appendChild(header);

        if (files.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:10px 12px;font-size:11px;color:var(--text-secondary);';
            empty.textContent = 'No differences.';
            listContainer.appendChild(empty);
        }

        files.forEach(f => {
            const item = document.createElement('div');
            item.className = 'git-commit-file-item';
            item.style.cssText = 'padding:5px 12px 5px 24px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px;border-bottom:1px solid var(--border-color);';
            const statusColor = f.status === 'A' ? '#3fb950' : f.status === 'D' ? '#f85149' : '#d29922';
            item.innerHTML = `<span style="color:${statusColor};font-weight:600;font-size:10px;min-width:12px;">${f.status}</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-family);">${f.path}</span>`;
            item.onmouseenter = () => item.style.background = 'var(--bg-color-hover, rgba(127,127,127,0.1))';
            item.onmouseleave = () => item.style.background = '';
            item.onclick = () => this._showCompareDiff(from, to, f.path);
            listContainer.appendChild(item);
        });

        panel.appendChild(listContainer);
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

        const panel = this.element.querySelector('#git-commit-detail-panel');
        if (!panel) return;

        // Fresh panel for the selected commit (shown below the history graph).
        panel.innerHTML = '';
        panel.style.display = 'block';

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

        detail.querySelector('.git-commit-detail-close').onclick = () => { panel.style.display = 'none'; panel.innerHTML = ''; };

        panel.appendChild(detail);
    }

    /** Show a clickable file list inside the Git panel for multi-file commits. */
    _showCommitFileList(hash, message, files) {
        const panel = this.element.querySelector('#git-commit-detail-panel');
        if (!panel) return;

        // Remove any existing file list (keep the detail info above it).
        const existing = panel.querySelector('.git-commit-file-list-container');
        if (existing) existing.remove();
        panel.style.display = 'block';

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
            alert('Commit message is required');
            return;
        }

        try {
            await invoke('git_commit', { path: State.gitRoot, message: msg });
            input.value = '';
            this.element.querySelector('#git-commit-overlay').style.display = 'none';
            this.refresh();
        } catch (e) {
            alert(`Commit failed: ${e}`);
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
