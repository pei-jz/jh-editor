/**
 * AiChatPanel.js — persistent AI chat sidebar (Phase 2).
 *
 * A side panel where the user chats with the J.H AI Agent. Messages are kept in
 * memory for the session (and a compact history in localStorage). Uses the
 * lightweight single-shot path (AIAgent.runSingleShot) so it answers quickly
 * without the full iterative agent loop; the user's selection / active file are
 * offered as context but not forced.
 *
 * Dependency-light: renders markdown via global `marked` (falls back to <pre>).
 */

import AIAgent from '../ai/AIAgent.js';
import { icon as svgIcon } from './Icons.js';
import { allows, isPrivatePath, scopeInfo } from '../ai/ContextScope.js';
import { t, promptLanguageName } from '../utils/I18n.js';
import { sanitizeHtml } from '../utils/SanitizeHtml.js';

const HISTORY_KEY = 'jh_ai_chat_history_v1';
const MAX_HISTORY = 40;

function renderMarkdown(md) {
    try {
        // Model output is not trusted input: it lands in the main document, so
        // it goes through the same sanitiser as a Markdown file would.
        if (typeof marked !== 'undefined' && marked.parse) return sanitizeHtml(marked.parse(md || ''));
    } catch (_) { /* fall through */ }
    return `<pre style="white-space:pre-wrap;margin:0;">${String(md || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
}

function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((m) => m && m.role) : [];
    } catch (_) { return []; }
}

function saveHistory(messages) {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-MAX_HISTORY)));
    } catch (_) { /* ignore */ }
}

class AiChatPanel {
    constructor() {
        this._root = null;
        this._messages = loadHistory();
        this._busy = false;
    }

    isOpen() { return !!this._root; }

    toggle() {
        if (this._root) this.close();
        else this.open();
    }

    open() {
        if (this._root) return;
        const root = document.createElement('div');
        root.className = 'ai-chat-panel';

        root.innerHTML = `
            <div class="ai-chat-header">
                <span class="ai-chat-header-title jh-icon-row">${svgIcon('robot', { size: 14 })}${t('AI Chat')}</span>
                <button class="clear-btn" title="${t('Clear history')}">${t('Clear')}</button>
                <button class="close-btn" title="${t('Close')}">×</button>
            </div>
            <div class="ai-chat-messages"></div>
            <div class="ai-chat-hint" id="ai-chat-scope-hint"></div>
            <div class="ai-chat-input-row">
                <textarea class="ai-chat-input" placeholder="${t('Ask a question… (Shift+Enter for a new line)')}"></textarea>
                <button class="ai-chat-send">${t('Send')}</button>
            </div>
        `;
        document.body.appendChild(root);
        this._root = root;

        // Restore the persisted panel width, then make the left edge draggable.
        const savedWidth = parseInt(localStorage.getItem('jh_ai_chat_width') || '380', 10);
        root.style.width = `${Math.min(Math.max(savedWidth, 240), 900)}px`;
        this._attachResizer(root);

        const list = root.querySelector('.ai-chat-messages');
        const input = root.querySelector('.ai-chat-input');
        const send = root.querySelector('.ai-chat-send');

        root.querySelector('.close-btn').onclick = () => this.close();
        root.querySelector('.clear-btn').onclick = () => {
            this._messages = [];
            saveHistory(this._messages);
            list.innerHTML = '';
        };

        const renderAll = () => {
            list.innerHTML = '';
            this._messages.forEach((m) => this._append(list, m));
            list.scrollTop = list.scrollHeight;
        };

        const append = (m) => {
            this._messages.push(m);
            saveHistory(this._messages);
            this._append(list, m);
            list.scrollTop = list.scrollHeight;
        };

        const sendMessage = async () => {
            const text = input.value.trim();
            if (!text || this._busy) return;
            input.value = '';
            append({ role: 'user', content: text });

            this._busy = true;
            send.disabled = true;
            const assistant = { role: 'assistant', content: '' };
            append(assistant);

            const findAssistant = () => list.querySelector('.ai-chat-msg.assistant:last-child .ai-chat-msg-body');
            const bodyEl = findAssistant();

            // A request that takes eight seconds and a request that has died look
            // identical without this. It also puts a number on "the editor is
            // talking to a model right now", which is worth seeing.
            const startedAt = Date.now();
            // Filled in once the context is built, so the line can say what
            // actually went with the message rather than what might have.
            let sentLabel = '';
            const meta = document.createElement('div');
            meta.className = 'ai-chat-meta';
            bodyEl?.parentElement?.appendChild(meta);
            const paint = (label) => {
                const ms = Date.now() - startedAt;
                const time = ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
                meta.textContent = `${label} ${time}${sentLabel}`;
            };
            const ticker = setInterval(() => paint(`⏳ ${t('Sending…')}`), 100);

            try {
                const { context, sent } = this._buildContext();
                sentLabel = sent.length ? `  ·  sent: ${sent.join(', ')}` : '  ·  sent: prompt only';
                const systemPrompt =
                    `You are an AI assistant inside JHEditor. Answer in ${promptLanguageName()}. `
                    + 'Use Markdown. Be concise.';
                const answer = await AIAgent.runSingleShot({
                    prompt: text,
                    systemPrompt,
                    context,
                    onUpdate: (chunk) => {
                        assistant.content = chunk;
                        const b = findAssistant();
                        if (b) b.innerHTML = renderMarkdown(chunk);
                        list.scrollTop = list.scrollHeight;
                    },
                });
                if (!assistant.content) {
                    assistant.content = answer;
                    if (bodyEl) bodyEl.innerHTML = renderMarkdown(answer);
                }
            } catch (e) {
                const msg = (e && e.message) || String(e);
                assistant.content = msg;
                assistant.role = 'assistant';
                if (bodyEl) {
                    bodyEl.parentElement.classList.add('error');
                    bodyEl.innerHTML = `<span class="jh-icon-row">${svgIcon('x-circle', { size: 13 })}${String(msg).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`;
                }
            } finally {
                clearInterval(ticker);
                paint('⏱');
                this._busy = false;
                send.disabled = false;
                input.focus();
            }
        };

        send.onclick = sendMessage;
        input.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        };

        // The hint used to claim the selection was only sent via a button, while
        // the code attached it (and 4000 characters of the file) every time. It
        // now reports the setting that actually governs it.
        const hint = root.querySelector('#ai-chat-scope-hint');
        if (hint) {
            const s = scopeInfo();
            hint.textContent = t('Context scope: {label} — {hint}', { label: s.label, hint: s.hint })
                + ' ' + t('Change it in Settings → Agent Integration.');
        }

        renderAll();
        input.focus();
    }

    /**
     * What travels with the message.
     *
     * This panel PUSHES context — unlike the MCP tools, which the model pulls —
     * so it used to attach the workspace path, the active file's path and its
     * first 4000 characters on EVERY message, whatever the AI context scope
     * said. That is exactly the data the scope setting exists to govern, so it
     * is governed here too.
     *
     * Returns `{ context, sent }`: `sent` is the human list of what went, which
     * the panel shows under the answer. A privacy setting nobody can see the
     * effect of is not worth much.
     */
    _buildContext() {
        const sent = [];
        try {
            const view = window.app?.getCurrentView?.();
            const active = window.app?.getActiveFile?.() || null;
            const activePath = active ? (active.path || active.name || null) : null;
            // Personal notes never travel, at any scope.
            const isPrivate = isPrivatePath(activePath);

            let selected = '';
            if (!isPrivate && view && typeof view.getSelectedText === 'function') {
                try { selected = view.getSelectedText() || ''; } catch (_) { /* none */ }
            }

            const context = { app: 'jheditor' };

            if (selected && allows('selection')) {
                context.selection = selected;
                sent.push(`selection (${selected.length} chars)`);
            }
            if (!isPrivate && allows('activeBuffer')) {
                context.activeFile = activePath;
                const body = typeof active?.content === 'string' ? active.content : '';
                context.activeFileSnippet = body.slice(0, 4000);
                sent.push(context.activeFileSnippet.length >= 4000
                    ? 'active file (first 4000 chars)'
                    : `active file (${context.activeFileSnippet.length} chars)`);
            }
            // The workspace PATH is only meaningful to a model that may read the
            // workspace, and a path can itself be revealing (a client's name).
            if (allows('workspaceFiles')) {
                context.workspace = window.app?.getCurrentDir?.() || null;
                if (context.workspace) sent.push('workspace path');
            }
            if (isPrivate) sent.push('personal note excluded');

            return { context, sent };
        } catch (_) {
            return { context: null, sent: [] };
        }
    }

    _append(list, m) {
        const el = document.createElement('div');
        el.className = 'ai-chat-msg ' + m.role;
        const body = document.createElement('div');
        body.className = 'ai-chat-msg-body';
        if (m.role === 'assistant') body.innerHTML = renderMarkdown(m.content);
        else body.textContent = m.content;
        el.appendChild(body);
        list.appendChild(el);
    }

    _attachResizer(root) {
        const handle = document.createElement('div');
        handle.className = 'ai-chat-resizer';
        root.appendChild(handle);

        let startX = 0;
        let startW = 0;
        const onMove = (ev) => {
            const w = Math.max(240, Math.min(900, startW + (startX - ev.clientX)));
            root.style.width = `${w}px`;
        };
        const onUp = () => {
            const w = parseInt(root.style.width, 10);
            if (!Number.isNaN(w)) localStorage.setItem('jh_ai_chat_width', String(w));
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        };
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            startX = e.clientX;
            startW = root.getBoundingClientRect().width;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
        });
    }

    close() {
        if (this._root) {
            this._root.remove();
            this._root = null;
        }
    }
}

export const aiChatPanel = new AiChatPanel();
