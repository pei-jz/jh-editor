/**
 * AgentConnection.js — reachability + launch/download guidance for J.H AI Agent.
 *
 * The editor used to probe the agent at STARTUP and pair (fetch a token) at
 * STARTUP. Both are now deferred to the moment the user actually asks for AI.
 * This module is the single door every AI entry point goes through first:
 *
 *   ensureAgentAvailable()  — is the agent there? If not, start it (installed)
 *                             or point at the download page (not installed).
 *   ensureMcpServer()       — lazily register this editor's MCP server, which
 *                             used to happen at startup too.
 *
 * Neither is ever called during boot. See src/modules/core/App.js — the eager
 * initJhEditorMcp() call that used to pair at startup is gone.
 *
 * ── Why the token check matters here ──────────────────────────────────────
 * "Connection check" and "token" are the same probe as far as the user sees: a
 * token is obtained by PAIRING, and pairing is an HTTP call to the running
 * agent. If the agent is not running that call fails with "Could not reach
 * J.H AI Agent". So the reachability check has to run FIRST, and only when it
 * passes do we let the pairing happen. Otherwise every AI feature would surface
 * a raw fetch error instead of "want me to start the agent?".
 */

import { invoke } from '@tauri-apps/api/core';
import { isAgentReachable } from './ConnectionConfig.js';
import { showDialog } from '../ui/Dialog.js';
import { t } from '../utils/I18n.js';

/** The canonical download page for J.H AI Agent. */
const DOWNLOAD_URL = 'https://github.com/pei-jz/jh-ai-agent/releases/latest';

/** Whether the agent is installed (Rust-side install-location lookup). */
async function isAgentInstalled() {
    try {
        return !!(await invoke('is_jh_agent_installed'));
    } catch (_) {
        // Not running under Tauri (plain browser dev) — cannot know. Treat as
        // installed so the flow degrades to "start it", not a download nag.
        return true;
    }
}

/** Start the agent. Resolves true on success, false otherwise. */
async function launchAgent() {
    try {
        await invoke('launch_jh_agent');
        return true;
    } catch (_) {
        return false;
    }
}

/** Open the agent's download page in the default browser. */
async function openDownloadPage() {
    try {
        await invoke('open_url', { url: DOWNLOAD_URL });
    } catch (_) { /* non-Tauri: nothing to open */ }
}

/** Poll the health endpoint until the agent comes up, or the window closes. */
async function waitForReachable(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isAgentReachable(1500)) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

/**
 * Make sure the agent is reachable, launching it (installed) or guiding to the
 * download page (not installed) when it is not.
 *
 * Call at the START of an AI action — never during startup. Returns true when
 * the agent is ready to talk to; the caller then does its work (pairing
 * included). Returns false when the user cancelled or the agent still is not up.
 */
export async function ensureAgentAvailable() {
    // Fast path: already running. No dialog, no pairing — just "yes".
    if (await isAgentReachable(1500)) return true;

    const installed = await isAgentInstalled();

    if (!installed) {
        const go = await showDialog({
            title: t('J.H AI Agent is not installed'),
            message: t('J.H AI Agent is not installed. Download and install it, then try again.'),
            kind: 'warning',
            buttons: [
                { label: t('Cancel'), value: false, cancel: true },
                { label: t('Open download page'), value: true, primary: true },
            ],
        });
        if (go) await openDownloadPage();
        return false;
    }

    const start = await showDialog({
        title: t('J.H AI Agent is not running'),
        message: t('J.H AI Agent is not running. Start it now?'),
        kind: 'warning',
        buttons: [
            { label: t('Cancel'), value: false, cancel: true },
            { label: t('Start J.H AI Agent'), value: true, primary: true },
        ],
    });
    if (!start) return false;

    const launched = await launchAgent();
    if (!launched) return false;
    return waitForReachable();
}

/**
 * Register this editor's MCP server with the agent, lazily. This used to happen
 * at startup (App.js called initJhEditorMcp()); it now happens on first use by
 * the one caller that needs it — the `ask` run, whose tools the agent reaches
 * over this bridge. Dynamic import avoids a JhAiMcp ↔ AIAgent cycle.
 */
export async function ensureMcpServer() {
    try {
        const { initJhEditorMcp } = await import('./JhAiMcp.js');
        await initJhEditorMcp();
    } catch (e) {
        console.warn('JHAI MCP init failed:', e);
    }
}
