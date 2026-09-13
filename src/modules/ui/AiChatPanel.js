/**
 * AiChatPanel.js — persistent AI chat sidebar (Phase 2).
 *
 * A side panel where the user chats with the J.H AI Agent. The user's selection
 * and active file are offered as context but not forced.
 *
 * ── Why this is an `ask` run and not a single_shot ────────────────────────
 * It used to go through AIAgent.runSingleShot, which sends ONE message and
 * nothing else: every turn arrived with no knowledge of the turns before it, so
 * "explain that last part" had nothing to point at, and the history this panel
 * kept was for display only. single_shot is the right shape for a one-way
 * transform (a commit message, a translation) and the wrong one for a
 * conversation.
 *
 * `interaction: 'ask'` is the shape the agent already has for this: the real
 * engine — memory, cost record, safety guards — with plan-first, the
 * task_progress checklist and delegation dropped, and its tools narrowed to
 * read-only. So the panel now carries its prior turns and talks to that.
 *
 * ── State and view are separate, deliberately ─────────────────────────────
 * The panel used to keep the answer in DOM nodes captured by the send closure:
 * `list`, `bodyEl`, and a `findAssistant()` that queried the list it had closed
 * over. Closing the panel removes those nodes, so a reply that arrived after —
 * or after a close and reopen — painted into a detached element and was never
 * seen. The reply was also never written back to storage: `saveHistory` ran
 * when the EMPTY assistant bubble was appended and not once the content
 * arrived, so the history on disk held the questions and none of the answers.
 *
 * So: `this._messages` is the only truth, every mutation goes through
 * `_update()` (which persists AND repaints if open), and the view is rebuilt
 * from that array on every open. A request in flight survives a close — it
 * keeps writing to the message object, and reopening shows it mid-answer.
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
/** How many prior Q&A pairs travel with a new question. */
const MAX_CONTEXT_TURNS = 6;

