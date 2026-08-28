import { SHORTCUTS } from './ShortcutDefinitions.js';

/**
 * CommandRegistry.js — what the app can DO, as data.
 *
 * The shortcut guide (F1) renders `ShortcutDefinitions.js`, so it can only show
 * things that have a key bound to them. Measured against the dispatcher, that
 * left eight commands with no way to discover them at all — the Git panel,
 * Notes, the daily note, agent tasks, and the three selection-AI actions were
 * reachable only if you already knew which button to press.
 *
 * This is the other list: every command a person might want to run, with a name
 * written for a human rather than a `cmd` string. The palette renders it; the
 * keybinding column is looked up from ShortcutDefinitions so the two can never
 * disagree about which key does what.
 *
 * Labels are English source strings, which is how I18n keys work here — they
 * pass through `t()` at render time and fall back to English untranslated.
 *
 * NOT everything the app can do is here. Features driven only by a button, a
 * `<select>` or a context menu (theme, PDF export, encoding, line endings,
 * "Reveal in File Explorer") have no command id to call, so putting them in the
 * palette means giving them one first. That is a larger change than this file.
 */

export const CATEGORIES = ['File', 'Edit', 'Search', 'Go', 'View', 'Compare', 'Git', 'AI', 'Help'];

/**
 * @typedef {{id:string, label:string, category:string, icon:string, keywords?:string}} Command
 *   `keywords` are extra words the search should match but the label does not
 *   contain — the words someone would actually type looking for the thing.
 */

