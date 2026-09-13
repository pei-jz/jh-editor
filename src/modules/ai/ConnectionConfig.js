/**
 * ConnectionConfig.js
 *
 * Where JHEditor finds the J.H AI Agent, and how it is allowed to talk to it.
 *
 * ── What changed, and why ─────────────────────────────────────────────────
 * This used to read a credential out of a file. The agent wrote its token to
 * %APPDATA%/JH/ai-connection.json when the user clicked "Export Connection",
 * and this module read it. That file was a full-access key to an API that can
 * run shell commands, readable by anything running as the user, with no
 * approval, no record of who took it, and no way to revoke one caller.
 *
 * It is replaced by pairing: the editor ASKS, the user approves the request in
 * the agent's own window after comparing a six-digit code, and the token that
 * comes back lives in memory on both sides. Nothing is written down, so closing
 * either app ends the grant — and the editor simply asks again next time.
 *
 * ── Address and credential are different problems ─────────────────────────
 * Finding the agent is not a secret; reaching it is. So discovery is separate
 * and stays file-based: the agent publishes its PORT (and nothing else) to
 * server.json in its own config directory, because 14300 is only its first
 * choice — a second copy, or anything else holding that port, moves it. The
 * health endpoint is the check, and it needs no credential.
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

const DEFAULT_PORT = 14300;
const AGENT_ID = 'io.github.pei-jz.jhaiagent';

/** Resolve env-style placeholders (%APPDATA% / $HOME) via the Rust side. */
async function expandEnvPath(path) {
    try {
        const expanded = await invoke('expand_env_path', { path });
        if (typeof expanded === 'string' && expanded.length > 0) return expanded;
    } catch (_) { /* command not registered — fall through */ }
    return path;
}

/**
 * The port the agent published, if it published one.
 *
 * server.json carries the ADDRESS only — the agent's own comment says so, and
 * says why: a second copy of a secret should not be created to solve an
 * addressing problem. Reading it here is therefore not reading a credential.
 */
async function discoverPort() {
    const candidates = [
        `%APPDATA%/${AGENT_ID}/server.json`,
        `$HOME/Library/Application Support/${AGENT_ID}/server.json`,
        `$XDG_CONFIG_HOME/${AGENT_ID}/server.json`,
        `$HOME/.config/${AGENT_ID}/server.json`,
    ];
    for (const raw of candidates) {
        const expanded = await expandEnvPath(raw);
        // A path that still holds a placeholder would never resolve anyway.
        if (expanded.includes('%') || expanded.includes('$')) continue;
        try {
            const text = await readTextFile(expanded);
            const data = JSON.parse(text || '{}');
            const port = Number(data.port);
            if (Number.isInteger(port) && port > 0) return port;
        } catch (_) {
            continue;
        }
    }
    return null;
}

/**
 * Where to reach the agent. Cached for the session: the port does not move
 * while the agent is running, and re-reading a file per API call is waste.
 *
 * NOTE there is no token here any more. The credential belongs to the client
 * (@jh/ai-client), which obtains it by pairing and holds it in memory; a token
 * passing through this module would be a token that could be logged or cached.
 */
let _cache = null;
let _cachePromise = null;

export async function getConnectionConfig({ force = false } = {}) {
    if (!force && _cache) return _cache;
    if (!force && _cachePromise) return _cachePromise;

    _cachePromise = (async () => {
        // A manual override stays, for a dev build or a second instance on a
        // non-standard port. Port only — an override that carried a token would
        // be the file all over again, in localStorage.
        let port = null;
        try {
            const raw = localStorage.getItem('settings_aiAgentUrl');
            if (raw) {
                const parsed = parseInt(new URL(raw).port, 10);
                if (Number.isInteger(parsed) && parsed > 0) port = parsed;
            }
        } catch (_) { /* not a URL — ignore it rather than fail to connect */ }

        if (!port) port = await discoverPort();

        _cache = {
            host: '127.0.0.1',
            port: port || DEFAULT_PORT,
            hostUrl: `http://127.0.0.1:${port || DEFAULT_PORT}`,
            source: port ? 'discovered' : 'default',
        };
        return _cache;
    })();

    return _cachePromise;
}

/** Invalidate the cache (call after the user changes the override). */
export function refreshConnectionConfig() {
    _cache = null;
    _cachePromise = null;
}

/**
 * Is the agent there?
 *
 * `/api/health` needs no credential, so this answers "is it running" without
 * touching pairing — which matters because the answer is what decides whether
 * putting an approval prompt in front of the user is worth doing at all.
 */
export async function isAgentReachable(timeoutMs = 2000) {
    const cfg = await getConnectionConfig();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${cfg.hostUrl}/api/health`, { signal: controller.signal });
        clearTimeout(timer);
        return res.ok;
    } catch (_) {
        return false;
    }
}
