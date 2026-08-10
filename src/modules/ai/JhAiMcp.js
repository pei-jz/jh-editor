/**
 * JhAiMcp.js — JHEditor ↔ JHAI "AI Hub" integration (MCP, Part B).
 *
 * This is the REVERSE direction of AIAgent.js. AIAgent.js drives JHAI as a task
 * runner (JHEditor → JHAI → LLM, the LLM using JHAI's own tools). Here JHEditor
 * acts as an MCP **server** over an OUTBOUND WebSocket to JHAI: it exposes its
 * OWN capabilities (the live editor buffer/selection/open files) as TOOLS that
 * JHAI's LLM can call, plus named INTENTS (recipes) that return a structured
 * `result` rendered back in the editor.
 *
 * Wiring (see jh-ai-agent/sdk/jhai-adapter.js + the design docs):
 *   • Connection = dialing `ws://<jhai>/mcp/ws?app=jheditor&token=…` (the
 *     connection itself is the dynamic registration; no inbound listener).
 *   • Tools:   get_buffer / get_selection / list_open_files
 *   • Intent:  summarize_logs → markdown result with an "insert into doc" action.
 *
 * Non-fatal: if JHAI is unreachable, the SDK retries the WS in the background and
 * runIntent() simply rejects until a connection is up. Nothing here blocks the
 * editor from starting.
 */

import { createJhaiAdapter } from './jhai-adapter.js';
import { getConnectionConfig } from './ConnectionConfig.js';
import { State } from '../core/Store.js';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { activityPanel } from './JhAiActivityPanel.js';

