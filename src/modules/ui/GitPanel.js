import { invoke } from '@tauri-apps/api/core';
import { showAlert, showConfirm, showDialog } from './Dialog.js';
import { createFilterSelect } from './FilterSelect.js';
import { State } from '../core/Store.js';
import { ContextMenu } from './ContextMenu.js';
import AIAgent from '../ai/AIAgent.js';
import { open } from '@tauri-apps/plugin-shell';
import { promptLanguageName, t } from '../utils/I18n.js';
import { icon as svgIcon } from './Icons.js';
import { layoutGraph, graphRowSvg, graphWidth } from '../utils/GitGraph.js';
import { buildFileTree, fileOrder } from '../utils/GitCompare.js';
import { listChangedFiles } from '../utils/GitDiffFiles.js';
import { parseMerged } from '../utils/ConflictRegions.js';
import {
    mergeBranch, rebaseBranch, resetBranch, undoLastCommit, continueOperation,
} from './GitBranchOps.js';

// Moved to utils/GitCompare.js so the comparison tab can share it; still
// exported here for the code (and tests) that know it by this address.
export { buildFileTree };

/** History page size, and how much "Load more" adds each time. */
const HISTORY_PAGE = 100;
/** The history filter's two fixed choices; anything else is a ref name. */
const HISTORY_ALL = '--all';
const HISTORY_CURRENT = '';

/**
 * Strip quoting that leaked out of the shell.
 *
 * Git now runs through `git_exec`, which passes arguments as argv rather than
 * building a command line for `cmd /C`, so the failure this was written for —
 * a branch coming back as `"master"`, quotes included, and `checkout` then
 * looking for a *file* by that name — can no longer happen:
 *
 *     pathspec '"memory-audit-fixes"' did not match any file(s) known to git
 *
 * Kept as a cheap guard on output that is about to be handed back to git. A ref
 * name can never legally contain a quote or a backslash, so anything of the
 * sort is quoting, not part of the name.
 */
/**
 * Escape a value for use inside an attribute selector.
 *
 * File and folder names are user data and can contain quotes or brackets that
 * no attribute selector survives. `CSS.escape` covers this in a browser and is
 * absent in some environments, so fall back to escaping the characters that
 * actually matter here.
 */
