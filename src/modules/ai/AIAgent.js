/**
 * AIAgent.js (External-Only Facade)
 *
 * All agent tasks are delegated to the standalone J.H AI Agent via REST & WebSocket.
 * Refactored to:
 *   1. Use @jh/ai-client under the hood (no more hand-rolled fetch + WebSocket).
 *   2. Use ConnectionConfig.js for auto-discovery (standard JH path → localStorage fallback).
 *   3. Send `behavior` as an OBJECT (the previous string form was silently dropped
 *      by the Rust server's AgentBehavior deserialization).
 *
 * Two ways to ask, matching the agent's lanes (jh-ai-agent RunLane.js):
 *   runSingleShot — transform: one round trip, no tools (commit messages,
 *                   selection actions, InlineAI)
 *   runAsk        — ask: a conversation, reaching this editor's tools, or the
 *                   workspace when the context scope allows it
 * Work (edits, a shell) is not started from here: openInAgent hands the text to
 * J.H AI Agent, where the workspace picker, plan approval and diff review are.
 */

import JhAiClient from '@jh/ai-client';
import { State } from '../core/Store.js';
import { getConnectionConfig, isAgentReachable } from './ConnectionConfig.js';
import { reachForScope } from './ContextScope.js';

/**
 * Show the pairing code while the user answers the agent's prompt.
 *
 * The code is a COMPARISON: the agent's dialog draws it, and so does this, and
 * the user checks that they match. Drawn here rather than in a modal on purpose
 * — a modal would steal focus from the window the user is about to switch away
 * from, and the thing they have to do is in the other app.
 *
 * @returns {function} teardown, called when the pairing settles either way.
 */
function showPairingNotice(code, expiresIn) {
    const el = document.createElement('div');
    el.className = 'jh-pairing-notice';
    el.setAttribute('role', 'status');
    el.innerHTML = `
        <div class="jh-pairing-title">J.H AI Agent への接続を承認してください</div>
        <div class="jh-pairing-code">${String(code).replace(/[^0-9]/g, '')}</div>
        <div class="jh-pairing-hint">
            エージェント側のダイアログに出ている番号がこれと同じか確認してから承認してください。
        </div>
    `;
    document.body.appendChild(el);

    // A safety net, not the real clock: the agent expires the request on its
    // own, and the client's teardown removes this. It exists so a notice cannot
    // be left on screen by a code path that forgot to settle.
    const timer = setTimeout(() => el.remove(), ((expiresIn || 120) + 5) * 1000);

    return () => { clearTimeout(timer); el.remove(); };
}

/** Rejects with an AbortError as soon as `signal` fires (never resolves). */
function abortedAfter(signal) {
    return new Promise((_, reject) => {
        const fail = () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
        };
        if (signal.aborted) return fail();
        signal.addEventListener('abort', fail, { once: true });
    });
}

class AIAgentFacade {

    constructor() {
        this.maxIterations = 15;
        this._client = null;
    }

    /**
     * Lazily build the @jh/ai-client instance against the currently-resolved
     * connection settings. Rebuilt whenever settings change (refreshClient()).
     */
    async _getClient() {
        if (this._client) return this._client;
        const cfg = await getConnectionConfig();

        this._client = new JhAiClient({
            host: cfg.host,
            port: cfg.port,
            // No token. The client pairs on first use and holds what it gets in
            // memory — see ConnectionConfig.js for what this replaced.
            appName: 'JHEditor',
            // Called when a pairing request goes out. The agent's prompt shows
            // the same six digits; this shows them here so the user has two
            // things to COMPARE rather than one to assume. Returns a teardown.
            onPairing: ({ code, expiresIn }) => showPairingNotice(code, expiresIn),
        });
        return this._client;
    }

    /** Invalidate cached client (call after SettingsModal saves new URL/token). */
    refreshClient() {
        this._client = null;
    }

    /**
     * The token this editor is currently paired with, pairing first if needed.
     *
     * ONE pairing for the whole application. The MCP bridge and the task
     * notification panel both talk to the agent directly — over a WebSocket and
     * over REST — and each used to read a token out of the connection file.
     * With the file gone they come here instead, so a user who approves
     * "JHEditor" approves it once rather than once per feature.
     *
     * Callers should re-read this rather than cache it: after the agent
     * restarts, the client re-pairs and the value changes.
     */
    async getAuthToken() {
        const client = await this._getClient();
        await client.ready();
        return client.token || '';
    }

