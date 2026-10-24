/**
 * GitBranchOps.js — merge, rebase and reset from the Git panel.
 *
 * Each one is a dialog in the shape the common IDEs use (IntelliJ's "Git
 * Reset" with its Soft / Mixed / Hard / Keep choices, VS Code's "Merge Branch…"
 * picker), followed by one git command. What happens after it is shared: a
 * stop on conflicts refreshes the panel and opens the first conflict in the
 * three-way merge view; any other failure shows git's own message.
 *
 * The commands are built by the pure functions at the top, so what is run for
 * each choice can be tested without a repository.
 *
 * Nothing here may wait on an editor: the panel runs git with no terminal, so
 * merge gets --no-edit and rebase gets core.editor=true (git's "accept the
 * prepared message as it is").
 */
import { t } from '../utils/I18n.js';
import { showAlert, showConfirm, showDialog } from './Dialog.js';
import { createFilterSelect } from './FilterSelect.js';
import { State } from '../core/Store.js';

const NO_EDITOR = ['-c', 'core.editor=true'];

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * `git merge` for one of the dialog's modes:
 *   default   fast-forward when possible, else a merge commit
 *   no-ff     always a merge commit
 *   ff-only   fast-forward or nothing
 *   squash    the changes staged, no commit
 */
export function mergeArgs(ref, { mode = 'default', autostash = false } = {}) {
    const args = ['merge'];
    if (mode === 'squash') args.push('--squash');
    else args.push('--no-edit');
    if (mode === 'no-ff') args.push('--no-ff');
    if (mode === 'ff-only') args.push('--ff-only');
    if (autostash) args.push('--autostash');
    args.push(ref);
    return args;
}

export function rebaseArgs(onto, { autostash = false } = {}) {
    return [...NO_EDITOR, 'rebase', ...(autostash ? ['--autostash'] : []), onto];
}

export const RESET_MODES = ['soft', 'mixed', 'hard', 'keep'];

export function resetArgs(target, mode = 'mixed') {
    if (!RESET_MODES.includes(mode)) throw new Error(`unknown reset mode: ${mode}`);
    return ['reset', `--${mode}`, target];
}

/** Continue, skip or abort the operation in progress ('rebase', 'merge', …). */
export function sequencerArgs(kind, action) {
    if (action === 'continue') return [...NO_EDITOR, kind, '--continue'];
    return [kind, `--${action}`];
}

/** Changes a merge, rebase or hard reset could collide with. Untracked files do not count. */
export function hasLocalChanges(status) {
    if (!status) return false;
    return ['staged', 'modified', 'deleted', 'conflicted'].some((k) => (status[k] || []).length > 0);
}

// ── Dialog parts ────────────────────────────────────────────────────────────

const FORM_CSS = 'display:flex;flex-direction:column;gap:10px;margin-top:4px;font-size:12px;';

function el(tag, css = '', text = null) {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text != null) node.textContent = text;
    return node;
}

function section(label, child) {
    const box = el('div', 'display:flex;flex-direction:column;gap:5px;');
    box.appendChild(el('div', 'font-weight:600;color:var(--text-secondary);', label));
    box.appendChild(child);
    return box;
}

/** Radio buttons, each with a line saying what it does. */
function radioGroup(name, options, value) {
    const box = el('div', 'display:flex;flex-direction:column;gap:6px;');
    for (const o of options) {
        const row = el('label', 'display:grid;grid-template-columns:auto 1fr;gap:2px 7px;align-items:start;cursor:pointer;');
        const input = el('input', 'margin:2px 0 0;');
        input.type = 'radio';
        input.name = name;
        input.value = o.value;
        input.checked = o.value === value;
        row.appendChild(input);
        row.appendChild(el('span', 'font-weight:600;color:var(--text-color);', o.label));
        row.appendChild(el('span', ''));
        row.appendChild(el('span', 'color:var(--text-secondary);line-height:1.4;', o.detail));
        box.appendChild(row);
    }
    return {
        element: box,
        getValue: () => (box.querySelector('input:checked') || {}).value || value,
    };
}

