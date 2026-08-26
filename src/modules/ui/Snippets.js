/**
 * Snippets.js — user-defined text/code snippets.
 *
 * Stored in localStorage (fast, no project pollution) and exposed two ways:
 *   • a CodeMirror completion source (type the prefix → Tab) via
 *     snippetCompletionSource()
 *   • completion entries ("Insert snippet: <name>") in the editor's
 *     autocomplete list.
 *
 * A snippet expands by inserting its body at the caret, replacing any
 * selection. Placeholders are deliberately minimal (`$1`, `$2`) so it stays
 * predictable; this is not a full TextMate engine.
 */

const STORAGE_KEY = 'jh_snippets_v1';

function generateId() {
    return `snip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Where a snippet with no category of its own is filed. */
export const DEFAULT_CATEGORY = 'General';

/** Normalise a category: blank, whitespace or missing all mean the default. */
export function normalizeCategory(value) {
    const c = String(value == null ? '' : value).trim();
    return c || DEFAULT_CATEGORY;
}

function readAll() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((s) => s && typeof s.name === 'string' && typeof s.body === 'string')
            // Snippets stored before categories existed have none; they are read
            // as the default rather than migrated, so downgrading the app cannot
            // lose anything and nothing is rewritten on a plain read.
            .map((s) => ({ ...s, category: normalizeCategory(s.category) }));
    } catch (_) {
        return [];
    }
}

function writeAll(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { console.warn('Snippets persist failed:', e); }
}

export const Snippets = {
    getAll: readAll,

    /** Add a snippet. Throws when name/body are empty. Returns the stored item. */
    add(name, prefix, body, category) {
        const trimmedName = (name || '').trim();
        if (!trimmedName) throw new Error('Snippet name is required.');
        if (!body || !body.trim()) throw new Error('Snippet body is empty.');
        const item = {
            id: generateId(),
            name: trimmedName,
            prefix: (prefix || '').trim(),
            body,
            category: normalizeCategory(category),
            builtin: false,
        };
        const list = readAll();
        list.push(item);
        writeAll(list);
        return item;
    },

    remove(id) {
        const list = readAll();
        const next = list.filter((s) => s.id !== id);
        if (next.length === list.length) return false;
        writeAll(next);
        return true;
    },

    getById(id) {
        return readAll().find((s) => s.id === id) || null;
    },

    /** Move one snippet to another category. */
    setCategory(id, category) {
        const list = readAll();
        const item = list.find((s) => s.id === id);
        if (!item) return false;
        item.category = normalizeCategory(category);
        writeAll(list);
        return true;
    },

    /**
     * Every category in use, sorted, with the default first.
     *
     * The default leads regardless of alphabet: it is the bucket everything
     * starts in, so burying it under "Api" reads as a missing list.
     */
    categories() {
        const seen = new Set(readAll().map((s) => normalizeCategory(s.category)));
        seen.add(DEFAULT_CATEGORY);
        return [DEFAULT_CATEGORY,
            ...[...seen].filter((c) => c !== DEFAULT_CATEGORY)
                .sort((a, b) => a.localeCompare(b))];
    },

    /**
     * Snippets grouped for display: `[{ category, items }]`, categories in
     * `categories()` order and empty ones dropped.
     */
    grouped() {
        const all = readAll();
        return this.categories()
            .map((category) => ({
                category,
                items: all.filter((s) => normalizeCategory(s.category) === category),
            }))
            .filter((g) => g.items.length > 0);
    },
};

/**
 * Build a CodeMirror completion source for snippets. The source contributes
 * options whose prefix matches the current word, so "snippet prefix → Tab"
 * works inside the editor without intercepting normal typing.
 */
export function snippetCompletionSource() {
    return (context) => {
        const snippets = readAll().filter((s) => s.prefix);
        if (snippets.length === 0) return null;
        const word = context.matchBefore(/\S*/);
        if (!word) return null;
        const typed = word.text.toLowerCase();
        const options = snippets
            .filter((s) => s.prefix.toLowerCase().startsWith(typed) || s.name.toLowerCase().includes(typed))
            .map((s) => ({
                label: s.prefix || s.name,
                type: 'snippet',
                detail: s.name,
                apply: s.body,
                boost: typed ? 2 : 0,
            }));
        if (options.length === 0) return null;
        return {
            from: word.from,
            options,
        };
    };
}
