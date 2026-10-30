import { describe, it, expect, beforeEach, vi } from 'vitest';

/* Without J.H AI Agent, Ctrl+Space and Ctrl+Alt+C opened panels that looked
   ready and only failed on the first request. AgentNotice puts the fact in the
   panel as it opens, with a button into the usual start / download flow.

   '@jh/ai-client' is mocked as a real-looking client here, so this file behaves
   the same with or without the sibling jh-ai-agent checkout. The build without
   the client is AiClientUnavailable.test.js. */

vi.mock('@jh/ai-client', () => ({ default: class FakeClient {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => true) }));
// No agent on this machine, as far as the flow behind the button can tell.
vi.mock('../src/modules/ai/ConnectionConfig.js', () => ({ isAgentReachable: async () => false }));
const showDialog = vi.fn(async () => false);
vi.mock('../src/modules/ui/Dialog.js', () => ({ showDialog: (...a) => showDialog(...a) }));

const { showAgentNoticeIfOffline } = await import('../src/modules/ui/AgentNotice.js');
const { aiClientBundled } = await import('../src/modules/ai/AgentConnection.js');

let slot;
beforeEach(() => {
    document.body.innerHTML = '<div class="panel"><div class="slot"></div></div>';
    slot = document.querySelector('.slot');
    showDialog.mockClear();
});

describe('agent notice', () => {
    it('treats a real client as bundled', () => {
        expect(aiClientBundled).toBe(true);
    });

    it('stays out of the way when the agent answers', async () => {
        const notice = await showAgentNoticeIfOffline(slot, { reachable: async () => true });
        expect(notice).toBeNull();
        expect(slot.children).toHaveLength(0);
    });

    it('says the agent is needed, with a connect button, when it does not', async () => {
        const notice = await showAgentNoticeIfOffline(slot, { reachable: async () => false });
        expect(slot.querySelector('.jh-agent-notice')).toBe(notice);
        expect(notice.textContent).toContain('J.H AI Agent');
        expect(notice.querySelector('.jh-agent-notice-connect')).not.toBeNull();
    });

    it('treats a failed check as offline', async () => {
        const notice = await showAgentNoticeIfOffline(slot, {
            reachable: async () => { throw new Error('boom'); },
        });
        expect(notice).not.toBeNull();
    });

    it('does nothing to a panel closed while the check ran', async () => {
        const notice = await showAgentNoticeIfOffline(slot, {
            reachable: async () => { slot.remove(); return false; },
        });
        expect(notice).toBeNull();
    });

    it('does not stack notices when shown twice', async () => {
        await showAgentNoticeIfOffline(slot, { reachable: async () => false });
        await showAgentNoticeIfOffline(slot, { reachable: async () => false });
        expect(slot.querySelectorAll('.jh-agent-notice')).toHaveLength(1);
    });

    it('connect goes through the start / download flow', async () => {
        const notice = await showAgentNoticeIfOffline(slot, { reachable: async () => false });
        notice.querySelector('.jh-agent-notice-connect').click();
        await vi.waitFor(() => expect(showDialog).toHaveBeenCalled());
        // The user cancelled the dialog: the notice stays.
        await vi.waitFor(() => expect(notice.querySelector('button').disabled).toBe(false));
        expect(notice.isConnected).toBe(true);
    });
});
