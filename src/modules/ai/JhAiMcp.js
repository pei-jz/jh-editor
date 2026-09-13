/**
 * JhAiMcp.js — JHEditor ↔ JHAI "AI Hub" integration (MCP, Part B).
 *
 * This is the REVERSE direction of AIAgent.js. AIAgent.js asks JHAI for answers.
 * Here JHEditor acts as an MCP **server** over an OUTBOUND WebSocket to JHAI: it
 * exposes its OWN capabilities (the live editor buffer/selection/open files) as
 * TOOLS that a run on the `ask × app` lane can call — gated by the context scope.
 *
 * Named intents and the tasks started through this adapter were removed
 * (jh-ai-agent docs/scratch/Report_20260913.md §6-6). The inline presets below
 * are one-shot transforms through AIAgent.
 *
 * Wiring (see jh-ai-agent/sdk/jhai-adapter.js + the design docs):
 *   • Connection = dialing `ws://<jhai>/mcp/ws?app=jheditor&token=…` (the
 *     connection itself is the dynamic registration; no inbound listener).
 *   • Tools:   get_buffer / get_selection / list_open_files / read_workspace_file /
 *              list_workspace_files / get_diagnostics
 *
 * Non-fatal: if JHAI is unreachable, the SDK retries the WS in the background and
 * runIntent() simply rejects until a connection is up. Nothing here blocks the
 * editor from starting.
 */

import { createJhaiAdapter } from './jhai-adapter.js';
import { getConnectionConfig } from './ConnectionConfig.js';
import AIAgent from './AIAgent.js';
import { State } from '../core/Store.js';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { activityPanel } from './JhAiActivityPanel.js';
import { allows, refusal, isPrivatePath } from './ContextScope.js';
import { promptLanguageName } from '../utils/I18n.js';

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

/**
 * True when `child` is the root itself or sits under it.
 *
 * A bare `startsWith` treats `C:/work/proj-secret` as inside `C:/work/proj`,
 * because the comparison does not know where a path segment ends.
 */
export function isInside(root, child) {
    const r = String(root || '').replace(/\/+$/, '').toLowerCase();
    const c = String(child || '').toLowerCase();
    if (!r) return false;
    return c === r || c.startsWith(r + '/');
}

