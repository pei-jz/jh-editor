import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* AI is off until the user turns it on (Settings → Agent). Someone who never
   asked for AI should not have the editor looking for J.H AI Agent on their
   machine — its port file, localhost:14300, the registry — nor meet AI
   commands and buttons. Off is the default, and every way to the agent checks
   the switch itself, so a path that slips past the hidden buttons still finds
   nothing. */

vi.mock('@jh/ai-client', () => ({ default: class FakeClient {} }));
// expand_env_path answers a real-looking path, so discovery can reach the file.
const invoke = vi.fn(async (cmd) => (cmd === 'expand_env_path' ? 'C:/Users/u/AppData/Roaming/agent/server.json' : true));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
const readTextFile = vi.fn(async () => '{"port": 15555}');
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: (...a) => readTextFile(...a) }));
const showDialog = vi.fn(async () => false);
vi.mock('../src/modules/ui/Dialog.js', () => ({ showDialog: (...a) => showDialog(...a) }));

const { aiEnabled, setAiEnabled, applyAiClass } = await import('../src/modules/utils/AiPrefs.js');
const { getConnectionConfig, isAgentReachable, refreshConnectionConfig } = await import('../src/modules/ai/ConnectionConfig.js');
const { ensureAgentAvailable } = await import('../src/modules/ai/AgentConnection.js');
const { showAgentNoticeIfOffline } = await import('../src/modules/ui/AgentNotice.js');
const { AI_COMMAND_IDS, allCommandIds } = await import('../src/modules/core/CommandRegistry.js');
const { ShortcutManager } = await import('../src/modules/core/ShortcutManager.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

let fetchSpy;
beforeEach(() => {
    localStorage.clear();
    refreshConnectionConfig();
    invoke.mockClear();
    readTextFile.mockClear();
    showDialog.mockClear();
    fetchSpy = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchSpy;
});

describe('the switch', () => {
    it('is off until turned on', () => {
        expect(aiEnabled()).toBe(false);
        setAiEnabled(true);
        expect(aiEnabled()).toBe(true);
        setAiEnabled(false);
        expect(aiEnabled()).toBe(false);
    });

    it('marks <html> so the AI-only buttons hide', () => {
        applyAiClass();
        expect(document.documentElement.classList.contains('ai-off')).toBe(true);
        setAiEnabled(true);
        expect(document.documentElement.classList.contains('ai-off')).toBe(false);
        expect(read('src/styles/layout.css')).toContain('.ai-off .ai-only { display: none !important; }');
        expect(read('src/modules/ui/GitPanel.js')).toContain('id="git-commit-ai-btn" class="ai-only"');
        expect(read('src/modules/views/DeckView.js')).toContain("this.aiBtn.classList.add('ai-only');");
    });

    it('announces a change, for anything showing AI', () => {
        const seen = [];
        const on = (e) => seen.push(e.detail.enabled);
        window.addEventListener('aiEnabledChanged', on);
        setAiEnabled(true);
        setAiEnabled(false);
        window.removeEventListener('aiEnabledChanged', on);
        expect(seen).toEqual([true, false]);
    });
});

describe('off, nothing looks for the agent', () => {
    it('reads no port file', async () => {
        const cfg = await getConnectionConfig({ force: true });
        expect(cfg.source).toBe('off');
        expect(readTextFile).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
    });

    it('sends nothing to localhost', async () => {
        expect(await isAgentReachable()).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('neither asks the registry nor offers to start or download it', async () => {
        expect(await ensureAgentAvailable()).toBe(false);
        expect(invoke).not.toHaveBeenCalled();
        expect(showDialog).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('puts no "not connected" notice in a panel', async () => {
        document.body.innerHTML = '<div class="slot"></div>';
        const reachable = vi.fn(async () => false);
        expect(await showAgentNoticeIfOffline(document.querySelector('.slot'), { reachable })).toBeNull();
        expect(reachable).not.toHaveBeenCalled();
    });

    it('finds the agent once turned on, without a restart', async () => {
        await getConnectionConfig();            // off: the default, not cached
        setAiEnabled(true);
        const cfg = await getConnectionConfig();
        expect(readTextFile).toHaveBeenCalled();
        expect(cfg.port).toBe(15555);
    });
});

describe('off, the AI commands are not there', () => {
    it('knows which commands are AI', () => {
        expect([...AI_COMMAND_IDS].sort()).toEqual([
            'app:agent-tasks', 'app:inline-ai', 'app:rephrase-selection',
            'app:summarize-selection', 'app:toggle-ai-chat', 'app:translate-selection',
        ]);
        for (const id of AI_COMMAND_IDS) expect(allCommandIds()).toContain(id);
    });

    it('leaves the palette without them', () => {
        expect(read('src/modules/ui/CommandPalette.js'))
            .toContain('listCommands(t).filter((c) => ai || !AI_COMMAND_IDS.has(c.id))');
    });

    it('leaves their keys to the editor (Ctrl+Space is not swallowed)', () => {
        const mgr = new ShortcutManager();
        const ran = vi.fn();
        mgr.shortcuts = mgr.shortcuts.map((s) => (s.cmd === 'app:inline-ai' ? { ...s, action: ran } : s));
        const press = () => {
            const e = new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true, cancelable: true });
            mgr.handleKeyDown(e);
            return e;
        };
        const off = press();
        expect(ran).not.toHaveBeenCalled();
        expect(off.defaultPrevented).toBe(false);

        setAiEnabled(true);
        const on = press();
        expect(ran).toHaveBeenCalledTimes(1);
        expect(on.defaultPrevented).toBe(true);
    });
});

describe('the settings tab', () => {
    it('has the switch, and probes the agent only when it is on', () => {
        const src = read('src/modules/ui/SettingsModal.js');
        expect(src).toContain('<input type="checkbox" id="ai-enabled"');
        expect(src).toContain('if (aiOn) (async () => {');
    });
});
