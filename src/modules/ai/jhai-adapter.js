// jhai-adapter — client SDK for the JHAI "AI Hub" (Part B).
//
// An app (JHEditor/JHER/JHWBSManager) imports this, declares its TOOLS / INTENTS
// / CONTEXT / RESULT renderers, and calls start(). The SDK:
//   • dials JHAI's `ws://<jhai>/mcp/ws?app=<name>&token=…` (outbound; connection
//     = dynamic registration) and acts as the MCP SERVER over it — answering
//     initialize / tools/list / tools/call from registered handlers.
//   • runIntent()/chat() create a task (POST /api/tasks) scoped to this app and
//     subscribe to the task WS, dispatching the final `result` envelope to the
//     registered renderer (and exposing apply-actions).
//
// Transport is hidden (Part A / T1 outbound WS). Dependency-free: uses standard
// WebSocket + fetch (injectable for tests). MCP semantics throughout.
//
// Vendored from jh-ai-agent/sdk/jhai-adapter.js — keep in sync with the canonical
// SDK (tested in jh-ai-agent/sdk/__tests__). See the design docs there:
// docs/design/ai-hub-client-adapter-sdk.md.

export function createJhaiAdapter(options = {}) {
    return new JhaiAdapter(options);
}

function httpToWs(url) {
    return url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

class JhaiAdapter {
    /**
     * @param {object} opts
     * @param {string} opts.app           server name (scopes behavior.mcp_servers)
     * @param {string} opts.jhaiBaseUrl   e.g. "http://127.0.0.1:8123"
     * @param {string} opts.authToken     JHAI connection token (shared secret)
     * @param {function} [opts.WebSocketImpl]  WebSocket ctor (default globalThis.WebSocket)
     * @param {function} [opts.fetchImpl]      fetch fn (default globalThis.fetch)
     * @param {object}   [opts.serverInfo]     { name, version }
     */
    constructor(opts) {
        if (!opts.app) throw new Error('createJhaiAdapter: `app` is required');
        if (!opts.jhaiBaseUrl) throw new Error('createJhaiAdapter: `jhaiBaseUrl` is required');
        this.app = opts.app;
        // Optional per-process id so a hub can distinguish several clients that
        // share the same `app` name (multiple JHEditor windows). Sent as an extra
        // WS query param; ignored by hubs that don't use it.
        this.instanceId = opts.instanceId || '';
        this.baseUrl = opts.jhaiBaseUrl.replace(/\/+$/, '');
        this.token = opts.authToken || '';
        this._WS = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
        this._fetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
        this.serverInfo = opts.serverInfo || { name: opts.app, version: '0.1.0' };
        this.protocolVersion = '2024-11-05';

        this.tools = new Map();          // name → { def, handler }
        this.contextProvider = null;

        this._ws = null;
        this._stopped = false;
        // Reconnect backoff: start at 5s and ramp up to 3 minutes so a stopped
        // MCP server isn't hammered (and doesn't flood the console) — a check
        // roughly every few minutes is plenty.
        this._reconnectMs = 5000;
        this._reconnectMinMs = 5000;
        this._reconnectMaxMs = 180000;
        this._loggedError = false; // log the connection error only once per down-streak
        this.onLog = null;
    }

    // ── Declarations ────────────────────────────────────────────────────────

    /** Register a tool. handler(args, ctx) → string | { content:[{type:'text',text}] }. */
    registerTool({ name, description = '', inputSchema, handler }) {
        if (!name || typeof handler !== 'function') {
            throw new Error('registerTool requires { name, handler }');
        }
        const schema = inputSchema || { type: 'object', properties: {}, required: [], additionalProperties: false };
        this.tools.set(name, { def: { name, description, inputSchema: schema }, handler });
        return this;
    }

    /** Provide live context (e.g. () => ({ app, windowId, documentId })). */
    setContextProvider(fn) { this.contextProvider = fn; return this; }

    // ── Connection (MCP server role over outbound WS) ────────────────────────

    async start() {
        if (!this._WS) throw new Error('No WebSocket implementation available');
        this._stopped = false;
        this._connect();
        return this;
    }

    stop() {
        this._stopped = true;
        if (this._ws) { try { this._ws.close(); } catch (_) {} this._ws = null; }
    }

    _wsUrl() {
        const base = httpToWs(this.baseUrl);
        let q = `app=${encodeURIComponent(this.app)}&token=${encodeURIComponent(this.token)}`;
        if (this.instanceId) q += `&instance=${encodeURIComponent(this.instanceId)}`;
        return `${base}/mcp/ws?${q}`;
    }

    _connect() {
        const ws = new this._WS(this._wsUrl());
        this._ws = ws;
        ws.onmessage = (ev) => this._onFrame(typeof ev.data === 'string' ? ev.data : String(ev.data));
        ws.onclose = () => {
            this._ws = null;
            if (!this._stopped) {
                const delay = this._reconnectMs;
                this._reconnectMs = Math.min(this._reconnectMs * 2, this._reconnectMaxMs);
                setTimeout(() => { if (!this._stopped) this._connect(); }, delay);
            }
        };
        ws.onopen = () => {
            this._reconnectMs = this._reconnectMinMs;
            this._loggedError = false;
            this._log(`MCP WS connected as "${this.app}"`);
        };
        // Log the error only once while the server stays down, to avoid flooding
        // the console (the browser still prints its own native connection error).
        ws.onerror = (e) => {
            if (this._loggedError) return;
            this._loggedError = true;
            this._log(`MCP WS error: ${e && e.message ? e.message : e}`);
        };
    }

    _send(obj) {
        if (this._ws && this._ws.readyState === 1) {
            this._ws.send(JSON.stringify(obj));
        }
    }

    /** Handle one inbound JSON-RPC frame (JHAI = MCP client). */
    async _onFrame(text) {
        let msg;
        try { msg = JSON.parse(String(text).trim()); } catch { return; }
        if (!msg || msg.jsonrpc !== '2.0') return;

        // Notifications (no id) — ignore (e.g. notifications/initialized).
        if (msg.id === undefined || msg.id === null) return;

        try {
            const result = await this._handleRpc(msg.method, msg.params || {});
            this._send({ jsonrpc: '2.0', id: msg.id, result });
        } catch (e) {
            this._send({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32000, message: e && e.message ? e.message : String(e) },
            });
        }
    }

    async _handleRpc(method, params) {
        switch (method) {
            case 'initialize':
                return {
                    protocolVersion: this.protocolVersion,
                    capabilities: { tools: {} },
                    serverInfo: this.serverInfo,
                };
            case 'tools/list':
                return { tools: [...this.tools.values()].map(t => t.def) };
            case 'tools/call': {
                const entry = this.tools.get(params.name);
                if (!entry) throw new Error(`Unknown tool: ${params.name}`);
                const ctx = (params._meta && params._meta.jhai) ? params._meta.jhai : {};
                const out = await entry.handler(params.arguments || {}, ctx);
                return this._normalizeToolResult(out);
            }
            default:
                throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
        }
    }

    _normalizeToolResult(out) {
        if (out && typeof out === 'object' && Array.isArray(out.content)) return out;
        const text = typeof out === 'string' ? out : JSON.stringify(out ?? null);
        return { content: [{ type: 'text', text }] };
    }

    // Starting tasks (runIntent / chat) and rendering their result envelopes were
    // removed with named intents (jh-ai-agent Report_20260913 §6-6). This copy
    // is now only the MCP server role: JHEditor's tools, answered over the WS.

    _log(m) { if (this.onLog) this.onLog(`[jhai-adapter] ${m}`); }
}