// Unique per-process id so the AI-Hub can tell multiple JHEditor instances
// apart (all register as app="jheditor"). Sent on the MCP WS query and in the
// live context; a hub that doesn't use it simply ignores it.
const INSTANCE_ID = (() => {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return `jheditor-${crypto.randomUUID()}`;
    } catch (_) { /* fall through */ }
    return `jheditor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
})();

// ── Workspace-scoped file read (guards against path traversal) ───────────────
function collapsePath(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/');
    const out = [];
    for (const seg of parts) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { out.pop(); continue; }
        out.push(seg);
    }
    const lead = /^[a-zA-Z]:$/.test(parts[0]) ? '' : (String(path).startsWith('/') ? '/' : '');
    return lead + out.join('/');
}

async function readWorkspaceFile(p) {
    const root = collapsePath((State.currentDir || '.').replace(/\\/g, '/'));
    let target = String(p || '').replace(/\\/g, '/');
    const isAbs = /^([a-zA-Z]:\/|\/)/.test(target);
    if (!isAbs) target = `${State.currentDir}/${target}`;
    const norm = collapsePath(target);
    // Must stay inside the workspace root (case-insensitive for Windows).
    if (!norm.toLowerCase().startsWith(root.toLowerCase())) {
        throw new Error('Access denied: path is outside the current workspace.');
    }
    return await readTextFile(norm);
}

// ── Editor bridge: map the SDK's abstract editor calls onto JHEditor state ────
// We go through window.app (set up by Editor.js) for the live view so this module
// has no import cycle with the editor core.

const editor = {
    /** Path (or name) of the document in the active tab, or null. */
    activeDocumentId() {
        const f = State.openFiles[State.activeTabIndex];
        return f ? (f.path || f.name || null) : null;
    },

    /** Full text of a document. Prefers the LIVE view value for the active tab. */
    getText(docId) {
        const view = window.app && typeof window.app.getCurrentView === 'function'
            ? window.app.getCurrentView() : null;
        const active = State.openFiles[State.activeTabIndex];
        if (active && (!docId || active.path === docId || active.name === docId)) {
            if (view && view.textarea) return view.textarea.value;
            return active.content || '';
        }
        const f = State.openFiles.find(x => x.path === docId || x.name === docId);
        return f ? (f.content || '') : '';
    },

    /** Currently selected text in the active view (empty string if none). */
    getSelection() {
        const view = window.app && typeof window.app.getCurrentView === 'function'
            ? window.app.getCurrentView() : null;
        if (!view) return '';
        // CodeMirror view exposes the selection directly (no textarea).
        if (typeof view.getSelectedText === 'function') {
            try { return view.getSelectedText() || ''; } catch (_) { return ''; }
        }
        const ta = view.textarea;
        if (!ta) return '';
        try {
            return ta.value.slice(ta.selectionStart, ta.selectionEnd) || '';
        } catch (_) {
            return '';
        }
    },

    /** Insert text at the cursor in the active view. */
    insertAtCursor(text) {
        const view = window.app && typeof window.app.getCurrentView === 'function'
            ? window.app.getCurrentView() : null;
        if (view && typeof view.insertTextAtCursor === 'function') {
            view.insertTextAtCursor(text);
            return true;
        }
        // Fallback: append to the active file's content and reload it silently.
        const active = State.openFiles[State.activeTabIndex];
        if (active) {
            active.content = (active.content || '') + '\n' + text;
            active.isDirty = true;
            if (window.app && typeof window.app.reloadFileSilently === 'function') {
                window.app.reloadFileSilently(active.path, active.content);
            }
            return true;
        }
        return false;
    },
};

// ── Task dispatch (routes through the bottom-right activity dock) ─────────────

let _adapter = null;

/** Map a streaming task event to a short human status line (or null to ignore). */
function statusTextFromEvent(event, data) {
    if (event === 'status' && data.message) return String(data.message);
    if (event === 'tool_call' && data.name) return `🛠 ${data.name}`;
    if (event === 'thought') {
        const t = typeof data.text === 'string' ? data.text : '';
        if (t) return t.replace(/\s+/g, ' ').slice(0, 90);
    }
    return null;
}

/**
 * Start a JHAI task (registered intent) and surface it in the activity dock with
 * live status + Stop, rendering the result there. Returns the adapter handle
 * ({ taskId, completed, abort }); callers may also await handle.completed to show
 * the result inline as well.
 */
function startJhaiTask({ intentId, prompt, context, title, onEvent, resultHandler }) {
    const ai = _adapter;
    if (!ai) throw new Error('JHAI MCP adapter not available.');
    const entry = activityPanel.addTask(title || intentId || 'AI');
    const combined = (event, data) => {
        const s = statusTextFromEvent(event, data);
        if (s) entry.setStatus(s);
        if (event === 'thought' && data.text) {
            entry._lastThought = data.text;
        }
        if (onEvent) { try { onEvent(event, data); } catch (_) {} }
    };
    const handle = ai.runIntentTask(intentId, { prompt, context, onEvent: combined });
    entry.onAbort(() => handle.abort());
    handle.completed
        .then((env) => (resultHandler ? resultHandler(env, entry) : presentJhaiResult(env, entry)))
        .catch((e) => entry.setError(e && e.message ? e.message : String(e)));
    return handle;
}

/**
 * Present a result envelope by its `kind`:
 *   - markdown / table / file-list → open a full-size Markdown editor tab
 *   - code-edit                    → open a diff tab (DiffEditor) for review/apply
 *   - answer                       → short text inline in the dock card
 * The dock card stays compact (summary + 開く/挿入/コピー) regardless.
 */
function presentJhaiResult(env, entry) {
    const ai = _adapter;
    const kind = (env && env.kind) || 'markdown';
    const p = (env && env.payload) || {};
    const actions = (env && env.actions) || [];
    const onAction = (a) => { try { ai && ai.applyAction(a); } catch (_) {} };

    if (kind === 'code-edit') {
        const open = () => openCodeEditDiff(p);
        const ok = open();
        entry.setResult({
            summary: ok ? '🔀 Opened a diff tab — review, then apply' : 'code-edit: could not show the diff',
            onOpen: ok ? open : null, actions, onAction,
        });
        return;
    }

    if (kind === 'answer') {
        const text = p.text || p.answer || (env && env.summary) || '(empty answer)';
        entry.setResult({
            summary: text,
            onInsert: () => editor.insertAtCursor(text),
            copyText: text, actions, onAction,
        });
        return;
    }

    // markdown / table / file-list / default → full-size Markdown editor tab.
    let md = p.md || p.markdown || (env && env.summary) || '';
    if (!md && kind === 'file-list' && Array.isArray(p.files)) {
        md = '## Files\n' + p.files.map((f) => `- \`${f.path || f}\``).join('\n');
    }
    
    // Fallback: if md is empty or generic, but the LLM outputted a substantial thought, use the thought
    if ((!md || md === 'Task completed successfully' || md === '(no result)') && entry._lastThought && entry._lastThought.length > 5) {
        md = entry._lastThought;
    }

    if (!md) md = '(no result)';
    const title = p.title || (env && env.summary ? String(env.summary).slice(0, 30) : 'AI Result');
    const open = () => { try { window.app.openMarkdownResult(title, md); } catch (e) { console.warn(e); } };
    open(); // auto-open in an editor tab
    entry.setResult({
        summary: `📄 Opened "${title}" in an editor tab`,
        onOpen: open,
        onInsert: () => editor.insertAtCursor(md),
        copyText: md, actions, onAction,
    });
}

