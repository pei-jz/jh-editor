/**
 * RegexPresets.js — the regex sample library behind the search box.
 *
 * These started as a flat array rendered into a context menu. Thirty-eight
 * entries in one column is taller than the window, so the list is grouped and
 * each group folds; and because the useful pattern is always the one nobody
 * wrote down, users can add their own — and their own categories.
 *
 * Built-ins are never really deleted. Removing one records its id in a hidden
 * list, so the library can be restored without shipping a re-import.
 */

const USER_KEY = 'settings_regexPresets';
const HIDDEN_KEY = 'settings_regexPresets_hiddenBuiltin';

/** Where a preset with no category of its own is filed. */
export const DEFAULT_CATEGORY = 'Common';

/** Trim a category; blank, whitespace or missing all mean the default. */
export function normalizeCategory(value) {
    const c = String(value == null ? '' : value).trim();
    return c || DEFAULT_CATEGORY;
}

export const BUILTIN_PRESETS = [
    { id: 'b:email',      category: 'Common', label: 'Email address',                  pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.]+' },
    { id: 'b:url',        category: 'Common', label: 'URL (http/https)',               pattern: 'https?://[^\\s"\'<>]+' },
    { id: 'b:ipv4',       category: 'Common', label: 'IPv4 address (bounded)',         pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b' },
    { id: 'b:ja',         category: 'Common', label: 'Japanese only (kana / kanji)',   pattern: '[ぁ-んァ-ヶ一-龠々]+' },
    { id: 'b:fullwidth',  category: 'Common', label: 'All full-width characters',      pattern: '[^\\x00-\\x7F]+' },
    { id: 'b:todo',       category: 'Common', label: 'TODO / FIXME / HACK',            pattern: '(?:TODO|FIXME|HACK|XXX|NOTE)' },

    { id: 'b:la-pos',     category: 'Lookaround', label: 'Positive lookahead: just before foo',        pattern: 'foo(?=bar)' },
    { id: 'b:la-neg',     category: 'Lookaround', label: 'Negative lookahead: lines without foo',      pattern: '^(?!.*foo).*$' },
    { id: 'b:lb-pos',     category: 'Lookaround', label: 'Positive lookbehind: amount digits',         pattern: '(?<=[￥$])\\d[\\d,]*' },
    { id: 'b:lb-neg',     category: 'Lookaround', label: 'Negative lookbehind: not preceded by a dot', pattern: '(?<!\\.)\\bword\\b' },
    { id: 'b:delim',      category: 'Lookaround', label: 'Value inside delimiters ("…")',              pattern: '(?<=")[^"]*(?=")' },

    { id: 'b:lazy',       category: 'Quantifiers', label: 'Shortest match (lazy) <…>',   pattern: '<.*?>' },
    { id: 'b:fence',      category: 'Quantifiers', label: 'Markdown code block',         pattern: '```[\\s\\S]*?```' },
    { id: 'b:tag',        category: 'Quantifiers', label: 'HTML / XML tag',              pattern: '</?[a-zA-Z][^>]*>' },
    { id: 'b:blockcmt',   category: 'Quantifiers', label: 'Block comment /* ... */',     pattern: '/\\*[\\s\\S]*?\\*/' },
    { id: 'b:linecmt',    category: 'Quantifiers', label: 'Line comment // …',           pattern: '//.*$' },

    { id: 'b:dupword',    category: 'Groups & backreferences', label: 'Repeated word',                pattern: '\\b(\\w+)\\s+\\1\\b' },
    { id: 'b:quotes',     category: 'Groups & backreferences', label: 'Matching quotes ("" or \'\')', pattern: '(["\']).*?\\1' },
    { id: 'b:named',      category: 'Groups & backreferences', label: 'Named capture (year)',         pattern: '(?<year>\\d{4})' },

    { id: 'b:trailws',    category: 'Whitespace & lines', label: 'Trailing whitespace',            pattern: '[ \\t]+$' },
    { id: 'b:blankline',  category: 'Whitespace & lines', label: 'Blank line (whitespace only)',   pattern: '^[ \\t]*$' },
    { id: 'b:multispace', category: 'Whitespace & lines', label: 'Consecutive spaces',             pattern: '[ \\t]{2,}' },
    { id: 'b:ideospace',  category: 'Whitespace & lines', label: 'Full-width space',               pattern: '\\u3000' },
    { id: 'b:blanks3',    category: 'Whitespace & lines', label: 'Consecutive blank lines (3+)',   pattern: '(?:\\r?\\n){3,}' },

    { id: 'b:date',       category: 'Numbers, dates & codes', label: 'Date YYYY-MM-DD',                pattern: '\\d{4}-\\d{2}-\\d{2}' },
    { id: 'b:time',       category: 'Numbers, dates & codes', label: 'Time HH:MM(:SS)',                pattern: '\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b' },
    { id: 'b:hex',        category: 'Numbers, dates & codes', label: 'Hex colour #fff / #ffffff',      pattern: '#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\\b' },
    { id: 'b:thousands',  category: 'Numbers, dates & codes', label: 'Comma-separated number 1,234,567', pattern: '\\b\\d{1,3}(?:,\\d{3})+\\b' },
    { id: 'b:decimal',    category: 'Numbers, dates & codes', label: 'Decimal (signed)',               pattern: '[+-]?\\d+(?:\\.\\d+)?' },
    { id: 'b:uuid',       category: 'Numbers, dates & codes', label: 'UUID',                           pattern: '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}' },
    { id: 'b:semver',     category: 'Numbers, dates & codes', label: 'Semantic version',               pattern: '\\bv?\\d+\\.\\d+\\.\\d+\\b' },
    { id: 'b:phonejp',    category: 'Numbers, dates & codes', label: 'Phone number (JP)',              pattern: '0\\d{1,4}-\\d{1,4}-\\d{4}' },
    { id: 'b:zipjp',      category: 'Numbers, dates & codes', label: 'Postal code (JP)',               pattern: '\\d{3}-\\d{4}' },
];

/** The order categories appear in, with anything new appended alphabetically. */
const BUILTIN_ORDER = [...new Set(BUILTIN_PRESETS.map((p) => p.category))];

function readJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : fallback;
        return Array.isArray(parsed) ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { console.warn('Regex presets persist failed:', e); }
}