/** @type {Command[]} */
const COMMANDS = [
    // ── File ─────────────────────────────────────────────────────────
    { id: 'app:new-file', label: 'New File', category: 'File', icon: 'file', keywords: 'create blank' },
    { id: 'app:save', label: 'Save', category: 'File', icon: 'check', keywords: 'write disk' },
    { id: 'app:save-as', label: 'Save As…', category: 'File', icon: 'export', keywords: 'write copy rename' },
    { id: 'app:close-tab', label: 'Close Tab', category: 'File', icon: 'close' },
    { id: 'app:open-notes', label: 'Open Notes', category: 'File', icon: 'note', keywords: 'quick scratch' },
    { id: 'app:new-note', label: 'New Note', category: 'File', icon: 'plus', keywords: 'quick scratch' },
    { id: 'app:daily-note', label: "Open Today's Daily Note", category: 'File', icon: 'clock', keywords: 'journal diary today' },
    { id: 'app:refresh-explorer', label: 'Refresh Explorer', category: 'File', icon: 'refresh', keywords: 'reload tree files' },

    // ── Edit ─────────────────────────────────────────────────────────
    { id: 'app:undo', label: 'Undo', category: 'Edit', icon: 'chevron-left' },
    { id: 'app:redo', label: 'Redo', category: 'Edit', icon: 'chevron-right' },
    { id: 'app:cut', label: 'Cut', category: 'Edit', icon: 'x' },
    { id: 'app:copy', label: 'Copy', category: 'Edit', icon: 'clipboard' },
    { id: 'app:paste', label: 'Paste', category: 'Edit', icon: 'clipboard' },
    { id: 'app:format', label: 'Format Document', category: 'Edit', icon: 'sparkles', keywords: 'pretty print indent beautify' },
    { id: 'app:toggle-whitespace', label: 'Toggle Whitespace Markers', category: 'Edit', icon: 'filter', keywords: 'show spaces tabs invisible' },

    // ── Search ───────────────────────────────────────────────────────
    { id: 'app:search', label: 'Find in File', category: 'Search', icon: 'search', keywords: 'find replace' },
    { id: 'app:find-next', label: 'Find Next', category: 'Search', icon: 'chevron-down' },
    { id: 'app:find-prev', label: 'Find Previous', category: 'Search', icon: 'chevron-up' },
    { id: 'app:replace-next', label: 'Replace & Find Next', category: 'Search', icon: 'replace' },
    { id: 'app:grep', label: 'Search in Workspace', category: 'Search', icon: 'search', keywords: 'grep project folder glob' },
    { id: 'app:file-search', label: 'Go to File', category: 'Search', icon: 'file', keywords: 'open quick find' },

    // ── Go ───────────────────────────────────────────────────────────
    { id: 'app:goto-line', label: 'Go to Line', category: 'Go', icon: 'arrow-down', keywords: 'jump number' },
    { id: 'app:outline-modal', label: 'Go to Symbol (Outline)', category: 'Go', icon: 'scroll', keywords: 'heading structure toc' },
    { id: 'app:tab-search', label: 'Switch Tab', category: 'Go', icon: 'search', keywords: 'find open buffer' },
    { id: 'editor:next-tab', label: 'Next Tab', category: 'Go', icon: 'chevron-right' },
    { id: 'editor:prev-tab', label: 'Previous Tab', category: 'Go', icon: 'chevron-left' },
    { id: 'app:focus-explorer', label: 'Focus Explorer', category: 'Go', icon: 'folder', keywords: 'sidebar tree' },
    { id: 'app:focus-editor', label: 'Focus Editor', category: 'Go', icon: 'pencil' },

    // ── View ─────────────────────────────────────────────────────────
    { id: 'app:toggle-view-mode', label: 'Toggle View Mode', category: 'View', icon: 'swap', keywords: 'text structure table markdown csv' },
    { id: 'app:toggle-preview', label: 'Toggle Preview', category: 'View', icon: 'file-globe', keywords: 'html markdown render' },
    { id: 'app:toggle-book-mode', label: 'Toggle Book Mode', category: 'View', icon: 'file-text', keywords: 'page turn read' },
    { id: 'app:toggle-vim', label: 'Toggle Vim Mode', category: 'View', icon: 'terminal', keywords: 'vi modal keys' },

    // ── Compare ──────────────────────────────────────────────────────
    { id: 'app:diff', label: 'Compare with Saved File', category: 'Compare', icon: 'diff', keywords: 'diff disk changes' },
    { id: 'app:open-compare', label: 'Compare Scratch Text', category: 'Compare', icon: 'compare', keywords: 'diff paste two' },

    // ── Git ──────────────────────────────────────────────────────────
    { id: 'app:git-panel', label: 'Toggle Git Panel', category: 'Git', icon: 'branch', keywords: 'source control commit status branch' },

    // ── AI ───────────────────────────────────────────────────────────
    { id: 'app:inline-ai', label: 'Inline AI Edit', category: 'AI', icon: 'sparkles', keywords: 'explain refactor rewrite' },
    { id: 'app:toggle-ai-chat', label: 'Toggle AI Chat', category: 'AI', icon: 'robot', keywords: 'assistant ask' },
    { id: 'app:agent-tasks', label: 'Open Agent Tasks', category: 'AI', icon: 'tool', keywords: 'jobs background status' },
    { id: 'app:summarize-selection', label: 'Summarize Selection', category: 'AI', icon: 'scroll' },
    { id: 'app:translate-selection', label: 'Translate Selection', category: 'AI', icon: 'file-globe' },
    { id: 'app:rephrase-selection', label: 'Rephrase Selection', category: 'AI', icon: 'pencil', keywords: 'reword rewrite' },

    // ── Help ─────────────────────────────────────────────────────────
    { id: 'app:shortcut-guide', label: 'Keyboard Shortcut Guide', category: 'Help', icon: 'info', keywords: 'keys bindings help f1' },
    { id: 'app:devtools', label: 'Open Developer Tools', category: 'Help', icon: 'tool', keywords: 'debug console inspect' },
];

/** Format one ShortcutDefinitions entry as the key string a person reads. */
export function formatBinding(item) {
    if (!item) return '';
    const parts = [];
    if (item.ctrl) parts.push('Ctrl');
    if (item.alt) parts.push('Alt');
    if (item.shift) parts.push('Shift');
    const k = item.key === ' ' ? 'Space' : item.key;
    parts.push(k.length === 1 ? k.toUpperCase() : k);
    return parts.join('+');
}

/**
 * command id → its key binding, preferring a GLOBAL one.
 *
 * A command can be bound in several scopes (and to several keys). The palette
 * shows the binding that works from wherever the user just opened it, which is
 * the global one; a scope-specific key is shown only when there is no global.
 */