/** Open a code-edit envelope in JHEditor's DiffEditor. Returns true if shown. */
function openCodeEditDiff(p) {
    try {
        const edits = Array.isArray(p.edits) ? p.edits : (Array.isArray(p) ? p : []);
        const first = edits[0] || p || {};
        const original = first.original ?? first.old ?? first.before ?? p.original ?? '';
        const modified = first.modified ?? first.new ?? first.after ?? first.text ?? p.modified ?? '';
        const path = first.path || first.file || p.path || 'ai-edit';
        if (modified == null || modified === '') return false;
        window.app.openDiffEditor(String(original), String(modified), path, (finalText) => {
            // Apply: insert the reviewed text at the cursor (file-write is Phase 2).
            try { editor.insertAtCursor(finalText); } catch (_) {}
        });
        return true;
    } catch (_) {
        return false;
    }
}

// ── Public init ───────────────────────────────────────────────────────────────

/**
 * Build, register, and connect the JHEditor MCP adapter. Idempotent: returns the
 * existing adapter if already initialized. Returns null if no connection config.
 */
export async function initJhEditorMcp() {
    if (_adapter) return _adapter;

    let cfg;
    try {
        cfg = await getConnectionConfig();
    } catch (_) {
        return null;
    }
    if (!cfg || !cfg.hostUrl) return null;

    const ai = createJhaiAdapter({
        app: 'jheditor',
        instanceId: INSTANCE_ID,
        jhaiBaseUrl: cfg.hostUrl,
        authToken: cfg.token || '',
    });
    // Always surface connection-level logs (connect / disconnect / error) to the
    // console so a failed /mcp/ws registration is easy to spot in JHEditor's
    // devtools; gate only the chattier debug lines behind the detailed-logs flag.
    ai.onLog = (m) => {
        if (/connected|error|disconnect/i.test(m) || State.aiShowDetailedLogs) {
            console.log(m);
        }
    };

    // 1) Tools — JHEditor's live capabilities exposed to JHAI's LLM.
    ai.registerTool({
        name: 'get_buffer',
        description: 'Returns the full text (plain text) of the document currently being edited in JHEditor.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async (_args, ctx) => {
            const docId = ctx.documentId || editor.activeDocumentId();
            return { content: [{ type: 'text', text: editor.getText(docId) }] };
        },
    });

    ai.registerTool({
        name: 'get_selection',
        description: 'Returns the currently selected text in the editor (returns an empty string if no selection).',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async () => ({ content: [{ type: 'text', text: editor.getSelection() }] }),
    });

    ai.registerTool({
        name: 'list_open_files',
        description: 'Returns a list of currently open tabs (files) in JSON format.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async () => {
            const list = State.openFiles.map((f, i) => ({
                path: f.path || f.name || null,
                isDirty: !!f.isDirty,
                active: i === State.activeTabIndex,
            }));
            return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
        },
    });

    ai.registerTool({
        name: 'read_workspace_file',
        description: 'Reads and returns the specified file in the current workspace as UTF-8 text. Relative paths are based on the workspace root.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Relative path from the workspace root, or an absolute path' } },
            required: ['path'],
            additionalProperties: false,
        },
        handler: async (args) => {
            try {
                const text = await readWorkspaceFile(args && args.path);
                return { content: [{ type: 'text', text }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `ERROR: ${e && e.message ? e.message : String(e)}` }], isError: true };
            }
        },
    });

    ai.registerTool({
        name: 'list_workspace_files',
        description: 'Lists files in the current workspace (respecting .gitignore) as relative paths from the workspace root. Use this to discover files before reading them with read_workspace_file.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async () => {
            const root = collapsePath(String(State.currentDir || '').replace(/\\/g, '/'));
            if (!/^([a-zA-Z]:\/|\/)/.test(root)) {
                return { content: [{ type: 'text', text: 'ERROR: No workspace folder is open.' }], isError: true };
            }
            try {
                const entries = await invoke('list_all_files', { dir: State.currentDir });
                const rootLc = root.toLowerCase();
                const rels = (entries || [])
                    .filter(e => !e.is_directory)
                    .map(e => {
                        let p = collapsePath(String(e.path).replace(/\\/g, '/'));
                        if (p.toLowerCase().startsWith(rootLc)) p = p.slice(root.length).replace(/^\//, '');
                        return p;
                    })
                    .slice(0, 2000);
                return { content: [{ type: 'text', text: rels.join('\n') || '(empty)' }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `ERROR: ${e && e.message ? e.message : String(e)}` }], isError: true };
            }
        },
    });

    ai.registerTool({
        name: 'get_diagnostics',
        description: 'Returns lint / syntax error diagnostics for the current editor (active view) as a JSON array.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async () => {
            let diags = [];
            try {
                if (window.app && typeof window.app.getDiagnostics === 'function') {
                    diags = window.app.getDiagnostics() || [];
                }
            } catch (_) { /* none */ }
            return { content: [{ type: 'text', text: JSON.stringify(diags, null, 2) }] };
        },
    });

    // 2) Intents — named AI actions. `scope` ('selection' | 'document') drives
    //    which intents the InlineAI popup offers (selected text vs whole doc).
    ai.registerIntent({
        id: 'summarize_logs',
        title: 'Summarize logs',
        scope: 'document',
        tier: 'fast',
        systemPrompt:
            'You are an assistant that summarizes logs for the currently edited document.\n' +
            'First, use get_buffer to retrieve the content, then aggregate the count, time periods, categories, etc., ' +
            'and summarize the results in a readable Markdown table.\n\n' +
            'HOW TO RETURN RESULTS (STRICTLY ENFORCED):\n' +
            '- You MUST return the result by calling the present_result tool with kind="markdown" ' +
            'and put the full text of your deliverable into the `markdown` argument. ' +
            'Do not write the result in the message body.',
        tools: ['get_buffer'],
        resultKind: 'markdown',
    });

    ai.registerIntent({
        id: 'explain_selection',
        title: 'Explain selection',
        scope: 'selection',
        tier: 'fast',
        systemPrompt:
            'You are a code/text explanation assistant.\n' +
            'First, use get_selection to get the selected text, and briefly explain in Japanese what it does, ' +
            'key points, and caveats using Markdown. If the selection is empty, use get_buffer to look at the whole document and provide an overview.\n\n' +
            'HOW TO RETURN RESULTS (STRICTLY ENFORCED):\n' +
            '- You MUST return the result by calling the present_result tool with kind="markdown" ' +
            'and put the full text of your deliverable into the `markdown` argument. ' +
            'Do not write the result in the message body.',
        tools: ['get_selection', 'get_buffer'],
        resultKind: 'markdown',
    });

    // Freeform — the user types ANY instruction; the LLM picks the tools itself.
    // This is the "no fixed buttons, just free input" path: all read tools are
    // exposed and the model decides what to fetch and do.
    ai.registerIntent({
        id: 'freeform',
        title: 'Free prompt',
        tier: 'fast',
        systemPrompt:
            'You are an AI assistant integrated into JHEditor.\n' +
            'A workspace folder may be open (see context.workspaceRoot / workspaceOpen). When it is, you can ' +
            'explore it with list_workspace_files and read files with read_workspace_file (paths are relative to the workspace root).\n' +
            'Read the user\'s instructions and, if necessary, call get_selection / get_buffer / ' +
            'read_workspace_file / list_workspace_files / get_diagnostics / list_open_files to retrieve information, ' +
            'then execute the instructions.\n\n' +
            'HOW TO RETURN RESULTS (STRICTLY ENFORCED):\n' +
            '- You MUST return the result by calling the present_result tool. This is the ONLY way to pass the result to the app. ' +
            'Writing text in the message body, using ``` code blocks directly, or outputting strings like "CALL: present_result" ' +
            'will NOT deliver the result (it will be empty).\n' +
            '- Call present_result with kind="markdown" and put the full text of your deliverable into the `markdown` argument. ' +
            'The argument name is exactly `markdown` (do not use content, text, or md).\n' +
            '- Code modification/generation: Put the full revised code into a single ```language fenced code block ' +
            'and pass it in the `markdown` argument so it can be inserted (do NOT return it as body text).\n' +
            '- Explanation/Summary/Analysis: Pass readable Markdown (in Japanese) in the `markdown` argument.\n' +
            '- Call present_result FIRST, and then call finish_task with a short one-line summary. ' +
            'Do not skip present_result. Do not put the result only in the finish_task summary.\n' +
            '- Thought notes such as OBSERVE / PLAN are for internal use and are not the deliverable itself.',
        tools: ['get_selection', 'get_buffer', 'read_workspace_file', 'list_workspace_files', 'get_diagnostics', 'list_open_files'],
        resultKind: 'markdown',
    });

    // 3) Live context — the target document AND the open workspace, so the agent
    //    knows the project root and can use the workspace file tools.
    ai.setContextProvider(() => {
        const dir = String(State.currentDir || '').replace(/\\/g, '/');
        const isWorkspace = /^([a-zA-Z]:\/|\/)/.test(dir); // an absolute folder is open
        return {
            app: 'jheditor',
            instanceId: INSTANCE_ID,
            documentId: editor.activeDocumentId(),
            workspaceRoot: isWorkspace ? collapsePath(dir) : null,
            workspaceOpen: isWorkspace,
        };
    });

    // 4) Apply-action handler. Results themselves are shown in the activity dock
    //    (see startJhaiTask); this lets a present_result action insert text.
    ai.registerActionHandler('insertMarkdown', (apply) => {
        editor.insertAtCursor(apply.text || '');
    });

    ai.registerActionHandler('applyEdit', (apply) => {
        const ok = openCodeEditDiff(apply);
        if (!ok) {
            // Fallback: If DiffEditor cannot be opened, try to insert the modified text directly
            const modified = apply.modified ?? apply.new ?? apply.after ?? apply.text ?? '';
            if (modified) {
                editor.insertAtCursor(String(modified));
            } else {
                console.warn('[JhAiMcp] applyEdit failed: no modified text found in payload', apply);
            }
        }
    });

    ai.registerActionHandler('openFile', (apply) => {
        const p = apply.file || apply.path;
        if (p && window.app && typeof window.app.openFile === 'function') {
            window.app.openFile(p);
        } else {
            console.warn('[JhAiMcp] openFile failed: invalid path or window.app.openFile not found', apply);
        }
    });

    // 5) Connect (outbound WS = registration). Non-fatal on failure.
    try {
        await ai.start();
    } catch (e) {
        console.warn('JHAI MCP connect failed:', e);
    }

    _adapter = ai;
    return ai;
}

