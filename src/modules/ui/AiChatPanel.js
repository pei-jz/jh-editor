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

const HISTORY_KEY = 'jh_ai_chat_history_v1';
const MAX_HISTORY = 40;

function renderMarkdown(md) {
    try {
        if (typeof marked !== 'undefined' && marked.parse) return marked.parse(md || '');
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
                <span class="ai-chat-header-title">🤖 AI Chat</span>
                <button class="clear-btn" title="Clear history">Clear</button>
                <button class="close-btn" title="Close">×</button>
            </div>
            <div class="ai-chat-messages"></div>
            <div class="ai-chat-hint">Connect to the J.H AI Agent to get answers. To include your selection as context, send it using the "Send Selection" button.</div>
            <div class="ai-chat-input-row">
                <textarea class="ai-chat-input" placeholder="Ask a question… (Shift+Enter for a new line)"></textarea>
                <button class="ai-chat-send">Send</button>
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

            try {
                const context = this._buildContext();
                const systemPrompt =
                    'You are an AI assistant inside JHEditor. Answer in the user\'s language (Japanese unless told otherwise). '
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
                    bodyEl.innerHTML = `❌ ${String(msg).replace(/&/g, '&amp;').replace(/</g, '&lt;')}`;
                }
            } finally {
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

        renderAll();
        input.focus();
    }

    _buildContext() {
        try {
            const view = window.app?.getCurrentView?.();
            const active = window.app?.getActiveFile?.();
            let selected = '';
            if (view && typeof view.getSelectedText === 'function') {
                try { selected = view.getSelectedText() || ''; } catch (_) {}
            }
            const file = active || null;
            return {
                app: 'jheditor',
                workspace: window.app?.getCurrentDir?.() || null,
                activeFile: file ? (file.path || file.name || null) : null,
                activeFileSnippet: file && typeof file.content === 'string'
                    ? file.content.slice(0, 4000)
                    : (file ? '' : null),
                selection: selected || null,
            };
        } catch (_) { return null; }
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