export function bindingsByCommand(defs = SHORTCUTS) {
    const map = new Map();
    const scopes = Object.keys(defs);
    // GLOBAL first so it wins the "first one seen" rule below.
    scopes.sort((a, b) => (a === 'GLOBAL' ? -1 : b === 'GLOBAL' ? 1 : 0));
    for (const scope of scopes) {
        for (const item of defs[scope] || []) {
            if (!item || !item.cmd) continue;
            if (!map.has(item.cmd)) map.set(item.cmd, formatBinding(item));
        }
    }
    return map;
}

/**
 * The full command list, each with the key that runs it.
 * `t` is injected rather than imported so this module stays pure and the tests
 * do not need a locale.
 */
export function listCommands(translate = (s) => s, defs = SHORTCUTS) {
    const bindings = bindingsByCommand(defs);
    return COMMANDS.map((c) => ({
        ...c,
        label: translate(c.label),
        category: c.category,
        categoryLabel: translate(c.category),
        binding: bindings.get(c.id) || '',
    }));
}

/** First letter of each word: "Toggle Git Panel" → "tgp". */
export function initials(text) {
    return String(text || '')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0])
        .join('')
        .toLowerCase();
}

/**
 * Subsequence match with a score, the behaviour people expect from a palette:
 * "tgp" finds "Toggle Git Panel".
 *
 * Higher is better; `null` means no match. Scoring rewards, in order, matches
 * at a word start, runs of adjacent characters, and an early first match — so
 * an exact prefix always beats a scattered subsequence.
 *
 * The initials bonus is what makes the example in the first line actually true.
 * Plain subsequence matching is greedy and leftmost, so "tgp" against
 * "Toggle Preview" consumed the `g` inside "Toggle" and scored HIGHER than
 * "Toggle Git Panel", where the `p` sits further right. Typing the initials of
 * a command is the main way anyone drives a palette once they know it, so that
 * pattern is scored explicitly rather than left to the generic path.
 */
export function fuzzyScore(haystack, needle) {
    const h = String(haystack || '').toLowerCase();
    const n = String(needle || '').toLowerCase().trim();
    if (!n) return 0;
    if (!h) return null;

    const compact = n.replace(/\s+/g, '');

    let score = 0;
    let hi = 0;
    let prevMatch = -2;

    for (let ni = 0; ni < n.length; ni++) {
        const ch = n[ni];
        if (ch === ' ') continue;           // spaces separate terms, match nothing
        const found = h.indexOf(ch, hi);
        if (found === -1) return null;

        if (found === 0 || /[\s\-_/:.(]/.test(h[found - 1])) score += 10;  // word start
        if (found === prevMatch + 1) score += 6;                            // adjacent
        score -= Math.min(found - hi, 10);                                  // distance skipped

        prevMatch = found;
        hi = found + 1;
    }

    // Typed the initials — the strongest signal there is.
    const acro = initials(h);
    if (acro === compact) score += 60;
    else if (acro.startsWith(compact)) score += 40;

    // Typed a literal run of the label.
    if (h.startsWith(compact)) score += 30;
    else if (h.includes(compact)) score += 15;

    // Prefer the shorter of two equally-matching labels.
    score -= Math.floor(h.length / 20);
    return score;
}

/**
 * Rank commands for a query. An empty query keeps the registry's own order,
 * which is grouped by category and therefore browsable.
 */
export function searchCommands(commands, query) {
    const q = String(query || '').trim();
    if (!q) return commands.slice();

    const scored = [];
    for (const c of commands) {
        // Category and keywords participate in matching, but the label is what
        // the user is reading, so a hit there outranks a hit in the metadata.
        const labelScore = fuzzyScore(c.label, q);
        const metaScore = fuzzyScore(`${c.categoryLabel} ${c.label} ${c.keywords || ''}`, q);
        const best = labelScore != null
            ? labelScore + 25
            : (metaScore != null ? metaScore : null);
        if (best != null) scored.push({ c, best });
    }
    scored.sort((a, b) => b.best - a.best);
    return scored.map((s) => s.c);
}

/** Raw metadata, for tests. */
export function allCommandIds() {
    return COMMANDS.map((c) => c.id);
}

export default { listCommands, searchCommands, fuzzyScore, bindingsByCommand, formatBinding, allCommandIds, CATEGORIES };
