/**
 * ConnectionConfig.js
 *
 * Resolves how JHEditor reaches the J.H AI Agent server. Discovery order:
 *
 *   1. Standard JH config path written by JH AI Agent's "Export Connection"
 *      button (Settings → General → 📤 Export). Locations:
 *        Windows  : %APPDATA%/JH/ai-connection.json
 *        macOS    : $HOME/Library/Application Support/JH/ai-connection.json
 *        Linux    : $HOME/.config/JH/ai-connection.json
 *
 *   2. localStorage overrides (settings_aiAgentUrl + settings_aiAgentToken)
 *      set via JHEditor's SettingsModal. These are preserved for backward
 *      compatibility AND as a manual override when running against a
 *      non-standard JH AI Agent instance.
 *
 *   3. Fallback: http://localhost:14300 with no token.
 *
 * Why both layers?
 *   • The standard path is "zero-setup" for users who installed JH AI Agent
 *     and clicked Export. No manual URL/token entry needed.
 *   • localStorage stays around so power users / dev environments can point
 *     at a different port or remote agent without touching the standard path.
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

const DEFAULT_FALLBACK = { hostUrl: 'http://localhost:14300', token: '' };

/** Resolve env-style placeholders (%APPDATA% / $HOME / $XDG_CONFIG_HOME) via Rust. */
async function expandEnvPath(path) {
    // Try Rust-side os.env helpers first if available; otherwise do a JS-side
    // best-effort using known env names. Tauri exposes env via Manager APIs
    // in Rust but not directly in JS — we call a tiny helper command if the
    // host registers one, else we fall through to the OS-specific candidates.
    try {
        // JHEditor's Rust side may expose an `expand_path` command. If not,
        // we just return the placeholders unexpanded; readTextFile would fail
        // and we'd move on to the next candidate path.
        const expanded = await invoke('expand_env_path', { path });
        if (typeof expanded === 'string' && expanded.length > 0) return expanded;
    } catch (_) { /* command not registered — fine */ }
    return path;
}

/**
 * Try to load the standard JH connection config file. Returns `null` if not
 * found / unreadable / malformed — callers fall back to localStorage.
 */
async function tryReadStandardConfig() {
    const candidates = [
        '%APPDATA%/JH/ai-connection.json',
        '$HOME/Library/Application Support/JH/ai-connection.json',
        '$XDG_CONFIG_HOME/JH/ai-connection.json',
        '$HOME/.config/JH/ai-connection.json',
    ];

    for (const raw of candidates) {
        const expanded = await expandEnvPath(raw);
        // Skip paths that still contain unexpanded placeholders — they would
        // never resolve to a real file anyway.
        if (expanded.includes('%') || expanded.includes('$')) continue;
        try {
            const text = await readTextFile(expanded);
            if (!text) continue;
            const data = JSON.parse(text);
            if (data && data.token && data.port) {
                const host = data.host || '127.0.0.1';
                return {
                    hostUrl: `http://${host}:${data.port}`,
                    token: data.token,
                    source: expanded,
                };
            }
        } catch (_) {
            // file missing or unreadable — try the next candidate
            continue;
        }
    }
    return null;
}

/**
 * Look up effective connection settings. Cached for the duration of the
 * session so we don't re-read the config file on every API call.
 */
let _cache = null;
let _cachePromise = null;

export async function getConnectionConfig({ force = false } = {}) {
    if (!force && _cache) return _cache;
    if (!force && _cachePromise) return _cachePromise;

    _cachePromise = (async () => {
        // 1. Manual localStorage override always wins if BOTH url and token are set
        //    (the user explicitly configured this).
        const lsUrl = localStorage.getItem('settings_aiAgentUrl')
            || localStorage.getItem('settings_aiExternalAgentUrl');
        const lsToken = localStorage.getItem('settings_aiAgentToken')
            || localStorage.getItem('settings_aiExternalAgentToken');
        if (lsUrl && lsToken) {
            _cache = { hostUrl: lsUrl, token: lsToken, source: 'localStorage' };
            return _cache;
        }

        // 2. Standard JH config path
        const std = await tryReadStandardConfig();
        if (std) {
            _cache = std;
            return _cache;
        }

        // 3. Partial localStorage (url-only or token-only) merged with fallback
        _cache = {
            hostUrl: lsUrl || DEFAULT_FALLBACK.hostUrl,
            token:   lsToken || DEFAULT_FALLBACK.token,
            source:  'fallback',
        };
        return _cache;
    })();

    return _cachePromise;
}

/** Invalidate the cache (call after the user updates settings). */
export function refreshConnectionConfig() {
    _cache = null;
    _cachePromise = null;
}

/** Quick health probe — returns true if the resolved server responds. */
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