function checkbox(label, checked) {
    const row = el('label', 'display:flex;align-items:center;gap:7px;cursor:pointer;');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    row.append(input, el('span', '', label));
    return { element: row, get checked() { return input.checked; } };
}

function refPicker(groups, value) {
    const picker = createFilterSelect({
        groups: groups.filter((g) => g.items.length),
        value,
        placeholder: t('branch…'),
    });
    picker.element.style.width = '100%';
    return picker;
}

const note = (text = '') => el('div', 'color:var(--text-secondary);line-height:1.5;min-height:1.5em;', text);
const warning = (text) => el('div',
    'padding:7px 9px;border-radius:4px;line-height:1.5;color:var(--text-color);'
    + 'background:color-mix(in srgb, var(--danger-color, #f85149) 12%, transparent);'
    + 'border-left:3px solid var(--danger-color, #f85149);', text);

// ── Running ─────────────────────────────────────────────────────────────────

function currentBranch(panel) {
    const b = panel._activeBranch || '';
    return b && !b.startsWith('HEAD') ? b : 'HEAD';
}

/** Refuse to start one operation in the middle of another. */
async function ready(panel) {
    if (!State.gitRoot) return false;
    if (panel._lastStatus && panel._lastStatus.operation) {
        await showAlert(t('A merge, rebase or similar operation is in progress. Finish or abort it first.'),
            { title: 'Git', kind: 'warning' });
        return false;
    }
    return true;
}

async function countCommits(panel, range) {
    try {
        return parseInt(String(await panel._git(['rev-list', '--count', range])).trim(), 10);
    } catch (e) {
        return null;
    }
}

const toast = (msg) => { if (window.showToast) window.showToast(msg); };

/**
 * Run one operation. A stop on conflicts is not an error: the panel shows the
 * operation and its conflicts, and the first one opens to be resolved.
 * Resolves git's output, or null when it did not succeed.
 */
export async function runOperation(panel, args) {
    try {
        const out = await panel._git(args);
        await panel.refresh();
        return String(out || '');
    } catch (e) {
        await panel.refresh();
        const count = panel._conflicts().length;
        if (count) {
            await showAlert(t('Stopped with {count} conflicted files. Resolve them, then continue from the banner at the top of the panel.', { count }),
                { title: 'Git', kind: 'warning' });
            if (typeof panel.openFirstConflict === 'function') panel.openFirstConflict();
        } else {
            await showAlert(String(e).replace(/^Error:\s*/, ''), { title: 'Git', kind: 'error' });
        }
        return null;
    }
}

// ── Merge ───────────────────────────────────────────────────────────────────