function cssEscape(value) {
    const v = String(value == null ? '' : value);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(v);
    return v.replace(/["'\\[\]]/g, (m) => `\\${m}`);
}

/**
 * Text for innerHTML. Commit subjects and author names are whatever someone
 * typed, and `<` in a subject used to become markup in the history list.
 */
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Conflict markers git leaves in a file: a line starting with seven `<`, one
 * of seven `>`, each at the start of a line and followed by a space or the end
 * of the line. A line of `=======` alone is too common (Markdown headings) to
 * count on its own.
 */
/**
 * A git failure for an alert. A refused or cancelled sign-in says so in words
 * before git's own text, which reads like a crash ("could not read Username …
 * terminal prompts disabled").
 */
export function gitErrorText(err, prefix = 'Git Error') {
    const detail = String(err && err.message ? err.message : err).trim();
    const auth = /authentication failed|could not read (username|password)|permission denied \(publickey|terminal prompts disabled|invalid username or password|\b40[13]\b/i;
    if (auth.test(detail)) {
        return `${t('Sign-in to the remote failed or was cancelled. Check the user name and password (or access token) and try again.')}

${detail}`;
    }
    return `${prefix}: ${detail}`;
}

/** Both sides still have the file, so its lines can be merged. */
export function mergeable(code) {
    return code !== 'DD' && code[0] !== 'D' && code[1] !== 'D';
}

export function hasConflictMarkers(text) {
    return /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text);
}

/**
 * What staging `path` ('.' for everything, `dir/` for a folder) would stage,
 * and which conflicted files it would sweep up with it.
 *
 * `git add` on a conflicted file marks it resolved, markers and all, so Stage
 * All and the folder buttons must not reach one. When they would, the other
 * changes under `path` are listed to be staged by name instead.
 */
export function stagePlan(path, status) {
    const prefix = path === '.' ? '' : path.replace(/[/\\]+$/, '') + '/';
    const inside = (p) => prefix === '' || p === prefix.slice(0, -1) || p.startsWith(prefix);
    const blocked = ((status && status.conflicted) || []).map((c) => c.path).filter(inside);
    if (!blocked.length) return { blocked, paths: null };
    const changed = [...(status.modified || []), ...(status.deleted || []), ...(status.untracked || [])];
    return { blocked, paths: changed.filter(inside) };
}

export function cleanRef(name) {
    return String(name).trim().replace(/^["'\\]+|["'\\]+$/g, '').trim();
}

/**
 * The git-diff → commit-message prompt, in the configured UI language.
 * The summary line is conventional-commit (always English-ish); a longer body,
 * if the model writes one, follows the UI language.
 */
export function commitMessagePrompt(diff) {
    const lang = promptLanguageName();
    const body = {
        en: 'Below is a git diff. Generate exactly ONE conventional-commit message for it.\n\nConstraints:\n- First line: summary (within 50 chars, with a prefix).\n- If needed, a longer description after a blank line.\n- Return ONLY the commit message, no commentary or notes.',
        ja: '以下は git diff です。これに対する規約準拠のコミットメッセージを1件だけ生成してください。\n\n制約:\n- 1行目に summary（50文字以内、prefix 付き）。\n- 必要なら空行の後に詳細な説明。\n- 説明や注釈は含めず、コミットメッセージのみを返す。',
        zh: '以下是 git diff。请为它生成恰好一条符合规范的提交信息。\n\n约束:\n- 第一行：summary（不超过 50 字符，带前缀）。\n- 如有必要，在空行后给出更长的描述。\n- 只返回提交信息，不要包含说明或注释。',
        ko: '아래는 git diff입니다. 이에 대한 규칙을 준수하는 커밋 메시지를 정확히 하나만 생성하세요.\n\n제약:\n- 첫 줄: summary(50자 이내, prefix 포함).\n- 필요하면 빈 줄 뒤에 상세 설명.\n- 설명이나 주석 없이 커밋 메시지만 반환하세요.',
    }[lang] || 'Below is a git diff. Generate exactly ONE conventional-commit message for it.\n\nConstraints:\n- First line: summary (within 50 chars, with a prefix).\n- If needed, a longer description after a blank line.\n- Return ONLY the commit message, no commentary or notes.';
    return `${body}\n\n--- git diff ---\n${diff}`;
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
                <span class="git-icon">${svgIcon('folder', { size: 13 })}</span>
                <select id="git-repo-select" class="git-branch-dropdown"></select>
            </div>
            <div class="git-v2-header">
                <div class="git-v2-branch">
                    <span class="git-icon">${svgIcon('branch', { size: 13 })}</span>
                    <div id="git-branch-select" class="git-branch-dropdown-host"></div>
                </div>
                <div class="git-v2-toolbar">
                    <button id="git-compare-btn" title="${t('Compare Branches')}" aria-label="Compare Branches">${svgIcon('compare', { size: 13 })}</button>
                    <button id="git-fetch-btn" title="Fetch All">⟳</button>
                    <button id="git-pull-btn" title="Pull">⤓</button>
                    <button id="git-push-btn" title="Push">⤒</button>
                    <button id="git-pr-btn" title="New Pull Request">PR</button>
                    <button id="git-more-btn" title="${t('More Actions…')}" aria-label="More Actions">⋯</button>
                    <button id="git-refresh-btn" title="${t('Refresh Status')}" aria-label="Refresh Status">${svgIcon('refresh', { size: 13 })}</button>
                </div>
            </div>
            
            <div class="git-v2-content">
                <div class="git-operation-banner" id="git-operation-banner" hidden></div>

                <section class="git-section git-section-conflicts" id="git-section-conflicts" hidden>
                    <div class="git-section-header">
                        <span class="git-section-arrow jh-icon-rotate is-open">${svgIcon('chevron-right', { size: 11 })}</span>
                        <span>MERGE CONFLICTS</span>
                        <span class="git-count" id="git-count-conflicts">0</span>
                    </div>
                    <div class="git-section-list" id="git-list-conflicts"></div>
                </section>

                <section class="git-section" id="git-section-changes">
                    <div class="git-section-header">
                        <span class="git-section-arrow jh-icon-rotate is-open">${svgIcon('chevron-right', { size: 11 })}</span>
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
                        <span class="git-section-arrow jh-icon-rotate is-open">${svgIcon('chevron-right', { size: 11 })}</span>
                        <span>STAGED CHANGES</span>
                        <span class="git-count" id="git-count-staged">0</span>
                        <div class="git-section-actions">
                            <button id="git-unstage-all-btn" title="Unstage All"><svg viewBox="0 0 12 12" width="10" height="10"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="2"/></svg></button>
                            <button id="git-commit-modal-btn" title="${t('Commit')}" aria-label="Commit" class="git-commit-btn-icon">${svgIcon('check', { size: 13 })}</button>
                        </div>
                    </div>
                    <div class="git-section-list" id="git-list-staged"></div>
                </section>

                <section class="git-section" id="git-section-history">
                    <div class="git-section-header">
                        <span class="git-section-arrow jh-icon-rotate is-open">${svgIcon('chevron-right', { size: 11 })}</span>
                        <span>HISTORY</span>
                        <span class="git-compare-hint" id="git-compare-hint" style="margin-left:auto;margin-right:8px;font-size:10px;color:var(--primary-color);display:none;"></span>
                    </div>
                    <div class="git-history-filters">
                        <div id="git-history-ref" class="git-history-ref"></div>
                        <input type="text" id="git-history-search-input" class="git-history-search-input"
                            placeholder="${t('Search commits (message / hash / author)…')}" />
                    </div>
                    <div class="git-section-list" id="git-list-history"></div>
                    <button id="git-history-more" class="git-history-more" style="display:none;">${t('Load more')}</button>
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
                        <button id="git-commit-ai-btn" title="${t('Generate a commit message from the staged diff')}">${svgIcon('sparkles', { size: 12 })}<span>AI</span></button>
                        <button id="git-commit-cancel">Cancel</button>
                        <button id="git-commit-confirm" class="primary-btn">Commit</button>
                    </div>
                </div>
            </div>
        `;

        this.expandedNodes = new Set(); // For tree view
        // Whose history: the checked-out branch, every branch, or one ref.
        this._historyRef = localStorage.getItem('git_history_ref') ?? HISTORY_CURRENT;
        this._historyCount = HISTORY_PAGE;
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
        this.element.querySelector('#git-more-btn').onclick = (e) => ContextMenu.show(e, this._moreMenuItems());
        
        this.element.querySelector('#git-stage-all-btn').onclick = () => this.stageFile('.');
        this.element.querySelector('#git-unstage-all-btn').onclick = () => this.unstageFile('.');

        this.element.querySelector('#git-commit-modal-btn').onclick = () => {
            const op = this._lastStatus && this._lastStatus.operation;
            this.openCommitModal(op && op.kind === 'merge' ? op.message : '');
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
                header.querySelector('.git-section-arrow')
            .classList.toggle('is-open', !section.classList.contains('collapsed'));
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

        this.element.querySelector('#git-history-more').onclick = () => {
            this._historyCount += HISTORY_PAGE;
            this._loadHistory();
        };
    }

    /**
     * Load the history for the chosen ref and draw it. A ref remembered from
     * another repository may not exist in this one: that falls back to the
     * checked-out branch rather than showing an empty, unexplained list.
     */
    async _loadHistory() {
        if (!State.gitRoot) return;
        const rev = this._historyRef;
        let history;
        try {
            history = await invoke('git_log', { path: State.gitRoot, count: this._historyCount, rev });
        } catch (e) {
            if (rev === HISTORY_CURRENT) {
                // A repository with no commit yet has no log at all.
                history = [];
            } else {
                console.warn('git_log failed for', rev, e);
                this._setHistoryRef(HISTORY_CURRENT);
                return;
            }
        }
        this._renderHistory(history);
        const more = this.element.querySelector('#git-history-more');
        if (more) more.style.display = history.length >= this._historyCount ? '' : 'none';
    }

    _setHistoryRef(ref) {
        this._historyRef = ref;
        this._historyCount = HISTORY_PAGE;
        try { localStorage.setItem('git_history_ref', ref); } catch (_) { /* private mode */ }
        if (this._historyPicker) this._historyPicker.setValue(this._historyRefLabel(ref));
        this._loadHistory();
    }

    _historyRefLabel(ref) {
        if (ref === HISTORY_ALL) return t('All branches');
        if (ref === HISTORY_CURRENT) return t('Current branch');
        return ref;
    }

    /** The "whose history" picker: every branch, the current one, or any ref. */
    async _loadHistoryRefs() {
        const host = this.element.querySelector('#git-history-ref');
        if (!host || !State.gitRoot) return;
        const { local, remote, tags } = await this._listRefs();
        const ALL = t('All branches');
        const CURRENT = t('Current branch');
        const groups = [
            { label: '', items: [CURRENT, ALL] },
            { label: t('Local'), items: local },
            { label: t('Remote'), items: remote },
            { label: t('Tags'), items: tags },
        ].filter((g) => g.items.length);
        const toRef = (label) => (label === ALL ? HISTORY_ALL : label === CURRENT ? HISTORY_CURRENT : label);

        if (this._historyPicker && host.contains(this._historyPicker.element)) {
            this._historyPicker.setOptions(groups);
            this._historyPicker.setValue(this._historyRefLabel(this._historyRef));
            return;
        }
        host.innerHTML = '';
        this._historyPicker = createFilterSelect({
            groups,
            value: this._historyRefLabel(this._historyRef),
            placeholder: t('branch…'),
            title: t('Whose history to show (type to filter)'),
            onChange: (label) => {
                const ref = toRef(label);
                if (ref !== this._historyRef) this._setHistoryRef(ref);
            },
        });
        this._historyPicker.element.style.width = '100%';
        host.appendChild(this._historyPicker.element);
    }

    async executeGit(command) {
        if (!State.gitRoot) return;
        try {
            await invoke(command, { path: State.gitRoot });
            this.refresh();
        } catch (e) {
            // A pull that stops on conflicts fails too, but has left the
            // repository mid-merge: the panel has to show that, and the
            // conflicts say more than git's stderr does.
            await this.refresh();
            const count = this._conflicts().length;
            if (count) {
                showAlert(t('Git stopped with {count} conflicted files. Resolve them under MERGE CONFLICTS, then commit the merge.', { count }),
                    { title: 'Git', kind: 'warning' });
            } else {
                showAlert(gitErrorText(e), { title: 'Git', kind: 'error' });
            }
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
            
            await this._loadHistory();
            this._loadHistoryRefs();

            window.dispatchEvent(new CustomEvent('git-status-updated', { detail: status }));
        } catch (e) {
            console.error('Git refresh failed:', e);
        }
    }

    async _checkGitDir(path) {
        if (!path) return false;
        try {
            const result = await invoke('git_exec', { args: ['rev-parse', '--git-dir'], cwd: path });
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
                <div style="opacity:0.4;">${svgIcon('folder', { size: 36 })}</div>
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
        this._lastStatus = status;
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
        this._renderConflicts(this._conflicts());
        this._renderOperationBanner(status.operation || null, this._conflicts().length);
    }

    /** Unmerged paths from the last status: [{ path, code }]. */
    _conflicts() {
        return (this._lastStatus && this._lastStatus.conflicted) || [];
    }

    /**
     * The conflicted files, flat and in path order. A tree would hide them in
     * closed folders, and every one of them needs attention.
     */
    _renderConflicts(conflicts) {
        const section = this.element.querySelector('#git-section-conflicts');
        const list = this.element.querySelector('#git-list-conflicts');
        section.hidden = conflicts.length === 0;
        this.element.querySelector('#git-count-conflicts').textContent = conflicts.length;
        list.innerHTML = '';
        this._bindTreeKeys();

        const sorted = [...conflicts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        for (const c of sorted) {
            const cut = c.path.lastIndexOf('/');
            const name = c.path.slice(cut + 1);
            const dir = cut > 0 ? c.path.slice(0, cut) : '';
            const row = document.createElement('div');
            row.className = 'git-tree-item git-file git-conflict-item';
            row.tabIndex = -1;
            row.dataset.gitPath = c.path;
            row.dataset.gitKind = 'file';
            row.dataset.conflictCode = c.code;
            row.innerHTML = `
                <span class="git-status-badge c" title="${escapeHtml(this._conflictLabel(c.code))}">!</span>
                <span class="git-tree-label" title="${escapeHtml(c.path)}">${escapeHtml(name)}</span>
                <span class="git-conflict-dir">${escapeHtml(dir)}</span>
                <div class="git-file-actions">
                    <button class="git-action-btn git-resolve-btn" title="${escapeHtml(t('Mark as Resolved'))}">${svgIcon('check', { size: 11 })}</button>
                </div>
            `;
            row.onclick = () => this.openConflict(c);
            row.oncontextmenu = (e) => {
                e.preventDefault();
                ContextMenu.show(e, this._conflictMenuItems(c));
            };
            row.querySelector('.git-resolve-btn').onclick = (e) => {
                e.stopPropagation();
                this.markResolved(c);
            };
            list.appendChild(row);
        }
    }

    /** What a two-letter unmerged code means, for the badge's tooltip. */
    _conflictLabel(code) {
        switch (code) {
            case 'UU': return t('Conflict: both modified');
            case 'AA': return t('Conflict: both added');
            case 'DD': return t('Conflict: both deleted');
            case 'AU': return t('Conflict: added by current');
            case 'UA': return t('Conflict: added by incoming');
            case 'DU': return t('Conflict: deleted by current');
            case 'UD': return t('Conflict: deleted by incoming');
            default: return t('Conflict');
        }
    }

    /**
     * "Current" is HEAD and "incoming" what is being brought in — git's ours
     * and theirs. During a rebase HEAD is the branch being rebased onto, so the
     * names are only spelled out for a merge, where they cannot mislead.
     */
    _sideNames() {
        const status = this._lastStatus || {};
        const op = status.operation;
        if (op && op.kind === 'merge') {
            return { current: status.branch || 'HEAD', incoming: op.name || 'MERGE_HEAD' };
        }
        // Rebasing, HEAD is the branch being rebased onto, and the commit
        // being replayed — the incoming side — is the rebased branch's own.
        if (op && op.kind === 'rebase') return { current: '', incoming: op.name || '' };
        return { current: '', incoming: '' };
    }

    _conflictMenuItems(c) {
        const names = this._sideNames();
        const currentGone = c.code[0] === 'D';
        const incomingGone = c.code[1] === 'D';
        const items = [];
        if (c.code !== 'DD') {
            if (mergeable(c.code)) {
                items.push({ label: t('Open in 3-Way Merge'), action: () => this.openConflict(c) });
            }
            items.push({ label: t('Open File as Text'), action: () => this.openConflictAsText(c) });
            items.push({ type: 'separator' });
            items.push({
                label: currentGone ? t('Accept Deletion (current)')
                    : names.current ? t('Keep Current Version ({name})', { name: names.current })
                        : t('Keep Current Version'),
                action: () => this.takeSide(c, 'ours'),
            });
            items.push({
                label: incomingGone ? t('Accept Deletion (incoming)')
                    : names.incoming ? t('Take Incoming Version ({name})', { name: names.incoming })
                        : t('Take Incoming Version'),
                action: () => this.takeSide(c, 'theirs'),
            });
            items.push({ type: 'separator' });
        }
        items.push({ label: t('Mark as Resolved'), action: () => this.markResolved(c) });
        items.push({ type: 'separator' });
        items.push({ label: t('Copy Path'), action: () => this._copyText(c.path) });
        return items;
    }

    /**
     * Open a conflicted file in the three-way merge view. A file with a side
     * that deleted it, or a binary one, has no lines to merge: it opens as
     * text, and the menu's "keep / take" decides it.
     *
     * @param {object} [o.replaces]  the merge tab this one takes the place of
     */
    async openConflict(c, { replaces = null } = {}) {
        if (!mergeable(c.code) || !window.app?.openConflictTab) {
            await this.openConflictAsText(c);
            return;
        }
        let versions;
        try {
            versions = await invoke('git_conflict_versions', { path: State.gitRoot, file: c.path });
        } catch (e) {
            showAlert(`${t('Could not read the conflicting versions')}: ${e}`, { title: 'Git', kind: 'error' });
            return;
        }
        if (versions.binary || versions.ours == null || versions.theirs == null) {
            if (versions.binary && window.showToast) {
                window.showToast(t('A binary file cannot be merged line by line. Keep one version from the menu.'));
            }
            await this.openConflictAsText(c);
            return;
        }
        window.app.openConflictTab({
            repo: State.gitRoot,
            path: c.path,
            versions,
            regions: parseMerged(versions.merged),
            labels: this._sideNames(),
            replaces,
        });
    }

    /**
     * The merge view saved its result and wants the file marked resolved:
     * stage it, then move on to the next conflict in the same tab.
     */
    async resolvedInMergeView(repo, path, tab) {
        if (repo !== State.gitRoot) return;
        try {
            await this._git(['add', '--', path]);
        } catch (e) {
            showAlert(String(e), { title: t('Mark as Resolved'), kind: 'error' });
            return;
        }
        await this.refresh();
        const next = this._conflicts().filter((c) => mergeable(c.code))
            .sort((a, b) => (a.path < b.path ? -1 : 1))[0];
        if (next) {
            const replaces = tab && tab.path ? tab.path.replace(/^diff:\/\//, '') : null;
            await this.openConflict(next, { replaces });
        } else if (window.showToast) {
            window.showToast(this._conflicts().length
                ? t('Marked resolved. The remaining conflicts need a version chosen from the menu.')
                : t('All conflicts are resolved. Commit the merge to finish.'));
        }
    }

    /**
     * Open the conflicted file as it is on disk, markers and all — as text.
     * A rendered view reads the markers as markup: `>>>>>>> feature-x` came
     * out of the Markdown view as seven nested quotes.
     */
    async openConflictAsText(c) {
        if (c.code === 'DD' || !window.app?.openFile) return;
        const fullPath = `${State.gitRoot}/${c.path}`.replace(/\\/g, '/');
        try {
            await window.app.openFile(fullPath, false, null, true);
        } catch (e) {
            showAlert(`${t('Could not open the file')}: ${e}`, { title: 'Git', kind: 'error' });
        }
    }

    /**
     * Resolve by taking one side whole. A side that deleted the file resolves
     * it by deleting; otherwise git writes that side's version and the file is
     * staged as resolved.
     */
    async takeSide(c, side) {
        const gone = side === 'ours' ? c.code[0] === 'D' : c.code[1] === 'D';
        const name = c.path.split('/').pop();
        const ok = await showConfirm(
            gone ? t('Delete "{name}" and mark the conflict resolved?', { name })
                : side === 'ours'
                    ? t('Replace "{name}" with the current version and mark it resolved? Edits made to it so far are lost.', { name })
                    : t('Replace "{name}" with the incoming version and mark it resolved? Edits made to it so far are lost.', { name }),
            { title: t('Resolve Conflict'), kind: 'warning', okLabel: t('Resolve') },
        );
        if (!ok) return;
        try {
            if (gone) {
                await this._git(['rm', '--quiet', '--', c.path]);
            } else {
                await this._git(['checkout', `--${side}`, '--', c.path]);
                await this._git(['add', '--', c.path]);
            }
        } catch (e) {
            showAlert(String(e), { title: t('Resolve Conflict'), kind: 'error' });
        }
        this.refresh();
    }

    /**
     * Stage the file as it stands. Git takes conflict markers left in it
     * without complaint, so look for them first.
     */
    async markResolved(c) {
        const fullPath = `${State.gitRoot}/${c.path}`.replace(/\\/g, '/');
        let text = null;
        if (c.code !== 'DD') {
            try {
                const data = await invoke('read_file_auto_detect', { path: fullPath });
                text = data ? data.content : null;
            } catch (e) { /* not on disk: resolved by deleting it */ }
        }
        if (text !== null && hasConflictMarkers(text)) {
            const ok = await showConfirm(
                t('"{name}" still contains conflict markers (<<<<<<< / >>>>>>>). Mark it resolved anyway?', { name: c.path.split('/').pop() }),
                { title: t('Mark as Resolved'), kind: 'warning', okLabel: t('Mark as Resolved') },
            );
            if (!ok) return;
        }
        try {
            await this._git(text === null ? ['rm', '--quiet', '--', c.path] : ['add', '--', c.path]);
        } catch (e) {
            showAlert(String(e), { title: t('Mark as Resolved'), kind: 'error' });
        }
        this.refresh();
    }

    _git(args) {
        return invoke('git_exec', { args, cwd: State.gitRoot });
    }

    /**
     * What git is in the middle of, with the way out of it. Shown while there
     * is an operation to finish or abort, or conflicts with no operation (a
     * stash pop leaves those).
     */
    _renderOperationBanner(op, conflictCount) {
        const banner = this.element.querySelector('#git-operation-banner');
        if (!op && !conflictCount) {
            banner.hidden = true;
            banner.innerHTML = '';
            return;
        }
        banner.hidden = false;
        const name = op ? op.name : '';
        const title = !op ? t('Unresolved conflicts')
            : op.kind === 'merge' ? t('Merging {name}', { name })
                : op.kind === 'rebase' ? t('Rebasing {name}', { name })
                    : op.kind === 'cherry-pick' ? t('Cherry-picking {name}', { name })
                        : t('Reverting {name}', { name });
        const detail = conflictCount
            ? t('{count} conflicted files', { count: conflictCount })
            : t('All conflicts resolved');
        banner.classList.toggle('has-conflicts', conflictCount > 0);
        banner.innerHTML = `
            <div class="git-operation-text">
                <span class="git-operation-title">${escapeHtml(title)}</span>
                <span class="git-operation-detail">${escapeHtml(detail)}</span>
            </div>
            <div class="git-operation-actions"></div>
        `;
        const actions = banner.querySelector('.git-operation-actions');
        if (op) {
            const abort = document.createElement('button');
            abort.className = 'git-operation-abort';
            abort.textContent = t('Abort');
            abort.onclick = () => this.abortOperation(op);
            actions.appendChild(abort);
        }
        if (op && op.kind !== 'merge') {
            if (op.kind !== 'revert') {
                const skip = document.createElement('button');
                skip.className = 'git-operation-skip';
                skip.textContent = t('Skip');
                skip.title = t('Leave out the commit that stopped and go on with the rest');
                skip.onclick = () => continueOperation(this, op.kind, 'skip');
                actions.appendChild(skip);
            }
            const cont = document.createElement('button');
            cont.className = 'git-operation-continue primary-btn';
            cont.textContent = t('Continue');
            cont.disabled = conflictCount > 0;
            cont.title = conflictCount > 0 ? t('Resolve every conflict first') : '';
            cont.onclick = () => continueOperation(this, op.kind, 'continue');
            actions.appendChild(cont);
        }
        if (op && op.kind === 'merge') {
            const commit = document.createElement('button');
            commit.className = 'git-operation-commit primary-btn';
            commit.textContent = t('Commit Merge');
            commit.disabled = conflictCount > 0;
            commit.title = conflictCount > 0 ? t('Resolve every conflict first') : '';
            commit.onclick = () => this.openCommitModal(op.message);
            actions.appendChild(commit);
        }
    }

    /** The toolbar's "⋯": branch operations, as in VS Code's Source Control menu. */
    _moreMenuItems() {
        const branch = this._activeBranch || 'HEAD';
        const op = this._lastStatus && this._lastStatus.operation;
        const items = [
            { label: t('Merge Branch into {branch}…', { branch }), action: () => mergeBranch(this) },
            { label: t('Rebase {branch}…', { branch }), action: () => rebaseBranch(this) },
            { type: 'separator' },
            { label: t('Reset {branch}…', { branch }), action: () => resetBranch(this) },
            { label: t('Undo Last Commit'), action: () => undoLastCommit(this) },
        ];
        if (op) {
            items.push({ type: 'separator' });
            items.push({ label: t('Abort'), action: () => this.abortOperation(op) });
        }
        return items;
    }

    /** Open the first conflict that can be merged line by line (after an operation stops). */
    openFirstConflict() {
        const next = this._conflicts().filter((c) => mergeable(c.code))
            .sort((a, b) => (a.path < b.path ? -1 : 1))[0];
        if (next) this.openConflict(next);
    }

    /** Open the commit dialog, filling in `message` when nothing is typed yet. */
    openCommitModal(message = '') {
        const overlay = this.element.querySelector('#git-commit-overlay');
        const input = this.element.querySelector('#git-commit-input');
        if (message && !input.value.trim()) input.value = message;
        overlay.style.display = 'flex';
        input.focus();
    }

    async abortOperation(op) {
        const ok = await showConfirm(
            t('Abort and go back to where things stood before it started? Conflict resolutions and other changes made since are discarded.'),
            { title: t('Abort'), kind: 'warning', okLabel: t('Abort') },
        );
        if (!ok) return;
        try {
            await this._git([op.kind, '--abort']);
        } catch (e) {
            showAlert(String(e), { title: t('Abort'), kind: 'error' });
        }
        this.refresh();
    }

    async _loadBranches(activeBranch) {
        if (!State.gitRoot) return;
        // The picker replaced a <select>, so `#git-branch-select.value` no
        // longer answers "which branch am I on".
        this._activeBranch = activeBranch || '';
        try {
            const output = await invoke('git_exec', {
                args: ['branch', '--format=%(refname:short)'],
                cwd: State.gitRoot,
            });
            const branches = output.split('\n').map(cleanRef).filter(b => b.length > 0);
            
            // A repo with dozens of branches makes a native dropdown a scroll
            // hunt, so the switcher is a type-to-filter picker.
            const host = this.element.querySelector('#git-branch-select');
            if (host) {
                const checkout = async (newBranch) => {
                    if (!newBranch || newBranch === activeBranch) return;
                    try {
                        await invoke('git_exec', {
                            args: ['checkout', newBranch],
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

    /**
     * Refresh the panel and put the keyboard back where it was.
     *
     * By PATH, not by element: refresh() rebuilds every row, so the node that
     * was focused no longer exists. A folder that collapsed away takes its
     * children with it, so a child falls back to the nearest ancestor still on
     * screen rather than dumping the keyboard at the top of the panel.
     */
    _refreshKeepingFocus(path) {
        this.refresh();
        const settle = () => {
            let target = path;
            while (target) {
                const row = this.element.querySelector(
                    `.git-tree-item[data-git-path="${cssEscape(target)}"]`,
                );
                if (row) {
                    row.focus({ preventScroll: true });
                    if (typeof row.scrollIntoView === 'function') {
                        row.scrollIntoView({ block: 'nearest' });
                    }
                    return;
                }
                const cut = target.lastIndexOf('/');
                target = cut > 0 ? target.slice(0, cut) : '';
            }
        };
        // refresh() is async; give it the frame it needs to rebuild.
        setTimeout(settle, 0);
        setTimeout(settle, 120);
    }

    /**
     * Arrow keys over the change/staged trees.
     *
     * There was no keyboard handling here at all — no focusable rows, no
     * keydown, no scope — so Up and Down did what they do on any scrollable
     * div: scrolled it, while the folders sat there un-openable.
     *
     * Bound once, on the panel, and delegated: every expand or collapse calls
     * refresh(), which rebuilds every row, so a listener attached to a row
     * would not survive its own keystroke.
     */
    _bindTreeKeys() {
        if (this._treeKeysBound) return;
        this._treeKeysBound = true;

        const rows = () => [...this.element.querySelectorAll('.git-tree-item')];

        const focusRow = (row) => {
            if (!row) return;
            row.focus({ preventScroll: true });
            if (typeof row.scrollIntoView === 'function') {
                row.scrollIntoView({ block: 'nearest' });
            }
        };

        const step = (from, delta) => {
            const all = rows();
            if (!all.length) return;
            const i = all.indexOf(from);
            const next = i === -1
                ? (delta > 0 ? 0 : all.length - 1)
                : Math.min(all.length - 1, Math.max(0, i + delta));
            focusRow(all[next]);
        };

        const refreshKeepingFocus = (path) => this._refreshKeepingFocus(path);

        this.element.addEventListener('keydown', (e) => {
            const row = e.target.closest && e.target.closest('.git-tree-item');
            if (!row) return;
            const path = row.dataset.gitPath || '';
            const isFolder = row.dataset.gitKind === 'folder';
            const isOpen = row.dataset.gitOpen === 'true';

            // Ctrl+Up / Ctrl+Down: the previous / next changed file's diff,
            // as inside the diff itself — folders left closed included.
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
                && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                e.stopPropagation();
                // A conflicted file has no diff to step to.
                if (row.closest('#git-list-conflicts')) return;
                const isStaged = !!row.closest('#git-list-staged');
                const list = this._getDiffFileList(isStaged);
                const at = list.findIndex((f) => f.path === path || f.path.startsWith(`${path}/`));
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                const next = isFolder && at !== -1 ? list[delta > 0 ? at : at - 1]
                    : list[at === -1 ? 0 : at + delta];
                if (next) {
                    const replaces = isFolder ? null : `git:${isStaged ? 'index' : 'worktree'}:${path}`;
                    this.showDiff(next.path, isStaged, { replaces });
                    this._revealInTree(next.path, isStaged);
                }
                return;
            }

            switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                step(row, 1);
                return;
            case 'ArrowUp':
                e.preventDefault();
                step(row, -1);
                return;
            case 'Home':
                e.preventDefault();
                focusRow(rows()[0]);
                return;
            case 'End':
                e.preventDefault();
                focusRow(rows().pop());
                return;
            case 'ArrowRight':
                e.preventDefault();
                // Open a closed folder; step into one that is already open.
                if (isFolder && !isOpen && row.dataset.gitLeaf !== 'true') {
                    this.expandedNodes.add(path);
                    refreshKeepingFocus(path);
                } else {
                    step(row, 1);
                }
                return;
            case 'ArrowLeft': {
                e.preventDefault();
                if (isFolder && isOpen) {
                    this.expandedNodes.delete(path);
                    refreshKeepingFocus(path);
                    return;
                }
                // From a file, or a closed folder, go up to the parent folder.
                const cut = path.lastIndexOf('/');
                const parent = cut > 0 ? path.slice(0, cut) : '';
                const parentRow = parent && this.element.querySelector(
                    `.git-tree-item.git-folder[data-git-path="${cssEscape(parent)}"]`,
                );
                if (parentRow) focusRow(parentRow);
                else step(row, -1);
                return;
            }
            case 'Enter':
            case ' ':
                // Whatever a click does: toggle the folder, or open the diff.
                e.preventDefault();
                row.click();
                if (isFolder) refreshKeepingFocus(path);
                return;
            default:
            }
        });
    }

    /** Open the folders above a changed file and put the keyboard on its row. */
    _revealInTree(path, isStaged) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) this.expandedNodes.add(parts.slice(0, i).join('/'));
        this._renderStatus(this._lastStatus);
        const list = this.element.querySelector(isStaged ? '#git-list-staged' : '#git-list-changes');
        const row = list && list.querySelector(`.git-tree-item[data-git-path="${cssEscape(path)}"]`);
        if (row) {
            row.focus({ preventScroll: true });
            if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
        }
    }

    _renderFileList(container, files, actionType) {
        container.innerHTML = '';
        this._bindTreeKeys();
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
                // Focusable and identifiable, so the arrow keys have something
                // to move between and something to restore focus to after the
                // refresh that every expand/collapse triggers.
                div.tabIndex = -1;
                div.dataset.gitPath = fullPath;
                div.dataset.gitKind = 'folder';
                div.dataset.gitOpen = String(isExpanded && !hasNoChildren);
                div.dataset.gitLeaf = String(hasNoChildren);

                // Folder-level stage/unstage button
                let folderActionHtml = '';
                if (actionType === 'stage') {
                    folderActionHtml = `<button class="git-action-btn git-stage-btn git-folder-action" data-folder-path="${escapeHtml(fullPath)}" title="Stage All in Folder"><svg viewBox="0 0 12 12"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg></button>`;
                } else if (actionType === 'unstage') {
                    folderActionHtml = `<button class="git-action-btn git-unstage-btn git-folder-action" data-folder-path="${escapeHtml(fullPath)}" title="Unstage All in Folder"><svg viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6"/></svg></button>`;
                }

                div.innerHTML = `
                    <span class="git-tree-arrow" style="display: inline-block; width: 12px; text-align: center; margin-right: 6px; font-size: 10px; opacity: ${hasNoChildren ? '0.3' : '0.7'};">${isExpanded && !hasNoChildren ? '▼' : '▶'}</span>
                    <span class="git-tree-icon" style="margin-right: 6px;">${svgIcon(hasNoChildren ? 'folder-open' : 'folder', { size: 13 })}</span>
                    <span class="git-tree-label" style="font-weight: 500;">${escapeHtml(node.name)}</span>
                    <div class="git-file-actions" style="margin-left: auto;">
                        ${folderActionHtml}
                    </div>
                `;
                div.onclick = (e) => {
                    if (e.target.closest('.git-folder-action')) return;
                    if (this.expandedNodes.has(fullPath)) this.expandedNodes.delete(fullPath);
                    else this.expandedNodes.add(fullPath);
                    // Keeps the keyboard on the folder just clicked, so mouse
                    // and arrows can be mixed without the focus resetting.
                    this._refreshKeepingFocus(fullPath);
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
                    div.tabIndex = -1;
                    div.dataset.gitPath = file.path;
                    div.dataset.gitKind = 'file';
                    const filename = file.path.split(/[/\\]/).pop() || file.path;
                    
                    let actionHtml = '';
                    if (actionType === 'stage') {
                        const isUntracked = file.status === 'U';
                        const isDeleted = file.status === 'D';
                        actionHtml = `
                            <button class="git-action-btn git-discard-btn" data-path="${escapeHtml(file.path)}" title="${isDeleted ? 'Restore File' : 'Discard Changes'}"><svg viewBox="0 0 12 12"><path d="M3 6a3 3 0 1 1 5.1 2.1L7 9"/></svg></button>
                            ${isUntracked ? `<button class="git-action-btn git-ignore-btn" data-path="${escapeHtml(file.path)}" title="Ignore File"><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4"/><line x1="3" y1="6" x2="9" y2="6"/></svg></button>` : ''}
                            ${!isDeleted ? `<button class="git-action-btn git-stage-btn" data-path="${escapeHtml(file.path)}" title="Stage Change"><svg viewBox="0 0 12 12"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg></button>` : ''}
                        `;
                    } else {
                        actionHtml = `
                            <button class="git-action-btn git-unstage-btn" data-path="${escapeHtml(file.path)}" title="Unstage Change"><svg viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6"/></svg></button>
                        `;
                    }

                    div.innerHTML = `
                        <span class="git-status-badge ${file.status.toLowerCase()}" title="${this._statusLabel(file.status)}" style="margin-right: 6px; display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; font-size: 8px; font-weight: bold; border-radius: 2px;">${file.status}</span>
                        <span class="git-tree-label" title="${escapeHtml(file.path)}">${escapeHtml(filename)}</span>
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
                (e.author_email || '').toLowerCase().includes(q) ||
                (e.refs || '').toLowerCase().includes(q))
            : source;

        this._lastHistory = filtered;
        const container = this.element.querySelector('#git-list-history');
        container.innerHTML = '';

        if (filtered.length === 0) {
            container.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--text-secondary);text-align:center;">${escapeHtml(q ? t('No commits match the search.') : t('No history.'))}</div>`;
            return;
        }

        // When filtering, the parent-based graph is meaningless (the commits
        // shown are not contiguous), so the column is left out entirely.
        const showGraph = !q;
        const graph = showGraph ? layoutGraph(filtered) : null;
        const width = graph ? graphWidth(graph.width) : 0;
        const selected = new Set((this._selectedCommits || []).map((c) => c.hash));

        const frag = document.createDocumentFragment();
        filtered.forEach((entry, idx) => {
            const item = document.createElement('div');
            item.className = 'git-history-item-compact-v4';
            item.dataset.hash = entry.hash;
            const isHead = /(^|, )HEAD( ->|$|,)/.test(entry.refs || '');
            if (isHead) item.classList.add('is-head');

            const graphHtml = graph
                ? `<div class="git-hist-graph-part" style="width:${width}px">${graphRowSvg(graph.rows[idx], width, { head: isHead })}</div>`
                : '';
            const tip = [entry.message, `${entry.author} <${entry.author_email || ''}>`, entry.iso_date || entry.date]
                .filter(Boolean).join('\n');

            // [graph] [hash] [author] [date] [message] [refs]
            item.innerHTML = `
                ${graphHtml}
                <div class="git-hist-content-v4" title="${escapeHtml(tip)}">
                    <span class="git-hist-hash-v4">${escapeHtml(entry.short_hash)}</span>
                    <span class="git-hist-author-v4">${escapeHtml(this._truncate(entry.author, 10))}</span>
                    <span class="git-hist-date-v4">${escapeHtml(entry.date)}</span>
                    <span class="git-hist-msg-v4">${escapeHtml(entry.message)}</span>
                    ${this._formatRefs(entry.refs, graph ? graph.rows[idx].color : null)}
                </div>
            `;
            frag.appendChild(item);

            // The commits picked for a comparison stay marked.
            if (selected.has(entry.hash)) item.classList.add('git-compare-base');

            item.onclick = (e) => {
                // Ctrl+click picks commits for a comparison: the second one
                // compares the two.
                if (e.ctrlKey || e.metaKey) {
                    this._toggleCompareSelection(entry);
                    return;
                }
                // Shift+click compares against the commit picked first.
                const base = (this._selectedCommits || [])[0];
                if (e.shiftKey && base && base.hash !== entry.hash) {
                    this._compareCommits(base, entry);
                    return;
                }
                this._markHistoryActive(entry.hash);
                this.showCommitDiff(entry.hash, entry.message);
            };

            item.oncontextmenu = (e) => {
                const badge = e.target.closest && e.target.closest('[data-ref]');
                if (badge) this._showRefContextMenu(e, badge.dataset.ref, entry);
                else this._showHistoryContextMenu(e, entry);
            };
        });
        container.appendChild(frag);
        if (this._activeCommit) this._markHistoryActive(this._activeCommit);
    }

    /** The commit whose details are showing, marked in the list. */
    _markHistoryActive(hash) {
        this._activeCommit = hash;
        for (const row of this.element.querySelectorAll('#git-list-history .git-history-item-compact-v4')) {
            row.classList.toggle('is-active', row.dataset.hash === hash);
        }
    }

    // ── History compare ──────────────────────────────────────────────────────

    /**
     * Pick (or un-pick) a commit for comparison. Picking a second one compares
     * the two, older on the left.
     */
    _toggleCompareSelection(entry) {
        const picked = (this._selectedCommits || []).filter((c) => c.hash !== entry.hash);
        if (picked.length === (this._selectedCommits || []).length) picked.push(entry);
        if (picked.length >= 2) {
            const [a, b] = this._olderFirst(picked[0], picked[1]);
            this._clearCompareBase();
            this._compareCommits(a, b);
            return;
        }
        this._selectedCommits = picked;
        this._updateCompareHint();
        this._renderHistory();
    }

    /** Order two history entries oldest first, by where they sit in the log. */
    _olderFirst(a, b) {
        const list = this._fullHistory || [];
        const ia = list.findIndex((e) => e.hash === a.hash);
        const ib = list.findIndex((e) => e.hash === b.hash);
        // Further down the log is older.
        return ia > ib ? [a, b] : [b, a];
    }

    _updateCompareHint() {
        const hint = this.element.querySelector('#git-compare-hint');
        if (!hint) return;
        const base = (this._selectedCommits || [])[0];
        if (base) {
            hint.style.display = 'inline';
            hint.textContent = t('Base: {hash} — Ctrl+click another', { hash: base.short_hash });
            hint.title = base.message || '';
        } else {
            hint.style.display = 'none';
            hint.textContent = '';
        }
    }

    _setCompareBase(entry) {
        this._selectedCommits = [entry];
        this._updateCompareHint();
        this._renderHistory(); // re-render to show the base highlight
    }

    _clearCompareBase() {
        this._selectedCommits = [];
        this._updateCompareHint();
        this._renderHistory();
    }

    /** Branch names in a log entry's decoration (`HEAD -> main, origin/main, tag: v1`). */
    _branchesOf(entry) {
        return String(entry.refs || '').split(',').map((r) => r.trim()).filter(Boolean)
            .map((r) => r.replace(/^HEAD -> /, ''))
            .filter((r) => r !== 'HEAD' && !r.startsWith('tag:') && !r.endsWith('/HEAD'));
    }

    _showHistoryContextMenu(e, entry) {
        const current = this._activeBranch;
        const base = (this._selectedCommits || [])[0];
        const short = entry.short_hash;
        const items = [
            { label: t('Open Changes in Editor'), action: () => this._openCommitCompare(entry) },
            { type: 'separator' },
            { label: t('Compare with Working Tree'), action: () => this._compareWithWorkingTree(entry) },
        ];
        // Not on the current branch's own tip: that would compare it with itself.
        if (current && !this._branchesOf(entry).includes(current)) {
            items.push({
                label: t('Compare with Current Branch ({branch})', { branch: current }),
                action: () => this._compareRefs(entry.hash, current, { baseLabel: short, useMergeBase: false }),
            });
        }
        items.push({ label: t('Compare with Branch…'), action: () => this._compareWithPickedRef(entry) });
        items.push({ type: 'separator' });
        if (base && base.hash !== entry.hash) {
            items.push({
                label: t('Compare with Selected ({hash})', { hash: base.short_hash }),
                action: () => {
                    const [a, b] = this._olderFirst(base, entry);
                    this._clearCompareBase();
                    this._compareCommits(a, b);
                },
            });
        }
        items.push({ label: t('Select for Compare'), action: () => this._setCompareBase(entry) });
        if (base) items.push({ label: t('Clear Base'), action: () => this._clearCompareBase() });

        // The branches pointing at this commit, each with its own actions.
        const branches = this._branchesOf(entry);
        if (branches.length) {
            items.push({ type: 'separator' });
            for (const ref of branches) {
                items.push({ label: t('Branch {name}', { name: ref }), submenu: this._refMenuItems(ref, entry) });
            }
        }
        items.push({ type: 'separator' });
        const branch = this._activeBranch || 'HEAD';
        items.push({
            label: t('Reset {branch} to Here…', { branch }),
            action: () => resetBranch(this, entry.hash, `${short}  ${entry.message || ''}`.trim()),
        });
        if (/(^|, )HEAD( ->|$|,)/.test(entry.refs || '') && (entry.parents || []).length) {
            items.push({ label: t('Undo Last Commit'), action: () => undoLastCommit(this) });
        }
        items.push({ type: 'separator' });
        items.push({ label: t('Copy Commit Hash'), action: () => this._copyText(entry.hash) });
        ContextMenu.show(e, items);
    }

    /** Right-click on a branch badge: that branch's actions. */
    _showRefContextMenu(e, ref, entry) {
        ContextMenu.show(e, this._refMenuItems(ref, entry));
    }

    /** What can be done with a branch (or tag) from the history. */
    _refMenuItems(ref, entry) {
        const name = ref.replace(/^tag:\s*/, '');
        const current = this._activeBranch;
        const items = [];
        if (current && name !== current) {
            items.push({
                label: t('Compare with Current Branch ({branch})', { branch: current }),
                // What this branch adds on top of the current one.
                action: () => this._compareRefs(current, name, { useMergeBase: true }),
            });
        }
        items.push({
            label: t('Compare with Working Tree'),
            action: () => this._compareRefs(name, '', {}),
        });
        items.push({ label: t('Compare with Branch…'), action: () => this._compareWithPickedRef({ ...entry, hash: name, short_hash: name }) });
        items.push({ type: 'separator' });
        if (current && name !== current) {
            items.push({ label: t('Merge into {branch}…', { branch: current }), action: () => mergeBranch(this, name) });
            items.push({ label: t('Rebase {branch} onto {name}…', { branch: current, name }), action: () => rebaseBranch(this, name) });
        }
        items.push({ label: t('Reset {branch} to Here…', { branch: current || 'HEAD' }), action: () => resetBranch(this, name, name) });
        items.push({ type: 'separator' });
        items.push({ label: t('Show Only This Branch'), action: () => this._setHistoryRef(name) });
        items.push({ label: t('Copy Name'), action: () => this._copyText(name) });
        return items;
    }

    async _copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            if (window.showToast) window.showToast(t('Copied'));
        } catch (err) {
            console.warn('copy failed', err);
        }
    }

    /** Ask which ref to compare `entry` (a commit, or a branch) against. */
    async _compareWithPickedRef(entry) {
        const { local, remote, tags } = await this._listRefs();
        const WORKING_TREE = t('Working Tree');
        const picker = createFilterSelect({
            groups: [
                { label: '', items: [WORKING_TREE] },
                { label: t('Local'), items: local },
                { label: t('Remote'), items: remote },
                { label: t('Tags'), items: tags },
            ].filter((g) => g.items.length),
            value: this._activeBranch || local[0] || WORKING_TREE,
            placeholder: t('branch…'),
        });
        picker.element.style.width = '100%';
        const go = await showDialog({
            title: t('Compare with Branch'),
            message: t('Compare {name} with:', { name: entry.short_hash }),
            kind: 'info',
            width: 'min(520px, 92vw)',
            content: picker.element,
            buttons: [
                { label: t('Cancel'), value: false, cancel: true },
                { label: t('Compare'), value: true, primary: true },
            ],
        });
        if (!go) return;
        const other = picker.getValue();
        if (!other) return;
        const right = other === WORKING_TREE ? '' : other;
        this._compareRefs(entry.hash, right, { baseLabel: entry.short_hash, useMergeBase: false });
    }

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
            showAlert(gitErrorText(e, 'Push failed'), { title: 'Git', kind: 'error' });
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
                showAlert(gitErrorText(e, 'Push failed'), { title: 'Git', kind: 'error' });
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
        titleEl.placeholder = t('Pull request title');
        titleEl.style.cssText = INPUT_CSS;

        const bodyEl = document.createElement('textarea');
        bodyEl.rows = 6;
        bodyEl.placeholder = t('Description (optional)');
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
                { label: t('Cancel'), value: false, cancel: true },
                { label: t('Create'), value: true, primary: true },
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
                        { label: t('Close'), value: false, cancel: true },
                        { label: t('Open in Browser'), value: true, primary: true },
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
        const run = async (args) => {
            try {
                const out = await invoke('git_exec', { args, cwd: State.gitRoot });
                return String(out || '').split('\n').map(cleanRef).filter(Boolean);
            } catch (e) {
                return [];
            }
        };
        const local = await run(['branch', '--format=%(refname:short)']);
        const remote = (await run(['branch', '-r', '--format=%(refname:short)']))
            // origin/HEAD is a symbolic pointer, not something to diff against.
            .filter((r) => !r.endsWith('/HEAD'));
        const tags = await run(['tag', '--sort=-creatordate']);
        return { local, remote, tags };
    }

    /** The commit a ref points at. `^{commit}` peels annotated tags. */
    async _revCommit(ref) {
        try {
            const out = await invoke('git_exec', {
                args: ['rev-parse', `${ref}^{commit}`], cwd: State.gitRoot,
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
            await showAlert(t('No Git repository is open.'), { title: t('Compare'), kind: 'info' });
            return;
        }

        const { local, remote, tags } = await this._listRefs();
        if (local.length + remote.length === 0) {
            await showAlert(t('No branches to compare.'), { title: t('Compare'), kind: 'info' });
            return;
        }

        const current = this._activeBranch || local[0];
        const form = document.createElement('div');
        form.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:8px 10px;align-items:center;margin-top:4px;';

        const groupsFor = (extra) => [
            ...(extra ? [{ label: '', items: extra }] : []),
            { label: t('Local'), items: local },
            { label: t('Remote'), items: remote },
            { label: t('Tags'), items: tags },
        ].filter((g) => g.items.length);

        const label = (text) => {
            const el = document.createElement('label');
            el.textContent = text;
            el.style.cssText = 'font-size:12px;color:var(--text-secondary);white-space:nowrap;';
            return el;
        };

        // The working tree is only meaningful as the RIGHT side of a comparison.
        const WORKING_TREE = t('Working Tree');
        const baseSel = createFilterSelect({
            groups: groupsFor(null), value: current, placeholder: t('base ref…'),
        });
        const headSel = createFilterSelect({
            groups: groupsFor([WORKING_TREE]),
            value: remote.find((r) => r.endsWith('/' + current))
                || local.find((b) => b !== current)
                || WORKING_TREE,
            placeholder: t('compare ref…'),
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
                { textContent: t('Compare from the common ancestor (base...compare)') }));

        form.append(label(t('Base')), baseSel.element, label(t('Compare')), headSel.element, mergeBaseRow);

        const go = await showDialog({
            title: t('Compare Branches'),
            message: t('Pick the two refs to diff.'),
            kind: 'info',
            // Ref names are long (`origin/feature/something-descriptive`) and
            // there are two of them plus a label column.
            width: 'min(620px, 92vw)',
            content: form,
            buttons: [
                { label: t('Cancel'), value: false, cancel: true },
                { label: t('Compare'), value: true, primary: true },
            ],
        });
        if (!go) return;

        const base = baseSel.getValue();
        // '' is what git_diff_files reads as "the working tree".
        const head = headSel.getValue() === WORKING_TREE ? '' : headSel.getValue();
        if (base === head) {
            await showAlert(t('Pick two different refs.'), { title: t('Compare'), kind: 'warning' });
            return;
        }

        // The merge base only matters against a committed right-hand side.
        await this._compareRefs(base, head, { useMergeBase: mergeBaseCb.checked && head !== '' });
    }

    /**
     * Compare two revisions and open the result as a tab: the changed files
     * beside the selected one's diff. `head` '' is the working tree, whose
     * side of every file can be edited and saved.
     *
     * @param {string} base   left revision (ref name or hash)
     * @param {string} head   right revision; '' = working tree
     * @param {object} [o]
     * @param {boolean} [o.useMergeBase]  start from the common ancestor (base...head)
     * @param {string} [o.baseLabel]      what to call `base` (a short hash, say)
     * @param {string} [o.headLabel]
     * @param {string} [o.select]         file to show first
     */
    async _compareRefs(base, head, { useMergeBase = false, baseLabel = '', headLabel = '', select = '' } = {}) {
        const root = State.gitRoot;
        if (!root || !window.app?.openGitCompareTab) return;

        let mergeBase = '';
        let headCommit = '';
        if (useMergeBase && head !== '') {
            try {
                const mb = await invoke('git_exec', {
                    args: ['merge-base', base, head], cwd: root,
                });
                mergeBase = String(mb || '').trim().split('\n')[0];
                headCommit = await this._revCommit(head);
            } catch (e) {
                // Unrelated histories, or a ref git can't resolve.
                console.warn('merge-base failed, using a direct diff:', e);
            }
        }
        const resolved = resolveCompareBase({
            base, head, useMergeBase: useMergeBase && head !== '', mergeBase, headCommit,
        });
        const left = baseLabel || base;
        const fromLabel = baseLabel ? resolved.fromLabel.replace(base, baseLabel) : resolved.fromLabel;
        const right = head === '' ? t('Working Tree') : (headLabel || head);

        let files;
        try {
            files = await listChangedFiles(root, resolved.fromRev, head);
        } catch (err) {
            console.error('git_diff_files failed:', err);
            await showAlert(t('Comparison failed: {error}', { error: (err && err.message) || err }),
                { title: t('Compare'), kind: 'error' });
            return;
        }

        let note = resolved.note;
        if (note && /already part of/.test(note)) note = t('{head} is already part of {base}; showing the direct comparison.', { head: right, base: left });
        else if (note) note = t('No common ancestor; showing the direct comparison.');

        window.app.openGitCompareTab({
            id: `${root}|${resolved.fromRev}..${head || ':worktree'}`,
            title: `${left} ↔ ${right}`,
            select,
            compare: {
                root,
                from: { rev: resolved.fromRev, label: fromLabel },
                to: { rev: head, label: right },
                files,
                note,
                reload: { fromRev: resolved.fromRev, toRev: head },
            },
        });
    }

    async _compareCommits(fromEntry, toEntry) {
        await this._compareRefs(fromEntry.hash, toEntry.hash, {
            baseLabel: fromEntry.short_hash, headLabel: toEntry.short_hash,
        });
    }

    /** Compare a commit against the current working tree. */
    async _compareWithWorkingTree(entry) {
        await this._compareRefs(entry.hash, '', { baseLabel: entry.short_hash });
    }

    /**
     * What one commit changed, as a comparison tab: its first parent on the
     * left, the commit on the right. A merge lists what it brought in over
     * its first parent (diff-tree alone prints nothing for a merge).
     */
    async _openCommitCompare(entryOrHash, select = '') {
        const root = State.gitRoot;
        if (!root || !window.app?.openGitCompareTab) return;
        const entry = typeof entryOrHash === 'string'
            ? ((this._fullHistory || []).find((e) => e.hash === entryOrHash) || { hash: entryOrHash })
            : entryOrHash;
        const hash = entry.hash;
        const short = entry.short_hash || hash.slice(0, 7);
        const isMerge = (entry.parents || []).length > 1;
        let files;
        try {
            files = isMerge
                ? await invoke('git_diff_files', { path: root, fromRev: `${hash}^1`, toRev: hash })
                : await invoke('git_commit_files', { path: root, hash });
        } catch (err) {
            console.error('Failed to list the commit\'s files:', err);
            showAlert(t('Comparison failed: {error}', { error: (err && err.message) || err }),
                { title: t('Compare'), kind: 'error' });
            return;
        }
        const message = String(entry.message || '');
        window.app.openGitCompareTab({
            id: `${root}|commit:${hash}`,
            title: `${short} ${this._truncate(message, 24)}`.trim(),
            select,
            compare: {
                root,
                from: { rev: `${hash}^`, label: `${short}^` },
                to: { rev: hash, label: short },
                files,
                note: message,
            },
        });
    }


    async showCommitDiff(hash, message) {
        try {
            // Show commit detail info header first
            this._showCommitDetail(hash);

            const entry = (this._fullHistory || []).find((e) => e.hash === hash);
            // diff-tree prints nothing for a merge; list what it brought in
            // over its first parent instead.
            const files = entry && (entry.parents || []).length > 1
                ? await invoke('git_diff_files', { path: State.gitRoot, fromRev: `${hash}^1`, toRev: hash })
                : await invoke('git_commit_files', { path: State.gitRoot, hash: hash });
            if (files.length === 0) return;

            // The files under the summary, to pick from.
            this._showCommitFileList(hash, message, files);

            // If only one file changed, show its diff directly
            if (files.length === 1) await this._openCommitCompare(entry || hash, files[0].path);
        } catch (e) {
            console.error('Failed to get commit diff:', e);
        }
    }

    /**
     * The selected commit, summarised in two lines above its files: hash and
     * subject, then author, date, refs and the file count. The full record
     * (whole hash, e-mail, exact date, parents, full message) opens on click.
     *
     * It used to be a block of labelled rows plus a second header over the
     * file list repeating the hash and subject, which together took most of
     * the pane and left room for two or three files.
     */
    _showCommitDetail(hash) {
        const entry = (this._lastHistory || []).find(e => e.hash === hash)
            || (this._fullHistory || []).find(e => e.hash === hash);
        if (!entry) return;

        const panel = this._showDetailPanel();
        if (!panel) return;
        panel.innerHTML = '';

        const expanded = localStorage.getItem('git_detail_expanded') === 'true';
        const box = document.createElement('div');
        box.className = 'git-cd' + (expanded ? ' is-expanded' : '');
        box.dataset.hash = hash;

        const refs = String(entry.refs || '').split(',').map((r) => r.trim()).filter(Boolean);
        const refsHtml = refs.map((r) => {
            const tag = r.startsWith('tag:');
            const name = tag ? r.replace(/^tag:\s*/, '') : r.replace(/^HEAD -> /, 'HEAD → ');
            return `<span class="git-cd-ref${tag ? ' is-tag' : ''}">${tag ? svgIcon('tag', { size: 9 }) : ''}${escapeHtml(name)}</span>`;
        }).join('');
        const parents = (entry.parents || []).map((p) => p.substring(0, 7)).join(', ');
        const openLabel = escapeHtml(t('Open Changes in Editor'));

        box.innerHTML = `
            <div class="git-cd-summary" title="${escapeHtml(t('Show details'))}">
                <span class="git-cd-caret">${svgIcon('chevron-right', { size: 11 })}</span>
                <span class="git-cd-hash">${escapeHtml(entry.short_hash || hash.substring(0, 7))}</span>
                <span class="git-cd-subject">${escapeHtml(entry.message)}</span>
                <button class="git-cd-btn git-commit-open-editor" title="${openLabel}" aria-label="${openLabel}">${svgIcon('compare', { size: 13 })}</button>
                <button class="git-cd-btn git-commit-detail-close" title="Close" data-i18n-title="Close" aria-label="Close">${svgIcon('close', { size: 13 })}</button>
            </div>
            <div class="git-cd-meta">
                <span class="git-cd-author">${escapeHtml(entry.author)}</span>
                <span class="git-cd-date" title="${escapeHtml(entry.iso_date || '')}">${escapeHtml(entry.date)}</span>
                <span class="git-cd-count"></span>
                ${refsHtml}
            </div>
            <div class="git-cd-full">
                <div><span class="git-cd-key">${escapeHtml(t('Commit'))}</span><span class="git-cd-val git-cd-mono">${escapeHtml(entry.hash)}</span></div>
                <div><span class="git-cd-key">${escapeHtml(t('Author'))}</span><span class="git-cd-val">${escapeHtml(entry.author)} &lt;${escapeHtml(entry.author_email || '')}&gt;</span></div>
                <div><span class="git-cd-key">${escapeHtml(t('Date'))}</span><span class="git-cd-val">${escapeHtml(entry.iso_date || entry.date)}</span></div>
                ${parents ? `<div><span class="git-cd-key">${escapeHtml(t('Parents'))}</span><span class="git-cd-val git-cd-mono">${escapeHtml(parents)}</span></div>` : ''}
                <div class="git-cd-message">${escapeHtml(entry.message)}</div>
            </div>
            <div class="git-cd-files"></div>
        `;

        const summary = box.querySelector('.git-cd-summary');
        summary.onclick = (e) => {
            if (e.target.closest('button')) return;
            const open = !box.classList.contains('is-expanded');
            box.classList.toggle('is-expanded', open);
            try { localStorage.setItem('git_detail_expanded', String(open)); } catch (_) { /* private mode */ }
        };
        box.querySelector('.git-commit-detail-close').onclick = () => this._hideDetailPanel();
        box.querySelector('.git-commit-open-editor').onclick = () => this._openCommitCompare(entry);

        panel.appendChild(box);
    }

    /** The commit's files, under its summary; each opens in the comparison tab. */
    _showCommitFileList(hash, message, files) {
        const panel = this._showDetailPanel();
        if (!panel) return;
        let box = panel.querySelector(`.git-cd[data-hash="${cssEscape(hash)}"]`);
        if (!box) {
            this._showCommitDetail(hash);
            box = panel.querySelector(`.git-cd[data-hash="${cssEscape(hash)}"]`);
        }
        if (!box) return;

        const count = box.querySelector('.git-cd-count');
        if (count) count.textContent = t('{n} files', { n: files.length });

        const list = box.querySelector('.git-cd-files');
        list.innerHTML = '';
        files.forEach(f => {
            const item = document.createElement('div');
            item.className = 'git-commit-file-item';
            item.title = f.old_path ? `${f.old_path} → ${f.path}` : f.path;
            const status = document.createElement('span');
            status.className = `git-cd-status gcv-st-${f.status}`;
            status.textContent = f.status;
            const name = document.createElement('span');
            name.className = 'git-cd-file-name';
            const cut = f.path.lastIndexOf('/');
            name.textContent = cut >= 0 ? f.path.slice(cut + 1) : f.path;
            const dir = document.createElement('span');
            dir.className = 'git-cd-file-dir';
            dir.textContent = cut >= 0 ? f.path.slice(0, cut) : '';
            item.append(status, name, dir);
            item.onclick = () => this._openCommitCompare(hash, f.path);
            list.appendChild(item);
        });
    }

    _truncate(str, n) {
        if (!str) return '';
        return str.length > n ? str.substr(0, n - 1) + '…' : str;
    }

    /**
     * The branch and tag badges of a history row. The branch badges carry
     * the colour of the lane they sit on, so a name can be followed down the
     * graph; each badge says its ref so a right-click on it can act on it.
     */
    _formatRefs(refs, laneColor = null) {
        if (!refs) return '';
        const parts = refs.split(', ').map(r => r.trim()).filter(Boolean);
        let html = '<div class="git-refs-container-v4">';
        parts.forEach(r => {
            let className = 'git-ref-tag-v4';
            let ref = r;
            let text = r;
            if (r.startsWith('HEAD ->')) {
                className += ' git-ref-head-v4';
                ref = r.replace('HEAD ->', '').trim();
                text = `HEAD → ${ref}`;
            } else if (r.startsWith('tag:')) {
                className += ' git-ref-tagname-v4';
                ref = r.replace(/^tag:\s*/, '');
                text = ref;
            } else if (r === 'HEAD') {
                ref = '';
            } else if (r.includes('/')) {
                className += ' git-ref-remote-v4';
            }
            const lane = laneColor !== null && !r.startsWith('tag:')
                ? ` style="--ref-lane: var(--git-lane-${laneColor})"` : '';
            const icon = r.startsWith('tag:') ? svgIcon('tag', { size: 9 }) : '';
            html += `<span class="${className}"${lane}${ref ? ` data-ref="${escapeHtml(ref)}"` : ''} title="${escapeHtml(r)}">${icon}${escapeHtml(text)}</span>`;
        });
        html += '</div>';
        return html;
    }

    async stageFile(path) {
        const plan = stagePlan(path, this._lastStatus);
        try {
            if (!plan.paths) {
                await invoke('git_add', { path: State.gitRoot, file: path });
            } else {
                if (plan.paths.length) await this._git(['add', '-A', '--', ...plan.paths]);
                if (window.showToast) {
                    window.showToast(t('Conflicted files were left unstaged. Mark each one resolved once it is fixed.'));
                }
            }
        } catch (e) {
            showAlert(`Git Error: ${e}`, { title: 'Git', kind: 'error' });
        }
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

        input.placeholder = t('Generating…');
        input.value = '';

        try {
            const message = await AIAgent.runSingleShot({
                prompt: commitMessagePrompt(diff.slice(0, 12000)),
                systemPrompt: `You generate a concise conventional-commit message from a git diff. The summary line stays in English; respond in ${promptLanguageName()} for any longer description.`,
            });
            const cleaned = (message || '').trim().replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/, '').trim();
            input.value = cleaned || '';
            input.placeholder = t('Commit message (Required)');
            if (cleaned) input.focus();
        } catch (e) {
            input.placeholder = t('Commit message (Required)');
            const msg = (e && e.message) || String(e);
            if (/not reachable|failed to fetch|connection refused/i.test(msg)) {
                showAlert('Cannot reach J.H AI Agent. Start the agent and try again.', { title: 'Commit Message', kind: 'error' });
            } else {
                showAlert(`Could not generate a commit message: ${msg}`, { title: 'Commit Message', kind: 'error' });
            }
        }
    }

    async showDiff(filePath, isStaged, { replaces = null, focus = false } = {}) {
        if (!State.gitRoot || !window.app?.openMergeTab) return;
        
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

            let modified = '';
            // Where saving the right-hand side writes. Only the working tree is
            // a file; HEAD and the index are shown, never written.
            let rightTarget = null;
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
                    if (fileData) {
                        rightTarget = {
                            kind: 'path',
                            path: fullPath,
                            encoding: fileData.encoding || 'UTF-8',
                            eol: fileData.eol || (/\r\n/.test(modified) ? '\r\n' : '\n'),
                        };
                    }
                } catch (e) {
                    modified = '';
                }
            }

            // Build ordered file list for Ctrl+Up/Down navigation between diffs
            const fileList = this._getDiffFileList(isStaged);
            const currentIndex = fileList.findIndex(f => f.path === filePath);

            // Ctrl+Down / Ctrl+Up inside the comparison move between files.
            const id = `git:${isStaged ? 'index' : 'worktree'}:${filePath}`;
            const nav = {
                fileList,
                currentIndex,
                isStaged,
                index: currentIndex,
                count: fileList.length,
                onNextFile: () => this._navigateDiffFile(fileList, currentIndex, 1, isStaged, id),
                onPrevFile: () => this._navigateDiffFile(fileList, currentIndex, -1, isStaged, id),
            };
            window.app._gitDiffNav = nav;

            const name = String(filePath).split(/[\\/]/).pop();
            window.app.openMergeTab({
                id,
                replaces,
                title: `Diff: ${name}`,
                path: filePath,
                nav,
                left: { label: `${filePath} (HEAD)`, text: original },
                right: {
                    label: `${filePath} (${isStaged ? 'Index' : 'Working Tree'})`,
                    text: modified,
                    writable: !!rightTarget,
                    target: rightTarget,
                },
            });
            // Opened from the keyboard inside a diff: stay in the diff, so the
            // next Ctrl+Down reaches it too.
            if (focus) this._focusActiveEditor();
        } catch (e) {
            console.error('Failed to show diff:', e);
        }
    }

    /** Hand the keyboard to the tab in front (the diff just opened). */
    _focusActiveEditor() {
        // The view is built on the next frame.
        requestAnimationFrame(() => { if (window.app?.focusEditor) window.app.focusEditor(); });
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

    /**
     * Get the flat list of changed files for navigation.
     *
     * From the status, not from the rendered rows: a folder left closed in the
     * tree has no rows, and its files used to be skipped by Ctrl+Down as if
     * they had no changes. Untracked folders (`dir/`) have nothing to diff.
     */
    _getDiffFileList(isStaged) {
        const status = this._lastStatus;
        if (!status) return [];
        const paths = isStaged
            ? (status.staged || [])
            : [...(status.modified || []), ...(status.deleted || []), ...(status.untracked || [])];
        const files = paths.filter((p) => !/[/\\]$/.test(p)).map((p) => ({ path: p, status: 'M' }));
        files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return fileOrder(buildFileTree(files)).map((path) => ({ path, isStaged }));
    }

    /**
     * Navigate to next/prev diff file in the list. The comparison being left
     * makes way for the next one rather than staying open as a tab of its own.
     */
    async _navigateDiffFile(fileList, currentIndex, direction, isStaged, fromId = null) {
        const nextIndex = currentIndex + direction;
        if (nextIndex < 0 || nextIndex >= fileList.length) return; // skip if out of bounds
        const nextFile = fileList[nextIndex];
        if (nextFile) {
            await this.showDiff(nextFile.path, isStaged, { replaces: fromId, focus: true });
        }
    }
}

export default GitPanel;