async function readWorkspaceFile(p) {
    const root = collapsePath((State.currentDir || '.').replace(/\\/g, '/'));
    let target = String(p || '').replace(/\\/g, '/');
    const isAbs = /^([a-zA-Z]:\/|\/)/.test(target);
    if (!isAbs) target = `${State.currentDir}/${target}`;
    const norm = collapsePath(target);
    // Must stay inside the workspace root (case-insensitive for Windows).
    if (!isInside(root, norm)) {
        throw new Error('Access denied: path is outside the current workspace.');
    }
    // Belt and braces: a workspace could itself contain a notes directory.
    if (isPrivatePath(norm)) {
        throw new Error('Access denied: that path is private to the user.');
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

let _adapter = null;

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
        // The token the editor paired with, not one read out of a file —
        // see AIAgent.getAuthToken for why it comes from there.
        authToken: await AIAgent.getAuthToken(),
    });
    // Always surface connection-level logs (connect / disconnect / error) to the
    // console so a failed /mcp/ws registration is easy to spot in JHEditor's
    // devtools; gate only the chattier debug lines behind the detailed-logs flag.
    ai.onLog = (m) => {
        if (/connected|error|disconnect/i.test(m) || State.aiShowDetailedLogs) {
            console.log(m);
        }
    };

    // The MCP envelope for a refusal. `isError` is what makes the model treat it
    // as an answer rather than a transport failure it should retry.
    const denied = (capability, toolName) =>
        ({ content: [{ type: 'text', text: refusal(capability, toolName) }], isError: true });

    // 1) Tools — JHEditor's live capabilities exposed to JHAI's LLM.
    //
    // Every one of these is a PULL: the model calls it whenever it likes, with
    // no prompt to the user. What it can reach is therefore capped by the
    // context scope (Settings → AI), and personal notes are excluded outright.
    ai.registerTool({
        name: 'get_buffer',
        description: 'Returns the full text (plain text) of the document currently being edited in JHEditor.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async (_args, ctx) => {
            const active = editor.activeDocumentId();
            const docId = ctx.documentId || active;
            // Reading a BACKGROUND tab is a wider ask than reading the one the
            // user is looking at, and is priced accordingly.
            const capability = (!docId || docId === active) ? 'activeBuffer' : 'openFiles';
            if (!allows(capability)) return denied(capability, 'get_buffer');
            if (isPrivatePath(docId)) {
                return { content: [{ type: 'text', text:
                    "Refused: that document is one of the user's personal notes, "
                    + "which are never shared with a model. Ask the user to paste "
                    + "anything from it they want you to see." }], isError: true };
            }
            return { content: [{ type: 'text', text: editor.getText(docId) }] };
        },
    });

    ai.registerTool({
        name: 'get_selection',
        description: 'Returns the currently selected text in the editor (returns an empty string if no selection).',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async () => {
            // The narrowest scope still allows this: the user selected the text,
            // which is as close to asking as an editor gets.
            if (!allows('selection')) return denied('selection', 'get_selection');
            if (isPrivatePath(editor.activeDocumentId())) {
                return { content: [{ type: 'text', text: '' }] };
            }
            return { content: [{ type: 'text', text: editor.getSelection() }] };
        },
    });

    ai.registerTool({
        name: 'list_open_files',
        description: 'Returns a list of currently open tabs (files) in JSON format.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        handler: async () => {
            if (!allows('openFiles')) return denied('openFiles', 'list_open_files');
            const list = State.openFiles
                .map((f, i) => ({
                    path: f.path || f.name || null,
                    isDirty: !!f.isDirty,
                    active: i === State.activeTabIndex,
                }))
                // A note's FILENAME is itself personal (it is a date, and its
                // presence says the user keeps a journal), so the tab is not
                // listed at all rather than listed and refused.
                .filter((e) => !isPrivatePath(e.path));
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
            if (!allows('workspaceFiles')) return denied('workspaceFiles', 'read_workspace_file');
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
            if (!allows('workspaceFiles')) return denied('workspaceFiles', 'list_workspace_files');

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
            if (!allows('diagnostics')) return denied('diagnostics', 'get_diagnostics');

            let diags = [];
            try {
                if (window.app && typeof window.app.getDiagnostics === 'function') {
                    diags = window.app.getDiagnostics() || [];
                }
            } catch (_) { /* none */ }
            return { content: [{ type: 'text', text: JSON.stringify(diags, null, 2) }] };
        },
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
        instruction: '次の選択コード/テキストが何をしているかを説明してください。コードは書き換えないでください。',
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

/** Format rule for an inline preset, in the configured UI language. */
function _presetFormatRule(mode) {
    const lang = promptLanguageName();
    const rules = {
        replace: {
            en: 'Reply with the full transformed text as a single ```code block``` only — no explanation.\n\n',
            ja: '変換後の全文を1つの ```コードブロック``` のみで返してください（説明文は不要）。\n\n',
            zh: '请仅以一个 ```代码块``` 返回转换后的全文（不要说明文字）。\n\n',
            ko: '변환된 전체 텍스트를 하나의 ```코드 블록```으로만 반환하세요(설명 없음).\n\n',
        },
        doc: {
            en: 'Reply with the full explanation in Markdown.\n\n',
            ja: '説明の全文を Markdown で返してください。\n\n',
            zh: '请用 Markdown 返回完整说明。\n\n',
            ko: '설명 전체를 Markdown으로 반환하세요.\n\n',
        },
    };
    return rules[mode]?.[lang] || rules[mode]?.en || '';
}

/** The "--- selection ---" separator in the prompt, in the configured language. */
function _presetSelectionLabel() {
    const lang = promptLanguageName();
    return {
        en: '--- selection ---',
        ja: '--- 選択 ---',
        zh: '--- 选择 ---',
        ko: '--- 선택 ---',
    }[lang] || '--- selection ---';
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

function _presentPresetResult(text, entry, anchor) {
    let md = String(text || '');

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
            summary: `Opened "${title}" in an editor tab`,
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
        summary: 'AI suggestion diff — review, then apply',
        onOpen: open,
        copyText: code,
    });
}

/**
 * Run an inline preset transform on the current selection. Async → the task goes
 * to the activity dock (the editor stays usable); on completion the dock chip
 * offers a Diff to review/apply. `preset` is a key of INLINE_PRESETS.
 */
export async function runInlinePreset(preset) {
    const def = INLINE_PRESETS[preset];
    if (!def) throw new Error(`Unknown preset: ${preset}`);

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

    const entry = activityPanel.addTask(def.title);
    // Personal notes never travel, at any scope — the MCP tools refuse them, and
    // a preset that pushes the selection has to refuse them too.
    if (isPrivatePath(anchor.path)) {
        entry.setError("That document is one of your personal notes, which are never sent to a model.");
        return null;
    }

    // One round trip (lane L1). This was a "freeform" agent task driven through
    // the MCP adapter, which then had to be told, at length, to deliver its
    // answer through present_result rather than as text.
    const prompt =
        `${def.instruction}\n\n` +
        _presetFormatRule(def.mode) +
        `${_presetSelectionLabel()}\n${selection || '(選択なし)'}\n`;

    const ac = new AbortController();
    entry.onAbort(() => ac.abort());
    entry.setStatus('Generating…');
    try {
        const text = await AIAgent.runSingleShot({
            prompt,
            systemPrompt: `You are a code and writing assistant inside JHEditor. Answer in ${promptLanguageName()}.`,
            abortSignal: ac.signal,
        });
        _presentPresetResult(text, entry, anchor);
        return text;
    } catch (e) {
        if (e && e.name === 'AbortError') return null;
        entry.setError(e && e.message ? e.message : String(e));
        return null;
    }
}

export function listInlinePresets() {
    return Object.keys(INLINE_PRESETS).map(k => ({ id: k, title: INLINE_PRESETS[k].title, mode: INLINE_PRESETS[k].mode }));
}

/** Whether the active editor currently has a non-empty text selection. */
export function hasEditorSelection() {
    return (editor.getSelection() || '').trim().length > 0;
}

export { editor as jhEditorBridge };
