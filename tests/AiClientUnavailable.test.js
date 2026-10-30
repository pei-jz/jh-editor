import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiClientAlias, hasAiClient } from '../scripts/ai-client-alias.js';

/* jh-editor builds without the sibling jh-ai-agent checkout: `@jh/ai-client`
   is an optional dependency, and without it vite / vitest point the import at
   AiClientUnavailable.js. The editor then runs, and every AI action explains
   that AI is not included instead of failing on a missing module. */

vi.mock('@jh/ai-client', async () => import('../src/modules/ai/AiClientUnavailable.js'));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => true) }));
const showDialog = vi.fn(async () => true);
vi.mock('../src/modules/ui/Dialog.js', () => ({ showDialog: (...a) => showDialog(...a) }));

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

beforeEach(() => {
    document.body.innerHTML = '<div class="slot"></div>';
    showDialog.mockClear();
});

describe('a build without @jh/ai-client', () => {
    it('is recognised as such', async () => {
        const { aiClientBundled } = await import('../src/modules/ai/AgentConnection.js');
        expect(aiClientBundled).toBe(false);
    });

    it('explains instead of offering to start or download the agent', async () => {
        const { ensureAgentAvailable } = await import('../src/modules/ai/AgentConnection.js');
        expect(await ensureAgentAvailable()).toBe(false);
        expect(showDialog).toHaveBeenCalledTimes(1);
        const opts = showDialog.mock.calls[0][0];
        expect(opts.message).toContain('without the J.H AI Agent client');
        expect(opts.buttons).toHaveLength(1);
    });

    it('shows a notice with no connect button, without probing the agent', async () => {
        const { showAgentNoticeIfOffline } = await import('../src/modules/ui/AgentNotice.js');
        const reachable = vi.fn(async () => true);
        const notice = await showAgentNoticeIfOffline(document.querySelector('.slot'), { reachable });
        expect(reachable).not.toHaveBeenCalled();
        expect(notice.textContent).toContain('does not include AI features');
        expect(notice.querySelector('button')).toBeNull();
    });

    it('the stand-in fails every call with a sentence', async () => {
        const { default: Client } = await import('../src/modules/ai/AiClientUnavailable.js');
        const c = new Client({});
        await expect(c.ready()).rejects.toThrow('does not include the J.H AI Agent client');
        await expect(c.invoke({})).rejects.toThrow('@jh/ai-client');
        await expect(c.invokeAgent({}).completed).rejects.toThrow('@jh/ai-client');
    });
});

describe('scripts/ai-client-alias.js', () => {
    it('aliases to the stand-in when the client is not installed', () => {
        const root = mkdtempSync(join(tmpdir(), 'jh-alias-'));
        expect(hasAiClient(root)).toBe(false);
        const alias = aiClientAlias(root);
        expect(alias['@jh/ai-client']).toBe(join(root, 'src', 'modules', 'ai', 'AiClientUnavailable.js'));
    });

    it('leaves the import alone when it is', () => {
        const root = mkdtempSync(join(tmpdir(), 'jh-alias-'));
        mkdirSync(join(root, 'node_modules', '@jh', 'ai-client'), { recursive: true });
        writeFileSync(join(root, 'node_modules', '@jh', 'ai-client', 'index.js'), 'export default class {}');
        expect(hasAiClient(root)).toBe(true);
        expect(aiClientAlias(root)).toEqual({});
    });

    it('points at a file that exists in this repository', () => {
        const target = join(repo, 'src', 'modules', 'ai', 'AiClientUnavailable.js');
        expect(existsSync(target)).toBe(true);
    });
});