function generateId() {
    return `u:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readUser() {
    return readJson(USER_KEY, [])
        .filter((p) => p && typeof p.label === 'string' && typeof p.pattern === 'string')
        .map((p) => ({ ...p, category: normalizeCategory(p.category), builtin: false }));
}

export const RegexPresets = {
    /** Hidden built-ins, so Settings can offer to bring them back. */
    hiddenBuiltins() {
        const hidden = new Set(readJson(HIDDEN_KEY, []));
        return BUILTIN_PRESETS.filter((p) => hidden.has(p.id));
    },

    /** Every visible preset: built-ins the user has not removed, then theirs. */
    getAll() {
        const hidden = new Set(readJson(HIDDEN_KEY, []));
        return [
            ...BUILTIN_PRESETS.filter((p) => !hidden.has(p.id)).map((p) => ({ ...p, builtin: true })),
            ...readUser(),
        ];
    },

    /**
     * Categories in use. Built-in ones keep their authored order — it runs from
     * everyday to obscure, which alphabetical would scramble — and anything the
     * user invents is appended in alphabetical order.
     */
    categories() {
        const inUse = new Set(this.getAll().map((p) => p.category));
        const known = BUILTIN_ORDER.filter((c) => inUse.has(c));
        const extra = [...inUse].filter((c) => !BUILTIN_ORDER.includes(c)).sort((a, b) => a.localeCompare(b));
        // The default must exist even when every preset in it was removed, so
        // the "add" form always has somewhere to put things.
        const all = [...known, ...extra];
        return all.includes(DEFAULT_CATEGORY) ? all : [DEFAULT_CATEGORY, ...all];
    },

    /** `[{ category, items }]` for display; empty categories are dropped. */
    grouped() {
        const all = this.getAll();
        return this.categories()
            .map((category) => ({ category, items: all.filter((p) => p.category === category) }))
            .filter((g) => g.items.length > 0);
    },

    /** Add a preset. Throws when the label, pattern, or the regex itself is bad. */
    add(label, pattern, category) {
        const name = String(label || '').trim();
        if (!name) throw new Error('Give the sample a name.');
        const src = String(pattern || '');
        if (!src.trim()) throw new Error('The pattern is empty.');
        // A sample that cannot compile is worse than no sample: it fails later,
        // in the search box, where the cause is no longer visible.
        try { new RegExp(src); }
        catch (e) { throw new Error(`Not a valid regular expression: ${e.message}`); }

        const item = {
            id: generateId(),
            label: name,
            pattern: src,
            category: normalizeCategory(category),
            builtin: false,
        };
        const list = readJson(USER_KEY, []);
        list.push(item);
        writeJson(USER_KEY, list);
        return item;
    },

    /** Remove one. A built-in is hidden rather than destroyed. */
    remove(id) {
        if (String(id).startsWith('b:')) {
            if (!BUILTIN_PRESETS.some((p) => p.id === id)) return false;
            const hidden = new Set(readJson(HIDDEN_KEY, []));
            if (hidden.has(id)) return false;
            hidden.add(id);
            writeJson(HIDDEN_KEY, [...hidden]);
            return true;
        }
        const list = readJson(USER_KEY, []);
        const next = list.filter((p) => p.id !== id);
        if (next.length === list.length) return false;
        writeJson(USER_KEY, next);
        return true;
    },

    /** Bring a hidden built-in back. */
    restore(id) {
        const hidden = new Set(readJson(HIDDEN_KEY, []));
        if (!hidden.delete(id)) return false;
        writeJson(HIDDEN_KEY, [...hidden]);
        return true;
    },

    /** Move a preset to another category. Built-ins can be re-filed too. */
    setCategory(id, category) {
        if (String(id).startsWith('b:')) {
            const builtin = BUILTIN_PRESETS.find((p) => p.id === id);
            if (!builtin) return false;
            // Re-filing a built-in is stored as a user copy of it, and the
            // original is hidden — the shipped array itself is never mutated.
            const list = readJson(USER_KEY, []);
            list.push({ ...builtin, id: generateId(), category: normalizeCategory(category), builtin: false });
            writeJson(USER_KEY, list);
            const hidden = new Set(readJson(HIDDEN_KEY, []));
            hidden.add(id);
            writeJson(HIDDEN_KEY, [...hidden]);
            return true;
        }
        const list = readJson(USER_KEY, []);
        const item = list.find((p) => p.id === id);
        if (!item) return false;
        item.category = normalizeCategory(category);
        writeJson(USER_KEY, list);
        return true;
    },
};

export default RegexPresets;