/**
 * Wait until the adapter's outbound WS is OPEN (so JHEditor is registered as an
 * MCP server on JHAI) before creating a task — otherwise the task's LLM may run
 * before get_buffer is registered and report it as "not available". Best-effort:
 * resolves true once open, or false after the timeout.
 */
async function waitForConnection(ai, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (ai._ws && ai._ws.readyState === 1) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return !!(ai._ws && ai._ws.readyState === 1);
}

/**
 * Run a registered intent. Surfaces in the activity dock (live status + Stop +
 * result) AND resolves with the final result envelope so callers (e.g. InlineAI)
 * can render it inline too. `onEvent(event, data)` streams progress.
 */
export async function runJhaiIntent(intentId, prompt, { onEvent } = {}) {
    const ai = await initJhEditorMcp();
    if (!ai) throw new Error('JHAI MCP adapter not available (no connection config).');
    const connected = await waitForConnection(ai);
    if (!connected) {
        console.warn('[JhAiMcp] WS not connected — JHAI may not see the tools. Is J.H AI Agent running?');
    }
    const it = ai.intents.get(intentId);
    const title = (it && (it.title || it.id)) || prompt || intentId;
    return startJhaiTask({ intentId, prompt, title, onEvent }).completed;
}

/**
 * Freeform: run the user's natural-language instruction with all JHEditor tools
 * exposed; the LLM decides which tools to call. `contextText` (e.g. the code
 * around the cursor) is appended to the prompt. Resolves with the result envelope.
 */
