/**
 * AgentNotice.js — "this needs J.H AI Agent" line inside an AI surface.
 *
 * Without the agent, the inline AI popup (Ctrl+Space) and the chat panel
 * (Ctrl+Alt+C) opened looking ready, and only the first request found out
 * there was nobody to answer it. This puts the fact up front: when the panel
 * opens, the agent's health endpoint is asked (the user just asked for AI, so
 * this is not a startup probe), and if it does not answer, a quiet line says
 * so with a button that goes through the usual start / download flow.
 *
 * A build without the client (AgentConnection.aiClientBundled) gets a line
 * saying AI is not included, and no button: there is nothing to connect to.
 */

import { t } from '../utils/I18n.js';
import { isAgentReachable } from '../ai/ConnectionConfig.js';

const STYLE = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
    + 'font-size:11.5px;line-height:1.4;padding:6px 9px;border-radius:5px;'
    + 'background:var(--primary-soft);border:1px solid var(--primary-border);';
const BUTTON_STYLE = 'background:none;border:1px solid var(--primary-border);color:inherit;'
    + 'padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;white-space:nowrap;';

/**
 * Check the agent and, if it is not there, put a notice at the top of `host`.
 * Resolves to the notice element, or null when the agent answered (or `host`
 * was closed while checking).
 *
 * @param {HTMLElement} host  an empty slot in the panel; the notice goes in it
 * @param {{reachable?: () => Promise<boolean>, margin?: string}} [opts]
 *        `reachable` is injectable for tests
 */
export async function showAgentNoticeIfOffline(host, { reachable = () => isAgentReachable(1500), margin = '0 0 6px' } = {}) {
    if (!host) return null;
    // Loaded on first use, like AIAgent does: nothing of the agent's at boot.
    const { aiClientBundled, ensureAgentAvailable } = await import('../ai/AgentConnection.js');

    if (aiClientBundled) {
        let ok = false;
        try { ok = await reachable(); } catch (_) { ok = false; }
        if (ok || !host.isConnected) return null;
    }

    host.querySelector(':scope > .jh-agent-notice')?.remove();
    const notice = document.createElement('div');
    notice.className = 'jh-agent-notice';
    notice.setAttribute('role', 'status');
    notice.style.cssText = STYLE;
    notice.style.margin = margin;

    const text = document.createElement('span');
    text.style.flex = '1 1 180px';
    text.textContent = aiClientBundled
        ? t('AI features work once J.H AI Agent is connected. It is not connected now.')
        : t('This build does not include AI features (built without J.H AI Agent).');
    notice.appendChild(text);

    if (aiClientBundled) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jh-agent-notice-connect';
        button.style.cssText = BUTTON_STYLE;
        button.textContent = t('Connect…');
        button.onclick = async () => {
            button.disabled = true;
            try {
                if (await ensureAgentAvailable()) notice.remove();
            } finally {
                button.disabled = false;
            }
        };
        notice.appendChild(button);
    }

    host.prepend(notice);
    return notice;
}