/** "Merge into <current>…": pick a branch and how to merge it. */
export async function mergeBranch(panel, preset = '') {
    if (!(await ready(panel))) return;
    const current = currentBranch(panel);
    const { local, remote, tags } = await panel._listRefs();
    const groups = [
        { label: t('Local'), items: local.filter((b) => b !== current) },
        { label: t('Remote'), items: remote },
        { label: t('Tags'), items: tags },
    ];
    const first = groups.flatMap((g) => g.items)[0];
    if (!first) {
        await showAlert(t('There is no other branch to merge.'), { title: t('Merge'), kind: 'info' });
        return;
    }

    const preview = note();
    const picker = createFilterSelect({
        groups: groups.filter((g) => g.items.length),
        value: preset || first,
        placeholder: t('branch…'),
        onChange: () => update(),
    });
    picker.element.style.width = '100%';
    const update = async () => {
        const ref = picker.getValue();
        const n = await countCommits(panel, `HEAD..${ref}`);
        if (picker.getValue() !== ref) return;
        preview.textContent = n === null ? ''
            : n === 0 ? t('{branch} already contains everything in {ref}.', { branch: current, ref })
                : t('{count} commits from {ref} will be merged into {branch}.', { count: n, ref, branch: current });
    };
    update();

    const modes = radioGroup('git-merge-mode', [
        { value: 'default', label: t('Default'), detail: t('Fast-forward when possible, otherwise create a merge commit.') },
        { value: 'no-ff', label: t('Create a merge commit (--no-ff)'), detail: t('Always record the merge as a commit, even when a fast-forward is possible.') },
        { value: 'ff-only', label: t('Fast-forward only (--ff-only)'), detail: t('Merge only if no merge commit is needed; otherwise stop.') },
        { value: 'squash', label: t('Squash (--squash)'), detail: t('Bring the changes in as staged changes, without a merge commit. You commit them yourself.') },
    ], 'default');

    const form = el('div', FORM_CSS);
    form.append(section(t('Branch to merge'), picker.element), preview, section(t('Options'), modes.element));
    const stash = hasLocalChanges(panel._lastStatus)
        ? checkbox(t('Stash local changes during the merge and restore them afterwards (--autostash)'), true) : null;
    if (stash) form.appendChild(stash.element);

    const go = await showDialog({
        title: t('Merge into {branch}', { branch: current }),
        kind: 'info',
        width: 'min(560px, 92vw)',
        content: form,
        buttons: [
            { label: t('Cancel'), value: false, cancel: true },
            { label: t('Merge'), value: true, primary: true },
        ],
    });
    if (!go) return;
    const ref = picker.getValue();
    const mode = modes.getValue();
    const out = await runOperation(panel, mergeArgs(ref, { mode, autostash: !!(stash && stash.checked) }));
    if (out === null) return;
    if (/Already up.to.date/i.test(out)) {
        toast(t('Already up to date.'));
    } else if (mode === 'squash') {
        // Nothing is committed by a squash: the commit is the user's to make.
        toast(t('The changes from {ref} are staged. Commit them to finish.', { ref }));
        if (typeof panel.openCommitModal === 'function') {
            panel.openCommitModal(t('Squashed merge of {ref}', { ref }));
        }
    } else if (/Fast-forward/i.test(out)) {
        toast(t('Fast-forwarded {branch} to {ref}.', { branch: current, ref }));
    } else {
        toast(t('Merged {ref} into {branch}.', { ref, branch: current }));
    }
}

// ── Rebase ──────────────────────────────────────────────────────────────────

/** "Rebase <current> onto…": replay the branch's own commits on another one. */
export async function rebaseBranch(panel, preset = '') {
    if (!(await ready(panel))) return;
    const current = currentBranch(panel);
    const { local, remote, tags } = await panel._listRefs();
    const groups = [
        { label: t('Local'), items: local.filter((b) => b !== current) },
        { label: t('Remote'), items: remote },
        { label: t('Tags'), items: tags },
    ];
    const first = groups.flatMap((g) => g.items)[0];
    if (!first) {
        await showAlert(t('There is no other branch to rebase onto.'), { title: t('Rebase'), kind: 'info' });
        return;
    }

    const preview = note();
    const picker = createFilterSelect({
        groups: groups.filter((g) => g.items.length),
        value: preset || first,
        placeholder: t('branch…'),
        onChange: () => update(),
    });
    picker.element.style.width = '100%';
    const update = async () => {
        const onto = picker.getValue();
        const mine = await countCommits(panel, `${onto}..HEAD`);
        const theirs = await countCommits(panel, `HEAD..${onto}`);
        if (picker.getValue() !== onto) return;
        preview.textContent = mine === null || theirs === null ? ''
            : theirs === 0 ? t('{branch} is already based on {onto}.', { branch: current, onto })
                : t('{count} commits of {branch} will be replayed on top of {onto}.', { count: mine, branch: current, onto });
    };
    update();

    const form = el('div', FORM_CSS);
    form.append(section(t('Onto'), picker.element), preview,
        warning(t('Rebasing rewrites the commits of {branch}. Do not rebase commits that others have already pulled.', { branch: current })));
    const stash = hasLocalChanges(panel._lastStatus)
        ? checkbox(t('Stash local changes during the rebase and restore them afterwards (--autostash)'), true) : null;
    if (stash) form.appendChild(stash.element);

    const go = await showDialog({
        title: t('Rebase {branch}', { branch: current }),
        kind: 'info',
        width: 'min(560px, 92vw)',
        content: form,
        buttons: [
            { label: t('Cancel'), value: false, cancel: true },
            { label: t('Rebase'), value: true, primary: true },
        ],
    });
    if (!go) return;
    const onto = picker.getValue();
    const out = await runOperation(panel, rebaseArgs(onto, { autostash: !!(stash && stash.checked) }));
    if (out === null) return;
    toast(/up to date/i.test(out) ? t('Already up to date.') : t('Rebased {branch} onto {onto}.', { branch: current, onto }));
}

