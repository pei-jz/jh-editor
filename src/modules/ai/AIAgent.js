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
 * The public API (`run()` / `checkHealth()` / `agentController`) is preserved
 * so callers like InlineAI / ProjectsPanel work unchanged.
 */

import JhAiClient from '@jh/ai-client';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { State } from '../core/Store.js';
import { getConnectionConfig, isAgentReachable } from './ConnectionConfig.js';

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
        // Parse the host URL into host+port for the client constructor.
        let host = '127.0.0.1', port = 14300;
        try {
            const u = new URL(cfg.hostUrl);
            host = u.hostname || host;
            port = parseInt(u.port, 10) || port;
        } catch (_) { /* fall through with defaults */ }

        this._client = new JhAiClient({
            host,
            port,
            token: cfg.token,
            // Provide a readConfigFile that the client could also use; redundant
            // since we already discovered settings above, but harmless.
            readConfigFile: readTextFile,
        });
        return this._client;
    }

    /** Invalidate cached client (call after SettingsModal saves new URL/token). */
    refreshClient() {
        this._client = null;
    }

    /**
     * Submit an iterative-agent task. Same signature as before — callers (InlineAI,
     * ProjectsPanel, etc.) don't need to change. Internally now goes through
     * @jh/ai-client.invokeAgent which gives us streaming + approval plumbing
     * for free, and we send `behavior` as the proper object form so the Rust
     * server actually honors it.
     *
     * @returns {{ response: string, modifiedFiles: string[] }}
     */
    async run(
        prompt,
        onUpdate,
        onAgentStatus,
        onConfirm,
        editContext = null,
        chatContext = [],
        onLog = null,
        abortSignal = null,
        kisContext = '',
        images = []
    ) {
        onAgentStatus?.("Connecting to J.H AI Agent...");

        let client;
        try {
            client = await this._getClient();
        } catch (e) {
            throw new Error(
                `J.H AI Agent not reachable. ` +
                `Open J.H AI Agent → Settings → General → "Export Connection" and try again. ` +
                `(${e.message || e})`
            );
        }

        // Build a behavior object. iterative_agent is the default — JHEditor's
        // use cases (refactor / explain / generate) are heavy multi-step tasks.
        // System prompt is omitted so the server uses its full built-in heavy
        // prompt with anti-loop / verify_syntax / task_progress safety rules.
        const behavior = {
            mode: 'iterative_agent',
        };

        // Build a context object from whatever was passed in. Caller context
        // (edit context, chat history snippets, knowledge items) gets bundled
        // so it's reachable from the agent if needed.
        const context = {};
        if (editContext) context.editContext = editContext;
        if (Array.isArray(chatContext) && chatContext.length > 0) context.chatContext = chatContext;
        if (kisContext) context.knowledgeItems = kisContext;
        if (Array.isArray(images) && images.length > 0) context.images = images;

        // Use invokeAgent so we get streaming + abort + approval routing.
        const task = client.invokeAgent({
            prompt,
            behavior,
            context: Object.keys(context).length > 0 ? context : null,
            workspacePath: State.currentDir || null,
            caller: 'JHEditor',
            // Hook the progress callbacks into the existing onAgentStatus contract.
            onStep: (pkt) => {
                try {
                    if (pkt.event === 'stream' && pkt.data?.chunk) {
                        onUpdate?.(pkt.data.chunk);
                    } else if (pkt.event === 'status' && pkt.data?.message) {
                        onAgentStatus?.(pkt.data.message);
                    } else if (pkt.event === 'thought' && pkt.data?.text) {
                        const t = typeof pkt.data.text === 'string'
                            ? pkt.data.text
                            : JSON.stringify(pkt.data.text);
                        onAgentStatus?.(t);
                    } else if (pkt.event === 'tool_call' && pkt.data?.name) {
                        onAgentStatus?.(pkt.data.name);
                    } else if (pkt.event === 'file_modified' && pkt.data?.path) {
                        onAgentStatus?.(pkt.data.path);
                        // Auto-reload silently in the editor + refresh explorer
                        if (window.app?.reloadFileSilently) {
                            window.app.reloadFileSilently(pkt.data.path);
                        }
                        if (window.app?.refreshExplorer) {
                            window.app.refreshExplorer();
                        }
                    }
                } catch (e) {
                    console.warn('onStep handler error:', e);
                }
            },
            onConfirm,
            onLog,
        });

        // Wire up the caller's abort signal to actually abort the in-flight task.
        if (abortSignal) {
            abortSignal.addEventListener('abort', () => {
                try { task.abort(); } catch (_) {}
            }, { once: true });
        }

        try {
            const result = await task.completed;
            return {
                response: result.content || '',
                modifiedFiles: result.modifiedFiles || [],
            };
        } catch (e) {
            // Surface the error in the same shape callers used to see.
            throw new Error(`Agent Error: ${e.message || e}`);
        }
    }

    /**
     * Submit a lightweight single_shot task (no tools, no iteration). Useful
     * for "explain this code", "rename this symbol", etc. — anywhere JHEditor
     * wants a quick LLM answer without the full agent loop overhead.
     *
     * New public method. Existing call sites should keep using run() unless
     * they explicitly want single_shot semantics.
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
        });
        const result = abortSignal
            ? await Promise.race([invocation, abortedAfter(abortSignal)])
            : await invocation;
        // No streaming for invoke() — fire onUpdate once with the full content
        // so callers that wired up a streaming handler still see something.
        if (onUpdate && result.content) onUpdate(result.content);
        return result.content || '';
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