export async function runJhaiFreeform(prompt, contextText, { onEvent } = {}) {
    const ai = await initJhEditorMcp();
    if (!ai) throw new Error('JHAI MCP adapter not available (no connection config).');
    const connected = await waitForConnection(ai);
    if (!connected) {
        console.warn('[JhAiMcp] WS not connected — JHAI may not see the tools. Is J.H AI Agent running?');
    }
    const userPrompt = contextText
        ? `${prompt}\n\n--- 対象/カーソル周辺のコンテキスト ---\n${contextText}`
        : prompt;
    return startJhaiTask({ intentId: 'freeform', prompt: userPrompt, title: prompt, onEvent }).completed;
}

// ── Inline preset transforms (selection → proposal → Diff review → apply) ────
// The Editor AI stays a "co-author at the cursor": it reads the selection +
// surrounding context, and returns a PROPOSAL that the user reviews as a Diff and
// applies back to where it came from. It never writes to disk (that's JHAIAgent).

const INLINE_PRESETS = {
    explain: {
        title: 'Explain',
        // 'doc' → the result opens as a read-only Markdown tab (not written into
        // the buffer, not a diff). The AI explanation is reference material.
        mode: 'doc',
        instruction: '次の選択コード/テキストが何をしているかを、日本語で分かりやすく説明してください。コードは書き換えないでください。',
    },
    refactor: {
        title: 'Refactor',
        mode: 'replace',
        instruction: '次の選択コードを、外部から見た振る舞いを変えずにリファクタリング（可読性・命名・重複除去・早期return等）してください。周辺の既存コードのスタイル・変数・関数に合わせること。',
    },
    add_types: {
        title: 'Add Types',
        mode: 'replace',
        instruction: '次の選択コードに型注釈（TypeScript等）や JSDoc を付与してください。ロジックは変えないこと。周辺の型・命名に合わせること。',
    },
    add_error: {
        title: 'Error Handling',
        mode: 'replace',
        instruction: '次の選択コードに適切なエラー処理（try/catch・null/境界チェック等）を追加してください。既存の振る舞いは保ちつつ堅牢にすること。',
    },
    nl_to_code: {
        title: 'To Code',
        mode: 'replace',
        instruction: '次の選択（自然言語の箇条書き/擬似コード）を、現在のファイルの言語で動作するコードに変換してください。周辺の既存の変数・関数・import・スタイルを利用すること。',
    },
};

