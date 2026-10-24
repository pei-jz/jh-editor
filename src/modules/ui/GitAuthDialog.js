/**
 * GitAuthDialog.js — git's credential questions, asked in the editor.
 *
 * When git (run from the Git panel) needs a user name, a password or an SSH
 * key passphrase and no credential helper answers, the backend (askpass.rs)
 * emits "git-askpass" to the window that ran it, and this module asks.
 *
 *   username    host, user name and password together: git asks for the
 *               two separately, the backend answers the second from this one
 *   password    when the user name is already known (it was in the URL)
 *   passphrase  the key file and its passphrase
 *   confirm     ssh's first-connection check, with the fingerprint shown
 *   text        anything else: the prompt as it came, and one field
 *
 * Nothing typed here is kept by this module; the reply goes straight to the
 * backend, which keeps it only when "Remember for this session" is ticked.
 * Questions that arrive while one is open wait their turn.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { showDialog } from './Dialog.js';
import { t } from '../utils/I18n.js';

const FIELD_CSS = 'width:100%;box-sizing:border-box;padding:5px 7px;font:inherit;font-size:12px;'
    + 'color:var(--text-color);background:var(--bg-color-secondary);border:1px solid var(--border-color);border-radius:3px;';

function el(tag, css = '', text = null) {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text != null) node.textContent = text;
    return node;
}

function field(label, { type = 'text', value = '', readOnly = false } = {}) {
    const row = el('label', 'display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-secondary);');
    row.appendChild(el('span', '', label));
    const input = el('input', FIELD_CSS);
    input.type = type;
    input.value = value;
    input.readOnly = readOnly;
    input.autocomplete = 'off';
    input.spellcheck = false;
    row.appendChild(input);
    return { row, input };
}

/** The host part of a URL, for the dialog's title. */
export function hostName(url) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(String(url || ''));
    return m ? m[1] : String(url || '');
}

/**
 * The dialog for one question: its title, message, form and how to read the
 * reply from it. Exported so each kind can be checked without a backend.
 */
export function formFor(q) {
    const form = el('div', 'display:flex;flex-direction:column;gap:10px;margin-top:6px;');
    const fields = {};
    let message = '';
    let title = t('Git Authentication');

    if (q.kind === 'username' || q.kind === 'password') {
        title = t('Sign in to {host}', { host: hostName(q.host) });
        message = q.host;
        const user = field(t('User name'), { value: q.user || '', readOnly: q.kind === 'password' && !!q.user });
        const pass = field(t('Password or access token'), { type: 'password' });
        fields.user = user.input;
        fields.pass = pass.input;
        form.append(user.row, pass.row);
        form.appendChild(el('div', 'font-size:11px;color:var(--text-secondary);line-height:1.5;',
            t('GitHub, GitLab and most hosted services take a personal access token in place of the password.')));
    } else if (q.kind === 'passphrase') {
        title = t('SSH Key Passphrase');
        message = q.key || q.prompt;
        const pass = field(t('Passphrase'), { type: 'password' });
        fields.pass = pass.input;
        form.appendChild(pass.row);
    } else if (q.kind === 'confirm') {
        title = t('Unknown SSH Host');
        message = t('This is the first connection to this host. Check its fingerprint before connecting.');
        form.appendChild(el('pre', 'margin:0;padding:8px;font-size:11px;white-space:pre-wrap;word-break:break-all;'
            + 'background:var(--bg-color-secondary);border-radius:4px;max-height:200px;overflow:auto;', q.prompt));
    } else {
        message = q.prompt;
        const answer = field(t('Answer'));
        fields.text = answer.input;
        form.appendChild(answer.row);
    }

    let remember = null;
    if (q.kind !== 'confirm' && q.kind !== 'text') {
        const row = el('label', 'display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;');
        remember = el('input');
        remember.type = 'checkbox';
        row.append(remember, el('span', '', t('Remember until J.H Editor is closed')));
        form.appendChild(row);
        form.appendChild(el('div', 'font-size:11px;color:var(--text-secondary);line-height:1.5;',
            t('Nothing is saved to disk. To stay signed in, use Git Credential Manager.')));
    }

    /** The reply for the backend, from what was typed. */
    const read = () => {
        const keep = !!(remember && remember.checked);
        if (q.kind === 'username') {
            return { answer: fields.user.value, password: fields.pass.value, remember: keep };
        }
        if (q.kind === 'password' || q.kind === 'passphrase') {
            return { answer: fields.pass.value, password: null, remember: keep };
        }
        if (q.kind === 'confirm') return { answer: 'yes', password: null, remember: false };
        return { answer: fields.text.value, password: null, remember: false };
    };
    /** The field the cursor should start in. */
    const first = () => {
        if (fields.user && !fields.user.readOnly && !fields.user.value) return fields.user;
        return fields.pass || fields.text || null;
    };
    /** Clear what was typed, once it has been sent. */
    const wipe = () => { for (const f of Object.values(fields)) f.value = ''; };

    const okLabel = q.kind === 'confirm' ? t('Connect') : t('OK');
    return { title, message, form, read, first, wipe, okLabel };
}

/** Ask one question and send the reply (or a cancel) to the backend. */
export async function ask(q, { send = (args) => invoke('git_askpass_reply', args) } = {}) {
    const f = formFor(q);
    const shown = showDialog({
        title: f.title,
        message: f.message,
        kind: q.kind === 'confirm' ? 'warning' : 'info',
        width: 'min(460px, 92vw)',
        content: f.form,
        buttons: [
            { label: t('Cancel'), value: false, cancel: true },
            { label: f.okLabel, value: true, primary: true },
        ],
    });
    setTimeout(() => { const input = f.first(); if (input) input.focus(); }, 0);
    const ok = await shown;
    const reply = ok ? f.read() : { answer: null, password: null, remember: false };
    f.wipe();
    try {
        await send({ id: q.id, ...reply });
    } catch (e) {
        console.warn('git_askpass_reply failed', e);
    }
}

let queue = Promise.resolve();

/** Listen for this window's questions, one dialog at a time. */
export function initGitAuth() {
    let label = null;
    try { label = getCurrentWindow().label; } catch (_) { /* outside Tauri */ }
    listen('git-askpass', (event) => {
        const q = event.payload || {};
        // A global listen hears every window's questions; answer only ours.
        if (q.window && label && q.window !== label) return;
        queue = queue.then(() => ask(q)).catch((e) => console.warn('git auth dialog failed', e));
    }).catch((e) => console.warn('git-askpass listener not installed', e));
}