function escapeText(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(md) {
    try {
        // Model output is not trusted input: it lands in the main document, so
        // it goes through the same sanitiser as a Markdown file would.
        if (typeof marked !== 'undefined' && marked.parse) return sanitizeHtml(marked.parse(md || ''));
    } catch (_) { /* fall through */ }
    return `<pre style="white-space:pre-wrap;margin:0;">${escapeText(md)}</pre>`;
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

/** "1.4 s" / "820 ms" — the same shape the meta line used inline. */
function humanMs(ms) {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A heading for the "open as Markdown" draft, derived from the question. */
function draftTitleFor(question) {
    const stem = String(question || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
    return stem || 'AI answer';
}

class AiChatPanel {
    constructor() {
        this._root = null;
        this._messages = loadHistory();
        this._busy = false;
        // The request in flight, if any: { index, startedAt, sentLabel }. Kept
        // on the instance rather than in the send closure so a close/reopen can
        // pick the running timer back up instead of losing the answer.
        this._pending = null;
        this._ticker = null;
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

        const input = root.querySelector('.ai-chat-input');
        const send = root.querySelector('.ai-chat-send');

        root.querySelector('.close-btn').onclick = () => this.close();
        root.querySelector('.clear-btn').onclick = () => {
            // Clearing while a request is in flight would leave the pending
            // index pointing at a message that no longer exists.
            this._stopTicker();
            this._pending = null;
            this._messages = [];
            saveHistory(this._messages);
            this._render();
        };

        send.onclick = () => this._send();
        send.disabled = this._busy;
        input.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._send();
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

        this._render();
        // Reopening mid-request: pick the clock back up rather than freezing the
        // meta line at whatever it read when the panel was closed.
        if (this._pending) this._startTicker();
        input.focus();
    }

    // ── State ─────────────────────────────────────────────────────────────

    /** Append a message, persist, repaint. Returns its index. */
    _append(message) {
        this._messages.push(message);
        saveHistory(this._messages);
        this._render();
        return this._messages.length - 1;
    }

    /**
     * Merge `patch` into the message at `index`, persist, repaint just that one.
     *
     * Persisting on every update is the half that survives a restart; repainting
     * BY INDEX (rather than through a captured node) is the half that survives a
     * close and reopen.
     */
    _update(index, patch) {
        const m = this._messages[index];
        if (!m) return;
        Object.assign(m, patch);
        saveHistory(this._messages);
        this._paint(index);
    }

    // ── View ──────────────────────────────────────────────────────────────

    _list() { return this._root ? this._root.querySelector('.ai-chat-messages') : null; }

    _render() {
        const list = this._list();
        if (!list) return;
        list.innerHTML = '';
        this._messages.forEach((m, i) => list.appendChild(this._messageEl(m, i)));
        this._scrollToEnd();
    }

    /** Replace one message's node in place. No-op when the panel is closed. */
    _paint(index) {
        const list = this._list();
        if (!list) return;
        const existing = list.children[index];
        const fresh = this._messageEl(this._messages[index], index);
        if (existing) list.replaceChild(fresh, existing);
        else list.appendChild(fresh);
        this._scrollToEnd();
    }

    _scrollToEnd() {
        const list = this._list();
        if (list) list.scrollTop = list.scrollHeight;
    }

    _messageEl(m, index) {
        const el = document.createElement('div');
        el.className = 'ai-chat-msg ' + (m.role || 'assistant') + (m.error ? ' error' : '');

        const body = document.createElement('div');
        body.className = 'ai-chat-msg-body';
        if (m.role === 'assistant') {
            if (m.error) {
                body.innerHTML = `<span class="jh-icon-row">${svgIcon('x-circle', { size: 13 })}${escapeText(m.content)}</span>`;
            } else if (m.content) {
                body.innerHTML = renderMarkdown(m.content);
            } else {
                body.innerHTML = `<span class="ai-chat-typing">${escapeText(t('Sending…'))}</span>`;
            }
        } else {
            body.textContent = m.content;
        }
        el.appendChild(body);

        // An answer worth keeping is a document — and this is a Markdown editor,
        // so the honest "keep this" is a Markdown tab, not a copy button alone.
        if (m.role === 'assistant' && m.content && !m.error) {
            const actions = document.createElement('div');
            actions.className = 'ai-chat-msg-actions';

            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.title = t('Open this answer as a Markdown draft');
            openBtn.textContent = t('Open in editor');
            openBtn.onclick = () => this._openAsMarkdown(index);
            actions.appendChild(openBtn);

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.textContent = t('Copy');
            copyBtn.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(m.content);
                    copyBtn.textContent = t('Copied');
                    setTimeout(() => { copyBtn.textContent = t('Copy'); }, 1200);
                } catch (_) { /* clipboard denied — nothing useful to say */ }
            };
            actions.appendChild(copyBtn);

            el.appendChild(actions);
        }

        if (m.meta) {
            const meta = document.createElement('div');
            meta.className = 'ai-chat-meta';
            meta.textContent = m.meta;
            el.appendChild(meta);
        }
        return el;
    }

    /**
     * Open an answer as a full-size Markdown tab.
     *
     * A 380px sidebar is the wrong place to READ a thousand words of Markdown
     * with headings, code blocks and tables in it — and this app IS a Markdown
     * editor. `openMarkdownResult` is the same door SelectionActions and the MCP
     * bridge already use: a virtual `ai://….md` tab that opens in MarkdownView,
     * so the answer renders rather than being squeezed into a bubble.
     *
     * The question goes in as an H1 so the tab still says what it answers once
     * it has been saved somewhere with a name of its own.
     */
    _openAsMarkdown(index) {
        const answer = this._messages[index];
        if (!answer) return;
        // The nearest preceding user turn is the question this answers.
        let question = '';
        for (let i = index - 1; i >= 0; i--) {
            if (this._messages[i].role === 'user') { question = this._messages[i].content; break; }
        }
        const title = draftTitleFor(question);
        const doc = question ? `# ${title}\n\n${answer.content}\n` : `${answer.content}\n`;
        if (!window.app?.openMarkdownResult) {
            console.warn('openMarkdownResult is unavailable — cannot open the answer as Markdown.');
            return;
        }
        window.app.openMarkdownResult(title, doc);
    }

    // ── The request ───────────────────────────────────────────────────────

    _startTicker() {
        this._stopTicker();
        this._ticker = setInterval(() => this._paintPendingMeta(), 200);
        this._paintPendingMeta();
    }

    _stopTicker() {
        if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
    }

    /**
     * The live "⏳ Sending… 1.4 s" line, written into the message itself.
     *
     * An `ask` run has read-only tools, so it can take several turns — a
     * fifteen-second wait with nothing moving looks like a hang. `statusLabel`
     * carries whatever the run last said it was doing (a tool name, a status),
     * which is the difference between "it is reading a file" and "it is dead".
     */
    _paintPendingMeta(label = `⏳ ${t('Sending…')}`) {
        if (!this._pending) return;
        const { index, startedAt, sentLabel, statusLabel } = this._pending;
        const doing = statusLabel ? `  ·  ${statusLabel}` : '';
        this._update(index, {
            meta: `${label} ${humanMs(Date.now() - startedAt)}${doing}${sentLabel || ''}`,
        });
    }

    async _send() {
        const input = this._root ? this._root.querySelector('.ai-chat-input') : null;
        const text = input ? input.value.trim() : '';
        if (!text || this._busy) return;
        input.value = '';

        this._append({ role: 'user', content: text });
        const index = this._append({ role: 'assistant', content: '' });

        this._busy = true;
        this._setSendEnabled(false);
        this._pending = { index, startedAt: Date.now(), sentLabel: '' };
        this._startTicker();

        try {
            const { context, sent } = this._buildContext();
            const history = this._historyFor(index);
            if (history.length) sent.push(`${history.length} prior messages`);
            this._pending.sentLabel = sent.length
                ? `  ·  sent: ${sent.join(', ')}`
                : '  ·  sent: prompt only';
            // Appended to the agent's own prompt (never a replacement — see runAsk).
            const instructions = `Answer in ${promptLanguageName()}. Use Markdown. Be concise.`;
            // `stream` events carry DELTAS, not the running total — the agent
            // loop forwards whatever the provider emitted. Assigning each one
            // would leave the bubble showing the last few characters.
            let streamed = '';
            const answer = await AIAgent.runAsk({
                prompt: text,
                instructions,
                context,
                chatContext: history,
                onUpdate: (chunk) => {
                    streamed += chunk;
                    this._update(index, { content: streamed });
                },
                onStatus: (message) => {
                    if (this._pending) this._pending.statusLabel = String(message).slice(0, 60);
                },
            });
            // The completed task's content is the authoritative text: a run that
            // ends by calling present_result/finish_task delivers its answer
            // there rather than through the stream.
            if (answer && answer !== streamed) this._update(index, { content: answer });
        } catch (e) {
            this._update(index, { content: (e && e.message) || String(e), error: true });
        } finally {
            this._stopTicker();
            this._paintPendingMeta('⏱');
            this._pending = null;
            this._busy = false;
            this._setSendEnabled(true);
            const box = this._root ? this._root.querySelector('.ai-chat-input') : null;
            if (box) box.focus();
        }
    }

    /**
     * The turns before `index`, as the agent's `chatContext` shape.
     *
     * Complete pairs only, and errors excluded: a failed turn has no answer, so
     * sending its question again would read as the user repeating themselves.
     * Capped at the last few exchanges — the panel keeps 40 messages, and
     * shipping all of them on every send pays for the whole session each time.
     */
    _historyFor(index) {
        const turns = [];
        for (let i = 0; i < index; i++) {
            const m = this._messages[i];
            if (!m || m.error || !m.content) continue;
            turns.push({ role: m.role, content: m.content });
        }
        // Drop a trailing unanswered question so the history ends on an answer.
        if (turns.length && turns[turns.length - 1].role === 'user') turns.pop();
        return turns.slice(-MAX_CONTEXT_TURNS * 2);
    }

    _setSendEnabled(enabled) {
        const send = this._root ? this._root.querySelector('.ai-chat-send') : null;
        if (send) send.disabled = !enabled;
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
                // In the shape the agent renders: { path, content }. The old
                // `activeFile` (a path) + `activeFileSnippet` keys were read by
                // nothing on the agent side.
                const body = typeof active?.content === 'string' ? active.content : '';
                context.activeFile = { path: activePath, content: body.slice(0, 4000) };
                sent.push(context.activeFile.content.length >= 4000
                    ? 'active file (first 4000 chars)'
                    : `active file (${context.activeFile.content.length} chars)`);
            }
            // The workspace itself travels as the run's reach (runAsk), not as a
            // path in the context: a path can be revealing (a client's name), and
            // only a run that may read the workspace has any use for it.
            if (allows('workspaceFiles') && window.app?.getCurrentDir?.()) {
                sent.push('workspace (read access)');
            }
            if (isPrivate) sent.push('personal note excluded');

            return { context, sent };
        } catch (_) {
            return { context: null, sent: [] };
        }
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

    /**
     * Closing hides the view and nothing else. The request keeps running and
     * keeps writing into `this._messages`; reopening shows where it got to.
     */
    close() {
        this._stopTicker();
        if (this._root) {
            this._root.remove();
            this._root = null;
        }
    }
}

export const aiChatPanel = new AiChatPanel();
