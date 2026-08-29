import { t } from '../utils/I18n.js';
/**
 * ContextScope.js — how much of the editor the AI is allowed to see.
 *
 * The MCP tools JHEditor publishes (`get_buffer`, `read_workspace_file`, …) are
 * PULL tools: the model decides when to call them, and nothing in the editor
 * asked the user first. That is fine for `get_selection` — the user selected the
 * text — and progressively less fine the wider it goes, ending at
 * `read_workspace_file`, which lets a model read a file the user never opened.
 *
 * So the reach is a setting rather than a constant, and it is enforced HERE
 * rather than in each tool, so a new tool cannot forget to ask.
 *
 * The default is the narrowest level. A default is a decision made on behalf of
 * everyone who never opens the settings screen, and for "which of my files leave
 * this machine" the safe end is the right place to put it.
 */

/** Ordered narrowest → widest. `rank` is what the gate compares. */
export const SCOPES = [
    {
        id: 'selection',
        rank: 1,
        label: t('Selection only'),
        hint: 'Only text you have selected is sent. Safest, but with no surrounding code the answer is sometimes wrong.',
    },
    {
        id: 'active',
        rank: 2,
        label: t('Active tab (recommended)'),
        hint: 'The file you are looking at, and nothing else. Enough context to answer properly.',
    },
    {
        id: 'open',
        rank: 3,
        label: t('All open tabs'),
        hint: 'Every buffer you have open, not just the front one.',
    },
    {
        id: 'workspace',
        rank: 4,
        label: t('Whole workspace'),
        hint: 'The model may read any file in the project, including ones you never opened.',
    },
];

const STORAGE_KEY = 'settings_aiContextScope';
const DEFAULT_SCOPE = 'selection';

/**
 * What each capability costs.
 *
 * `diagnostics` sits at `active` rather than `selection` because a diagnostic
 * quotes the line it is about, which is file content by another name.
 */
const REQUIRED = {
    selection: 1,       // get_selection
    activeBuffer: 2,    // get_buffer
    diagnostics: 2,     // get_diagnostics
    cursorContext: 2,   // the lines around the caret that InlineAI attaches
    openFiles: 3,       // list_open_files, get_buffer on a background tab
    workspaceFiles: 4,  // read_workspace_file, list_workspace_files
};

const byId = new Map(SCOPES.map((s) => [s.id, s]));

/** The configured scope, falling back to the narrowest on anything unexpected. */
export function getScope() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && byId.has(saved)) return saved;
    } catch (_) { /* private mode, etc. */ }
    return DEFAULT_SCOPE;
}

export function setScope(id) {
    if (!byId.has(id)) return false;
    try { localStorage.setItem(STORAGE_KEY, id); } catch (_) { /* ignore */ }
    return true;
}

export function scopeInfo(id = getScope()) {
    return byId.get(id) || byId.get(DEFAULT_SCOPE);
}

/**
 * May the AI use `capability` at the current setting?
 * @param {'selection'|'activeBuffer'|'diagnostics'|'cursorContext'|'openFiles'|'workspaceFiles'} capability
 */
export function allows(capability) {
    const need = REQUIRED[capability];
    // An unknown capability is a programming error, and the safe answer to a
    // question we do not understand is no.
    if (!need) return false;
    return scopeInfo().rank >= need;
}

/**
 * What a tool returns when the scope forbids it.
 *
 * Written for the MODEL: it says what is blocked, what it can use instead, and
 * that the user — not the model — decides. Without the last part a model will
 * keep retrying the same call.
 */
export function refusal(capability, toolName) {
    const current = scopeInfo();
    const needed = SCOPES.find((s) => s.rank === REQUIRED[capability]);
    return `Refused: "${toolName}" needs the editor's AI context scope to be at least `
        + `"${needed ? needed.label : 'a wider scope'}", and it is currently `
        + `"${current.label}". This is a privacy setting only the user can change `
        + `(Settings → AI → Context scope). Do not retry; work with what you have, `
        + `or ask the user to widen the scope or paste the text you need.`;
}

/**
 * Paths the AI never sees, whatever the scope.
 *
 * Personal notes are the reason this exists. They live outside every workspace,
 * so no file tool can reach them — but a daily note opens as an ordinary tab,
 * which put it in front of `get_buffer` and `list_open_files`. A memo is where
 * people write things they would never paste into a chat, so it is excluded by
 * path rather than by scope.
 *
 * `.agent/` is excluded for a different reason: it is the agent's own bookkeeping.
 */
const registeredPrivateDirs = new Set();

/**
 * Declare a directory as private at runtime.
 *
 * The patterns below are a guess at where the app config directory lands, and
 * the guess is wrong on at least one platform (`~/.config/com.jh.editor/`).
 * Whoever OWNS the directory knows its real path, so DailyNotes registers it
 * once it has resolved it; the patterns are only the fallback for the moment
 * before that happens.
 */
export function registerPrivateDir(dir) {
    const d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (d) registeredPrivateDirs.add(d);
}

export function isPrivatePath(path) {
    if (!path) return false;
    const p = String(path).replace(/\\/g, '/').toLowerCase();
    for (const d of registeredPrivateDirs) {
        if (p === d || p.startsWith(d + '/')) return true;
    }
    return p.includes('/notes/daily/')
        || p.includes('/jheditor/notes/')
        || p.includes('/.agent/');
}

/** Convenience for the tools: true when the document must not be exposed. */
export function isPrivateDoc(docId) {
    return isPrivatePath(docId);
}
