/**
 * AiPrefs.js — whether the AI features are turned on. Off until the user turns
 * them on in Settings → Agent.
 *
 * Someone who never asked for AI should not meet it: no AI commands in the
 * palette, no AI buttons, and — the part that worried people — nothing that
 * goes looking for J.H AI Agent. Reading its port file, probing localhost:14300
 * and asking the registry whether it is installed all wait for this switch
 * (ai/ConnectionConfig.js, ai/AgentConnection.js check it themselves, so a
 * path that slips past the hidden buttons still finds nothing).
 *
 * `<html class="ai-off">` hides the elements marked `.ai-only` while it is off.
 */

const KEY = 'settings_aiEnabled';

/** True only after the user turned AI on. */
export function aiEnabled() {
    try {
        return localStorage.getItem(KEY) === '1';
    } catch (_) {
        return false;
    }
}

/** Mirror the switch onto <html> so CSS can hide the AI-only controls. */
export function applyAiClass(doc = globalThis.document) {
    if (doc && doc.documentElement) doc.documentElement.classList.toggle('ai-off', !aiEnabled());
}

export function setAiEnabled(on) {
    try {
        localStorage.setItem(KEY, on ? '1' : '0');
    } catch (_) { /* private mode: stays off */ }
    applyAiClass();
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('aiEnabledChanged', { detail: { enabled: aiEnabled() } }));
    }
}
