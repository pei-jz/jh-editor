import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    SCOPES, getScope, setScope, scopeInfo, allows, refusal, isPrivatePath,
} from '../src/modules/ai/ContextScope.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/* The MCP tools JHEditor publishes are PULL tools: the model decides when to
   call them and the editor never asks the user first. How far they reach is
   therefore a setting, and the safe end is where the default belongs. */
describe('AI context scope', () => {
    beforeEach(() => { localStorage.clear(); });

    it('defaults to the narrowest level', () => {
        expect(getScope()).toBe('selection');
        expect(scopeInfo().rank).toBe(1);
    });

    it('falls back to the narrowest on a value it does not recognise', () => {
        localStorage.setItem('settings_aiContextScope', 'everything');
        expect(getScope()).toBe('selection');
        expect(setScope('everything')).toBe(false);
    });

    it('widens one capability at a time', () => {
        const at = (id) => { setScope(id); return SCOPES.find((s) => s.id === id).rank; };

        at('selection');
        expect(allows('selection')).toBe(true);
        for (const c of ['activeBuffer', 'diagnostics', 'cursorContext', 'openFiles', 'workspaceFiles']) {
            expect(allows(c), c).toBe(false);
        }

        at('active');
        expect(allows('activeBuffer')).toBe(true);
        expect(allows('cursorContext')).toBe(true);
        expect(allows('openFiles')).toBe(false);
        expect(allows('workspaceFiles')).toBe(false);

        at('open');
        expect(allows('openFiles')).toBe(true);
        expect(allows('workspaceFiles')).toBe(false);

        at('workspace');
        expect(allows('workspaceFiles')).toBe(true);
    });

    // An unknown capability is a programming error; the safe answer to a
    // question we do not understand is no.
    it('denies a capability it has never heard of, at any scope', () => {
        setScope('workspace');
        expect(allows('readEmail')).toBe(false);
    });

    // Without "the user decides", a model reads a refusal as a transient failure
    // and calls the same tool again.
    it('tells the model not to retry and who can change it', () => {
        setScope('selection');
        const text = refusal('workspaceFiles', 'read_workspace_file');
        expect(text).toContain('read_workspace_file');
        expect(text).toContain('Whole workspace');
        expect(text).toContain('Selection only');
        expect(text).toMatch(/do not retry/i);
        expect(text).toMatch(/user/i);
    });
});

/* Personal notes are excluded by PATH, not by scope. A memo is where people
   write things they would never paste into a chat, and a daily note opens as an
   ordinary tab — which put it straight in front of get_buffer. */
describe('private paths', () => {
    it('covers both note stores and the agent scratch dir', () => {
        expect(isPrivatePath('C:/Users/x/AppData/Roaming/JHEditor/notes/daily/2026-08-25.md')).toBe(true);
        expect(isPrivatePath('C:\\Users\\x\\AppData\\Roaming\\JHEditor\\notes\\daily\\2026-08-25.md')).toBe(true);
        expect(isPrivatePath('/home/x/.config/JHEditor/notes/scratch.md')).toBe(true);
        expect(isPrivatePath('C:/proj/.agent/trace/metrics.jsonl')).toBe(true);
    });

    it('leaves ordinary project files alone', () => {
        for (const p of ['C:/proj/src/app.js', '/home/x/proj/README.md', '', null]) {
            expect(isPrivatePath(p), String(p)).toBe(false);
        }
    });

    // "notes" as a project directory is a different thing from the app's own.
    it('does not swallow a project folder that happens to be called notes', () => {
        expect(isPrivatePath('C:/proj/notes/design.md')).toBe(false);
    });
});

describe('the tools enforce it', () => {
    const mcp = read('src/modules/ai/JhAiMcp.js');

    it('gates every tool that leaves the editor', () => {
        // get_buffer's capability is decided at runtime (active vs background
        // tab), so it is the one checked with a variable rather than a literal.
        const gate = {
            get_selection: "allows('selection')",
            get_buffer: 'allows(capability)',
            list_open_files: "allows('openFiles')",
            read_workspace_file: "allows('workspaceFiles')",
            list_workspace_files: "allows('workspaceFiles')",
            get_diagnostics: "allows('diagnostics')",
        };
        for (const [tool, call] of Object.entries(gate)) {
            const i = mcp.indexOf(`name: '${tool}'`);
            expect(i, tool).toBeGreaterThan(-1);
            const block = mcp.slice(i, mcp.indexOf('});', i));
            expect(block, tool).toContain(call);
        }
    });

    it('charges a background tab more than the one in front of the user', () => {
        const i = mcp.indexOf("name: 'get_buffer'");
        const block = mcp.slice(i, mcp.indexOf('});', i));
        expect(block).toContain("? 'activeBuffer' : 'openFiles'");
    });

    it('hides a note tab from the listing rather than listing and refusing it', () => {
        const i = mcp.indexOf("name: 'list_open_files'");
        const block = mcp.slice(i, mcp.indexOf('});', i));
        expect(block).toContain('.filter((e) => !isPrivatePath(e.path))');
    });

    it('withholds a note path from the live context too', () => {
        expect(mcp).toContain('isPrivatePath(editor.activeDocumentId())');
    });

    // Pressing the inline-AI key must not quietly widen what "Selection only"
    // means: the ±20 lines are file content.
    it('only attaches the surrounding lines when the scope allows the file', () => {
        const cm = read('src/modules/views/CodeMirrorView.js');
        const i = cm.indexOf('_handleInlineAI() {');
        const fn = cm.slice(i, cm.indexOf('this.inlineAI.show(', i));
        expect(fn).toContain("allows('cursorContext')");
        expect(fn).toContain('getSelectedText');
    });
});