// ── Reset ───────────────────────────────────────────────────────────────────

/**
 * "Reset <current> to…". `target` is a commit or ref; without one the dialog
 * offers the branches and tags to pick from.
 */
export async function resetBranch(panel, target = '', label = '') {
    if (!(await ready(panel))) return;
    const current = currentBranch(panel);

    let picker = null;
    const form = el('div', FORM_CSS);
    if (target) {
        let subject = '';
        try {
            subject = String(await panel._git(['log', '-1', '--format=%h  %s', target])).trim();
        } catch (e) { /* shown without its subject */ }
        form.appendChild(section(t('Target'), el('div', 'font-family:var(--editor-font-family, monospace);', subject || label || target)));
    } else {
        const { local, remote, tags } = await panel._listRefs();
        picker = refPicker([
            { label: '', items: ['HEAD~1'] },
            { label: t('Local'), items: local },
            { label: t('Remote'), items: remote },
            { label: t('Tags'), items: tags },
        ], 'HEAD~1');
        form.appendChild(section(t('Target'), picker.element));
    }

    const modes = radioGroup('git-reset-mode', [
        { value: 'soft', label: t('Soft'), detail: t('Keep every change, staged. Only the branch moves.') },
        { value: 'mixed', label: t('Mixed'), detail: t('Keep every change in the working tree, unstaged. The index is reset.') },
        { value: 'hard', label: t('Hard'), detail: t('Discard every change. The working tree and the index are reset to the target.') },
        { value: 'keep', label: t('Keep'), detail: t('Discard the commits but keep local changes; stops if a change would be overwritten.') },
    ], 'mixed');
    form.appendChild(section(t('Mode'), modes.element));

    const go = await showDialog({
        title: t('Reset {branch}', { branch: current }),
        kind: 'warning',
        width: 'min(560px, 92vw)',
        content: form,
        buttons: [
            { label: t('Cancel'), value: false, cancel: true },
            { label: t('Reset'), value: true, primary: true },
        ],
    });
    if (!go) return;
    const to = picker ? picker.getValue() : target;
    const mode = modes.getValue();
    if (mode === 'hard' && hasLocalChanges(panel._lastStatus)) {
        const sure = await showConfirm(
            t('A hard reset discards your uncommitted changes, and they cannot be recovered. Continue?'),
            { title: t('Reset'), kind: 'warning', okLabel: t('Discard and Reset') },
        );
        if (!sure) return;
    }
    const out = await runOperation(panel, resetArgs(to, mode));
    if (out !== null) toast(t('Reset {branch} to {target}.', { branch: current, target: label || to }));
}

/**
 * Undo the last commit, keeping its changes staged and its message in the
 * commit box — VS Code's "Undo Last Commit".
 */
export async function undoLastCommit(panel) {
    if (!(await ready(panel))) return;
    try {
        await panel._git(['rev-parse', '--verify', '--quiet', 'HEAD~1']);
    } catch (e) {
        await showAlert(t('The first commit of a repository cannot be undone this way.'), { title: 'Git', kind: 'info' });
        return;
    }
    let message = '';
    try {
        message = String(await panel._git(['log', '-1', '--format=%B'])).trim();
    } catch (e) { /* the box just stays empty */ }
    const out = await runOperation(panel, resetArgs('HEAD~1', 'soft'));
    if (out === null) return;
    const input = panel.element && panel.element.querySelector('#git-commit-input');
    if (input && !input.value.trim()) input.value = message;
    toast(t('Undid the last commit. Its changes are staged.'));
}

// ── In progress ─────────────────────────────────────────────────────────────

/** Continue or skip a rebase, cherry-pick or revert that stopped. */
export async function continueOperation(panel, kind, action = 'continue') {
    const out = await runOperation(panel, sequencerArgs(kind, action));
    if (out !== null && !(panel._lastStatus && panel._lastStatus.operation)) {
        toast(kind === 'rebase' ? t('Rebase finished.') : t('Done.'));
    }
}
