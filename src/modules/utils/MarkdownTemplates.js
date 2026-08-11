// Markdown templates for new files.
// The Blank built-in is always available; other built-ins can be hidden by the
// user ("deleted" from the picker). User templates are persisted in
// localStorage and can be registered / deleted from the Settings modal or the
// New File modal.

const STORAGE_KEY = 'settings_markdownTemplates';
const HIDDEN_KEY = 'settings_markdownTemplates_hiddenBuiltin';

export const BUILTIN_TEMPLATES = [
    {
        id: 'builtin:blank',
        name: 'Blank',
        builtin: true,
        content: '',
    },
    {
        id: 'builtin:meeting',
        name: 'Meeting Notes',
        builtin: true,
        content: [
            '# Meeting Notes',
            '',
            '- Date: ',
            '- Attendees: ',
            '',
            '## Agenda',
            '',
            '1. ',
            '',
            '## Notes',
            '',
            '',
            '',
            '## Action Items',
            '',
            '- [ ] ',
            '',
        ].join('\n'),
    },
    {
        id: 'builtin:daily',
        name: 'Daily Report',
        builtin: true,
        content: [
            '# Daily Report',
            '',
            '- Date: ',
            '- Name: ',
            '',
            '## Done Today',
            '',
            '- ',
            '',
            '## Plan for Tomorrow',
            '',
            '- ',
            '',
            '## Blockers / Notes',
            '',
            '- ',
            '',
        ].join('\n'),
    },
    {
        id: 'builtin:spec',
        name: 'Specification',
        builtin: true,
        content: [
            '# Title',
            '',
            '## Overview',
            '',
            '',
            '',
            '## Requirements',
            '',
            '- ',
            '',
            '## Design',
            '',
            '',
            '',
            '## Tasks',
            '',
            '- [ ] ',
            '',
        ].join('\n'),
    },
];

function generateId() {
    return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const MarkdownTemplates = {
    /**
     * Visible templates: built-ins the user has not deleted, then the
     * user-registered ones. Blank can never be removed.
     */
    getAll() {
        const hidden = this._getHiddenBuiltinIds();
        return [...BUILTIN_TEMPLATES.filter(t => !hidden.includes(t.id)), ...this.getUserTemplates()];
    },

    /** Built-in templates the user deleted (hidden from the picker). */
    getHiddenBuiltinTemplates() {
        const hidden = this._getHiddenBuiltinIds();
        return BUILTIN_TEMPLATES.filter(t => hidden.includes(t.id));
    },

    /** User-registered templates read from localStorage (never throws). */
    getUserTemplates() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(t => t && typeof t.name === 'string' && typeof t.content === 'string');
        } catch (e) {
            console.warn('MarkdownTemplates: failed to parse stored templates', e);
            return [];
        }
    },

    /**
     * Register a new user template. Returns the stored template (with id).
     * Throws when name/content are empty.
     */
    add(name, content) {
        const trimmedName = (name || '').trim();
        if (!trimmedName) throw new Error('Template name is required.');
        if (!content || !content.trim()) throw new Error('Template content is empty.');
        const templates = this.getUserTemplates();
        const template = { id: generateId(), name: trimmedName, content, builtin: false };
        templates.push(template);
        this._save(templates);
        return template;
    },

    /**
     * Delete a template by id. User templates are removed from storage;
     * built-ins (except Blank, which must stay) are hidden instead.
     */
    remove(id) {
        const tpl = this.getById(id);
        if (tpl && tpl.builtin) {
            if (tpl.id === 'builtin:blank') return false; // Blank is not deletable.
            const hidden = this._getHiddenBuiltinIds();
            if (hidden.includes(id)) return false;
            hidden.push(id);
            this._saveHidden(hidden);
            return true;
        }
        const templates = this.getUserTemplates();
        const next = templates.filter(t => t.id !== id);
        if (next.length === templates.length) return false;
        this._save(next);
        return true;
    },

    /** Bring back a previously deleted built-in template. */
    restoreBuiltin(id) {
        const hidden = this._getHiddenBuiltinIds().filter(h => h !== id);
        this._saveHidden(hidden);
    },

    /** Look up any template (built-in or user, visible or hidden) by id. */
    getById(id) {
        if (!id) return null;
        return BUILTIN_TEMPLATES.find(t => t.id === id)
            || this.getUserTemplates().find(t => t.id === id)
            || null;
    },

    /** True when the id belongs to a user template. */
    isUserTemplate(id) {
        return this.getUserTemplates().some(t => t.id === id);
    },

    /**
     * True when the template can be deleted from the picker — everything
     * except the Blank built-in.
     */
    isDeletable(id) {
        const tpl = this.getById(id);
        if (!tpl) return false;
        return !(tpl.builtin && tpl.id === 'builtin:blank');
    },

    _getHiddenBuiltinIds() {
        try {
            const raw = localStorage.getItem(HIDDEN_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
        } catch (e) {
            console.warn('MarkdownTemplates: failed to parse hidden built-ins', e);
            return [];
        }
    },

    _save(templates) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
    },

    _saveHidden(ids) {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
    },
};