/* `C:/work/proj-secret` is not inside `C:/work/proj`, but a bare startsWith
   cannot tell, because it does not know where a path segment ends. */
describe('workspace containment', () => {
    it('will not accept a sibling whose name merely starts the same', async () => {
        vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));
        vi.doMock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn(async () => '') }));
        const { isInside } = await import('../src/modules/ai/JhAiMcp.js');

        expect(isInside('C:/work/proj', 'C:/work/proj/src/a.js')).toBe(true);
        expect(isInside('C:/work/proj', 'C:/work/proj')).toBe(true);
        expect(isInside('C:/work/proj', 'C:/WORK/PROJ/src/a.js')).toBe(true);
        expect(isInside('C:/work/proj', 'C:/work/proj-secret/.env')).toBe(false);
        expect(isInside('C:/work/proj/', 'C:/work/proj-secret/.env')).toBe(false);
        expect(isInside('', 'C:/anything')).toBe(false);
    });
});

/* The patterns above are a guess at the app config directory, and the guess is
   wrong on at least one platform. The owner of the directory knows better. */
describe('registered private directories', () => {
    it('takes the real notes path over the guess', async () => {
        const { registerPrivateDir, isPrivatePath: isPriv } =
            await import('../src/modules/ai/ContextScope.js');

        const odd = '/home/x/.config/com.jh.editor/notes';
        expect(isPriv(`${odd}/inbox.md`)).toBe(false);   // no pattern matches it
        registerPrivateDir(odd);
        expect(isPriv(`${odd}/inbox.md`)).toBe(true);
        expect(isPriv(odd)).toBe(true);
        // A sibling that merely starts the same is still not inside it.
        expect(isPriv('/home/x/.config/com.jh.editor/notes-backup/inbox.md')).toBe(false);
    });

    it('is registered by whoever resolves it', () => {
        const dn = read('src/modules/utils/DailyNotes.js');
        expect(dn).toContain('registerPrivateDir(notesRoot)');
        // The ROOT, not just today's folder — quick exports and future note
        // kinds land beside it.
        expect(dn).toMatch(/const notesRoot = .*\/notes`/);
    });
});

/* The chat sidebar PUSHES context rather than waiting to be asked, and it did so
   with no reference to the scope at all: the workspace path, the active file's
   path and its first 4000 characters went with every single message. The panel's
   own hint told the user the opposite — that the selection was sent only via a
   button. */
describe('the AI chat sidebar', () => {
    const panel = read('src/modules/ui/AiChatPanel.js');
    const ctx = () => {
        const i = panel.indexOf('_buildContext() {');
        return panel.slice(i, panel.indexOf('\n    _attachResizer(', i));
    };

    it('asks the scope before attaching anything', () => {
        const fn = ctx();
        expect(fn).toContain("allows('selection')");
        expect(fn).toContain("allows('activeBuffer')");
        // The workspace PATH only means something to a model that may read the
        // workspace, and a path can name a client.
        expect(fn).toContain("allows('workspaceFiles')");
        expect(fn).toContain('isPrivatePath(activePath)');
    });

    it('no longer attaches the file unconditionally', () => {
        expect(panel).not.toMatch(/activeFileSnippet: file && typeof file\.content/);
    });

    // A privacy setting whose effect nobody can see is not worth much.
    it('reports what it actually sent, and how long it took', () => {
        expect(ctx()).toContain('return { context, sent }');
        const i = panel.indexOf('async _send() {');
        const send = panel.slice(i, panel.indexOf('\n    _setSendEnabled(', i));
        expect(send).toContain('_startTicker()');
        expect(send).toContain('_stopTicker()');
        expect(panel).toContain("ms < 1000 ? `${ms} ms`");
        expect(send).toContain('sent: ');
    });

    it('states the live scope instead of a sentence that was never true', () => {
        expect(panel).not.toContain('Send Selection');
        expect(panel).toContain('Context scope: ');
    });
});

/* The answer used to live in DOM nodes the send closure had captured. Closing
   the panel removed them, so a reply that arrived afterwards painted into a
   detached element and was gone; and `saveHistory` ran when the EMPTY assistant
   bubble was appended rather than when the content arrived, so the stored
   history held every question and no answers. Both halves are pinned here. */
describe('an answer survives the panel being closed', () => {
    const panel = read('src/modules/ui/AiChatPanel.js');

    it('routes every content change through a method that persists it', () => {
        const i = panel.indexOf('_update(index, patch) {');
        const fn = panel.slice(i, panel.indexOf('\n    _list()', i));
        expect(fn).toContain('saveHistory(this._messages)');
        expect(fn).toContain('this._paint(index)');
    });

    it('paints by index rather than through a captured node', () => {
        // The shape that broke: a query bound to the list the closure had.
        expect(panel).not.toContain(".ai-chat-msg.assistant:last-child");
        expect(panel).toContain('list.children[index]');
        // Closed panel → state still updates, painting is simply skipped.
        expect(panel).toMatch(/_paint\(index\) \{\s*\n\s*const list = this\._list\(\);\s*\n\s*if \(!list\) return;/);
    });

    it('keeps the in-flight request on the instance so a reopen can resume it', () => {
        expect(panel).toContain('this._pending = { index, startedAt');
        expect(panel).toContain('if (this._pending) this._startTicker();');
    });

    it('closing tears down the view and nothing else', () => {
        const i = panel.indexOf('    close() {');
        const fn = panel.slice(i);
        expect(fn).toContain('this._stopTicker()');
        // No abort, no message loss — the request keeps writing to state.
        expect(fn).not.toContain('this._messages = []');
    });
});

/* A rendered Markdown answer inside a bubble with `white-space: pre-wrap` gets a
   visible blank line for every newline in the generated HTML, and unstyled
   headings render at the browser default (h1 = 2em) inside a 380px sidebar. */
describe('the chat answer reads as Markdown', () => {
    const css = read('src/styles/features.css');

    it('does not pre-wrap an assistant turn', () => {
        const rule = css.slice(
            css.indexOf('.ai-chat-msg.assistant {'),
            css.indexOf('}', css.indexOf('.ai-chat-msg.assistant {')),
        );
        expect(rule).not.toContain('pre-wrap');
        // The user turn is plain text and still needs it.
        expect(css).toMatch(/\.ai-chat-msg\.user \{[^}]*white-space: pre-wrap/);
    });

    it('sizes headings for a sidebar', () => {
        expect(css).toContain('.ai-chat-msg-body h1 { font-size: 15px; }');
        expect(css).toContain('.ai-chat-msg-body ul,');
    });

    it('offers the answer as a Markdown draft', () => {
        const panel = read('src/modules/ui/AiChatPanel.js');
        // The same door SelectionActions uses: a virtual ai://….md tab that
        // opens in MarkdownView, so the answer RENDERS at full width.
        expect(panel).toContain('window.app.openMarkdownResult(title, doc)');
        expect(panel).toContain('Open in editor');
    });
});

/* A conversation served by single_shot has no memory: `invoke()` sends the one
   prompt and nothing else, so every turn of the sidebar arrived knowing nothing
   about the turns before it. `interaction: 'ask'` is the shape the agent already
   has for a conversation — the real engine, with plan-first, the task_progress
   checklist and delegation dropped, and its tools narrowed to read-only. */
describe('the chat sidebar is an ask run, not a single shot', () => {
    const panel = read('src/modules/ui/AiChatPanel.js');
    const agent = read('src/modules/ai/AIAgent.js');
    const client = read('../jh-ai-agent/packages/jh-ai-client/index.js');

    it('sends the conversation through runAsk with its prior turns', () => {
        expect(panel).toContain('AIAgent.runAsk({');
        expect(panel).toContain('chatContext: history');
        expect(panel).not.toContain('AIAgent.runSingleShot({');
    });

    it('accumulates the stream instead of assigning each delta', () => {
        // `stream` events are deltas; assigning one would leave the bubble
        // showing the last few characters of the answer.
        expect(panel).toContain('streamed += chunk');
    });

    it('sends complete pairs only, ending on an answer', () => {
        const i = panel.indexOf('_historyFor(index) {');
        const fn = panel.slice(i, panel.indexOf('\n    _setSendEnabled(', i));
        expect(fn).toContain('if (!m || m.error || !m.content) continue;');
        expect(fn).toContain("turns[turns.length - 1].role === 'user'");
        expect(fn).toContain('MAX_CONTEXT_TURNS');
    });

    it('marks the run as a question rather than a job', () => {
        const i = agent.indexOf('async runAsk({');
        const fn = agent.slice(i, agent.indexOf('Submit a lightweight single_shot', i));
        expect(fn).toContain("shape: 'ask'");
        expect(fn).toContain("mode: 'iterative_agent'");
        expect(fn).toContain('const reach = reachForScope();');
        expect(fn).toContain("mcp_servers: ['jheditor']");
        // A system_prompt REPLACED the agent's prompt, and with it the place the
        // selection is rendered. Instructions are appended instead.
        expect(fn).not.toContain('behavior.system_prompt');
        expect(fn).toContain('behavior.extra_instructions = instructions');
    });

    /* History used to be buried in `context`, which TaskBridge hands to the
       agent as `clientContext` — a different argument from the agent's own
       `chatContext` parameter. So it arrived as caller metadata and the run had
       no memory of its earlier turns, with no error anywhere to say so. */
    it('carries history in the field the whole chain is built around', () => {
        expect(client).toContain('chat_context: Array.isArray(chatContext)');
        expect(agent).toContain('chatContext: Array.isArray(chatContext) ? chatContext : []');
        expect(agent).not.toContain('context.chatContext = chatContext');
    });
});

/* jh-ai-agent Report_20260913. A "selection only" chat read the whole jh-editor
   tree: runAsk sent the current directory whatever the scope said, and the
   agent gave an `ask` run with a workspace every read tool. The scope now
   decides the reach, and the agent enforces it. */
describe('the context scope decides what an agent run may touch', async () => {
    const { reachForScope, setScope } = await import('../src/modules/ai/ContextScope.js');
    const agent = read('src/modules/ai/AIAgent.js');

    it.each(['selection', 'active', 'open'])('%s reaches only this editor', (scope) => {
        expect(reachForScope(scope)).toBe('app');
    });

    it('only whole workspace reaches the workspace', () => {
        expect(reachForScope('workspace')).toBe('workspace');
    });

    it('reads the configured scope by default', () => {
        localStorage.clear();
        expect(reachForScope()).toBe('app');
        setScope('workspace');
        expect(reachForScope()).toBe('workspace');
        localStorage.clear();
    });

    it('sends a workspace path only on the workspace reach', () => {
        expect(agent).toContain("workspacePath: reach === 'workspace' ? (State.currentDir || null) : null");
    });
});

/* Report_20260913 §6-2 / §6-6. InlineAI and the presets are one round trip;
   the intents and the "freeform" agent task they ran through are gone. */
describe('InlineAI is a transform', () => {
    const inline = read('src/modules/ui/InlineAI.js');
    const mcp = read('src/modules/ai/JhAiMcp.js');
    const adapter = read('src/modules/ai/jhai-adapter.js');
    const agent = read('src/modules/ai/AIAgent.js');

    it('asks through runSingleShot', () => {
        expect(inline).toContain('AIAgent.runSingleShot({');
        expect(inline).not.toContain('AIAgent.run(');
        expect(agent).not.toMatch(/\n    async run\(/);
    });

    it('no longer reaches for freeform tasks or intents', () => {
        for (const gone of ['runJhaiFreeform', 'runJhaiIntent', 'listJhaiIntents', 'handleIntent', '_populateIntents']) {
            expect(inline).not.toContain(gone);
        }
        expect(mcp).not.toContain('registerIntent');
        expect(mcp).not.toContain('startJhaiTask');
        expect(adapter).not.toContain('registerIntent');
        expect(adapter).not.toContain('runIntentTask');
    });

    it('runs the presets as transforms and refuses personal notes', () => {
        const i = mcp.indexOf('export async function runInlinePreset(');
        const fn = mcp.slice(i, mcp.indexOf('export function listInlinePresets', i));
        expect(fn).toContain('AIAgent.runSingleShot({');
        expect(fn).toContain('isPrivatePath(anchor.path)');
    });
});

/* Report_20260913 §6-3. Work is sent from J.H AI Agent, not posted from here. */
describe('the task panel hands work over instead of starting it', () => {
    const panel = read('src/modules/ai/TaskNotificationPanel.js');

    it('opens the request in the agent', () => {
        const i = panel.indexOf('async _submitTask() {');
        const fn = panel.slice(i, panel.indexOf('\n    }\n', i));
        expect(fn).toContain('AIAgent.openInAgent({');
        expect(fn).not.toContain("method: 'POST'");
    });
});