    /**
     * Ask a question — a CONVERSATION, not a job and not a one-way transform.
     *
     * `interaction: 'ask'` is the agent's own second axis (the agent's
     * src/modules/ai/agent/InteractionMode.js): it drops plan-first, the
     * task_progress checklist, sub-agent delegation and phase routing, and
     * narrows the tool allowlist to read-only. The result is the real engine —
     * with its conversation memory, cost record and safety guards — behaving
     * like a chat rather than like a work order.
     *
     * Why this rather than runSingleShot: single_shot sends ONE message and
     * nothing else. The chat sidebar used it, so every turn arrived with no
     * knowledge of the turns before it and "explain that last part" had nothing
     * to point at. `chatContext` is the whole difference.
     *
     * @param {object}   o
     * @param {string}   o.prompt
     * @param {string}   [o.instructions]  appended to the agent's prompt — never a replacement
     * @param {object}   [o.context]       opaque caller metadata (NOT history)
     * @param {Array}    [o.chatContext]   prior turns, [{role, content}, …]
     * @param {function} [o.onUpdate]      streamed chunks
     * @param {function} [o.onStatus]      tool calls / thoughts, for a status line
     * @param {AbortSignal} [o.abortSignal]
     * @returns {Promise<string>} the answer text
     */
    async runAsk({
        prompt,
        instructions = null,
        context = null,
        chatContext = [],
        onUpdate = null,
        onStatus = null,
        abortSignal = null,
    }) {
        // First AI use of the session: check the agent is there, start it or
        // point at the download page if not. Deliberately NOT at startup.
        const { ensureAgentAvailable, ensureMcpServer } = await import('./AgentConnection.js');
        if (!(await ensureAgentAvailable())) {
            throw new Error('J.H AI Agent is not running.');
        }
        // The `ask` run's tools reach the editor over this MCP bridge.
        await ensureMcpServer();

        const client = await this._getClient();
        // What the run may touch follows the context-scope setting. This used
        // to send the current directory whatever the setting said, and an `ask`
        // run with a workspace can read all of it — a "selection only" chat
        // read the whole jh-editor tree.
        const reach = reachForScope();
        const behavior = {
            mode: 'iterative_agent',
            shape: 'ask',
            reach,
            // This editor's own MCP server — the tools that apply the scope.
            mcp_servers: ['jheditor'],
        };
        // Appended to the agent's prompt. A `system_prompt` REPLACED it, and the
        // built prompt is where the context sent with a message is rendered — so
        // the selection never reached the model.
        if (instructions) behavior.extra_instructions = instructions;

        const task = client.invokeAgent({
            prompt,
            behavior,
            context,
            chatContext: Array.isArray(chatContext) ? chatContext : [],
            // Only when the scope reaches the workspace. The agent ignores a path
            // on any other lane anyway; not sending it keeps that true here too.
            workspacePath: reach === 'workspace' ? (State.currentDir || null) : null,
            caller: 'JHEditor',
            onStep: (pkt) => {
                try {
                    if (pkt.event === 'stream' && pkt.data?.chunk) onUpdate?.(pkt.data.chunk);
                    else if (pkt.event === 'status' && pkt.data?.message) onStatus?.(pkt.data.message);
                    else if (pkt.event === 'tool_call' && pkt.data?.name) onStatus?.(pkt.data.name);
                } catch (e) {
                    console.warn('runAsk onStep handler error:', e);
                }
            },
        });

        if (abortSignal) {
            abortSignal.addEventListener('abort', () => {
                try { task.abort(); } catch (_) { /* already settled */ }
            }, { once: true });
        }

        const result = await task.completed;
        return result.content || '';
    }

    /**
     * Submit a lightweight single_shot task (no tools, no iteration, NO HISTORY).
     *
     * For a DETERMINISTIC ONE-WAY TRANSFORM — a commit message, a summary, a
     * translation, "give me this as JSON". One round trip is the contract, which
     * is what makes its latency and cost predictable; that is the reason to pick
     * it over `runAsk`, which may take several turns because it has tools.
     *
     * Do NOT use it for a conversation: it carries no prior turns. Use runAsk.
     *
     * @returns {string} the generated response text
     */
    async runSingleShot({
        prompt,
        systemPrompt,
        responseFormat = 'text',
        context = null,
        onUpdate = null,
        abortSignal = null,
    }) {
        // First AI use of the session: check the agent is there, start it or
        // point at the download page if not. Deliberately NOT at startup.
        const { ensureAgentAvailable } = await import('./AgentConnection.js');
        if (!(await ensureAgentAvailable())) {
            throw new Error('J.H AI Agent is not running.');
        }

        const client = await this._getClient();
        const behavior = {
            mode: 'single_shot',
            system_prompt: systemPrompt,
            response_format: responseFormat,
        };
        // @jh/ai-client.invoke returns { content, taskId } directly.
        // It has no signal parameter, so honour the caller's by racing it: the
        // task may still finish server-side, but the caller stops waiting and —
        // more to the point — stops acting on a result it no longer wants.
        // Without this, `abortSignal` was accepted and silently ignored, so a
        // superseded inline-completion request still came back and painted.
        const invocation = client.invoke({
            prompt,
            behavior,
            context,
            caller: 'JHEditor',
            // Deltas, as they arrive.
            onChunk: onUpdate || null,
        });
        const result = abortSignal
            ? await Promise.race([invocation, abortedAfter(abortSignal)])
            : await invocation;
        return result.content || '';
    }

    /**
     * Open J.H AI Agent with this request typed into its composer — not started.
     * @returns {Promise<boolean>}
     */
    async openInAgent({ prompt = '', workspace = null } = {}) {
        const { ensureAgentAvailable } = await import('./AgentConnection.js');
        if (!(await ensureAgentAvailable())) return false;
        const client = await this._getClient();
        return client.compose({ prompt, workspace });
    }

    /**
     * Check if the external agent is reachable. Preserved for back-compat with
     * existing callers; just delegates to ConnectionConfig.isAgentReachable.
     */
    async checkHealth() {
        return isAgentReachable(2000);
    }
}

// Expose agentController as null (retired) for any legacy references
AIAgentFacade.prototype.agentController = null;

export default new AIAgentFacade();