function _extractCodeBlock(md) {
    if (!md) return '';
    const m = String(md).match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
    return m ? m[1].replace(/\n$/, '') : '';
}

// Apply an accepted proposal back to the file/selection it came from.
async function _applyInlineAnchor(anchor, newText) {
    try {
        if (anchor.path && window.app && typeof window.app.openFile === 'function') {
            await window.app.openFile(anchor.path); // focus the source tab (no-op if active)
        }
        const view = window.app && typeof window.app.getCurrentView === 'function'
            ? window.app.getCurrentView() : null;
        if (view && typeof view.applyEditAtRange === 'function') {
            view.applyEditAtRange(anchor.from, anchor.to, anchor.original, newText);
            return;
        }
        editor.insertAtCursor(newText);
    } catch (e) {
        console.warn('[JhAiMcp] apply inline anchor failed:', e);
    }
}

function _presentPresetResult(env, entry, anchor) {
    const p = (env && env.payload) || {};
    let md = p.md || p.markdown || p.text || (env && env.summary) || '';

    if (anchor.mode === 'doc' || anchor.mode === 'answer') {
        // Explanation → open as a read-only Markdown tab (reference material, not
        // written into the buffer). Fall back to the captured thought if the final
        // envelope came back empty (some models double-emit present_result).
        if ((!md || !md.trim()) && entry && entry._lastThought && entry._lastThought.length > 5) {
            md = entry._lastThought;
        }
        if (!md || !md.trim()) {
            entry.setResult({ summary: 'Could not get an explanation from the AI' });
            return;
        }
        const base = anchor.path ? String(anchor.path).split(/[\\/]/).pop() : '';
        const title = base ? `AI explanation: ${base}` : 'AI explanation';
        const openTab = () => {
            try { window.app.openMarkdownResult(title, md); }
            catch (e) { console.warn('[JhAiMcp] openMarkdownResult failed:', e); }
        };
        openTab(); // auto-open in an editor tab
        entry.setResult({
            summary: `📄 Opened "${title}" in an editor tab`,
            onOpen: openTab,
            copyText: md,
        });
        return;
    }

    // Replace-style presets: extract the code and offer a Diff (original ↔ proposal).
    const code = _extractCodeBlock(md) || md;
    if (!code || !code.trim()) {
        entry.setResult({ summary: 'Could not get a suggestion from the AI', copyText: md });
        return;
    }
    const open = () => {
        window.app.openDiffEditor(
            String(anchor.original || ''),
            String(code),
            anchor.path || 'ai-proposal',
            (finalText) => _applyInlineAnchor(anchor, finalText) // Apply & Save → write back to source
        );
    };
    // Don't steal focus: just surface a "レビュー" action in the dock chip.
    entry.setResult({
        summary: '🔀 AI suggestion diff — review, then apply',
        onOpen: open,
        copyText: code,
    });
}

