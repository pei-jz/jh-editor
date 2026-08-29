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
        return panel.slice(i, panel.indexOf('\n    _append(', i));
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
        const i = panel.indexOf('const startedAt = Date.now();');
        const send = panel.slice(i, panel.indexOf('renderAll();', i));
        expect(send).toContain('setInterval(');
        expect(send).toContain('clearInterval(ticker)');
        expect(send).toContain("ms < 1000 ? `${ms} ms`");
        expect(send).toContain('sent: ');
    });

    it('states the live scope instead of a sentence that was never true', () => {
        expect(panel).not.toContain('Send Selection');
        expect(panel).toContain('Context scope: ');
    });
});