/**
 * Run an inline preset transform on the current selection. Async → the task goes
 * to the activity dock (the editor stays usable); on completion the dock chip
 * offers a Diff to review/apply. `preset` is a key of INLINE_PRESETS.
 */
export async function runInlinePreset(preset, { onEvent } = {}) {
    const def = INLINE_PRESETS[preset];
    if (!def) throw new Error(`Unknown preset: ${preset}`);
    const ai = await initJhEditorMcp();
    if (!ai) throw new Error('JHAI MCP adapter not available (no connection config).');
    await waitForConnection(ai);

    const selection = editor.getSelection();
    const view = window.app && typeof window.app.getCurrentView === 'function'
        ? window.app.getCurrentView() : null;
    const offsets = view && typeof view.getSelectionOffsets === 'function' ? view.getSelectionOffsets() : null;
    const anchor = {
        path: editor.activeDocumentId(),
        original: selection,
        from: offsets ? offsets.from : null,
        to: offsets ? offsets.to : null,
        mode: def.mode,
    };

    let formatRule = '';
    if (def.mode === 'replace') {
        formatRule = '返答は present_result(kind="markdown") を1回だけ呼び、変換後の全文を1つの ```コードブロック``` のみで `markdown` 引数に入れて返してください（説明文は不要）。\n\n';
    } else if (def.mode === 'doc') {
        formatRule = '返答は present_result(kind="markdown") を1回だけ呼び、説明の全文を `markdown` 引数に入れて返してください。answer など他の kind や、空の present_result を追加で呼ばないでください。\n\n';
    }
    const prompt =
        `${def.instruction}\n\n` +
        formatRule +
        `--- 選択 ---\n${selection || '(選択なし)'}\n`;

    return startJhaiTask({
        intentId: 'freeform',
        prompt,
        title: def.title,
        onEvent,
        resultHandler: (env, e) => _presentPresetResult(env, e, anchor),
    }).completed;
}

export function listInlinePresets() {
    return Object.keys(INLINE_PRESETS).map(k => ({ id: k, title: INLINE_PRESETS[k].title, mode: INLINE_PRESETS[k].mode }));
}

/** Ensure the adapter is initialized and its WS is open. Resolves true/false. */
export async function ensureJhaiConnected(timeoutMs = 1500) {
    const ai = await initJhEditorMcp();
    if (!ai) return false;
    return waitForConnection(ai, timeoutMs);
}

/** List registered intents as [{ id, title, scope }] (for building UI like InlineAI buttons). */
export async function listJhaiIntents() {
    const ai = await initJhEditorMcp();
    if (!ai) return [];
    return [...ai.intents.values()]
        .filter((it) => it.id !== 'freeform') // freeform is driven by the text input, not a button
        .map((it) => ({ id: it.id, title: it.title || it.id, scope: it.scope || null }));
}

/** Whether the active editor currently has a non-empty text selection. */
export function hasEditorSelection() {
    return (editor.getSelection() || '').trim().length > 0;
}

export { editor as jhEditorBridge };
