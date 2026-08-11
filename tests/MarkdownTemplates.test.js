import { describe, it, expect, beforeEach } from 'vitest';
import { MarkdownTemplates, BUILTIN_TEMPLATES } from '../src/modules/utils/MarkdownTemplates.js';

const STORAGE_KEY = 'settings_markdownTemplates';

describe('MarkdownTemplates', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('always returns the built-in templates first', () => {
        const all = MarkdownTemplates.getAll();
        expect(all.length).toBeGreaterThanOrEqual(BUILTIN_TEMPLATES.length);
        expect(all.slice(0, BUILTIN_TEMPLATES.length).map(t => t.id))
            .toEqual(BUILTIN_TEMPLATES.map(t => t.id));
        // The blank template must exist so the user can still start empty.
        expect(all[0].content).toBe('');
    });

    it('starts with no user templates', () => {
        expect(MarkdownTemplates.getUserTemplates()).toEqual([]);
    });

    it('adds a user template and persists it to localStorage', () => {
        const saved = MarkdownTemplates.add('Weekly', '# Weekly\n\n- ');
        expect(saved.id).toBeTruthy();
        expect(saved.name).toBe('Weekly');
        expect(saved.builtin).toBe(false);

        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
        expect(stored).toHaveLength(1);
        expect(stored[0].id).toBe(saved.id);

        // getAll now lists built-ins + the new one.
        const all = MarkdownTemplates.getAll();
        expect(all).toHaveLength(BUILTIN_TEMPLATES.length + 1);
        expect(all[all.length - 1].id).toBe(saved.id);
    });

    it('trims the template name and rejects empty name/content', () => {
        const saved = MarkdownTemplates.add('  Padded  ', 'x');
        expect(saved.name).toBe('Padded');
        expect(() => MarkdownTemplates.add('   ', 'x')).toThrow();
        expect(() => MarkdownTemplates.add('Name', '   ')).toThrow();
        expect(() => MarkdownTemplates.add('Name', '')).toThrow();
        // Nothing was persisted by the failed attempts.
        expect(MarkdownTemplates.getUserTemplates()).toHaveLength(1);
    });

    it('removes a user template by id and reports unknown ids', () => {
        const a = MarkdownTemplates.add('A', 'a');
        const b = MarkdownTemplates.add('B', 'b');
        expect(MarkdownTemplates.remove(a.id)).toBe(true);
        expect(MarkdownTemplates.getUserTemplates().map(t => t.id)).toEqual([b.id]);
        expect(MarkdownTemplates.remove('no-such-id')).toBe(false);
    });

    it('cannot remove the Blank built-in template', () => {
        expect(MarkdownTemplates.remove('builtin:blank')).toBe(false);
        expect(MarkdownTemplates.getAll().some(t => t.id === 'builtin:blank')).toBe(true);
    });

    it('hides a non-blank built-in on remove and can restore it', () => {
        const id = 'builtin:meeting';
        expect(MarkdownTemplates.getAll().some(t => t.id === id)).toBe(true);
        expect(MarkdownTemplates.remove(id)).toBe(true);
        // Gone from the picker, but still resolvable by id and listed as hidden.
        expect(MarkdownTemplates.getAll().some(t => t.id === id)).toBe(false);
        expect(MarkdownTemplates.getById(id)).toBeTruthy();
        expect(MarkdownTemplates.getHiddenBuiltinTemplates().map(t => t.id)).toEqual([id]);
        // Removing again is a no-op.
        expect(MarkdownTemplates.remove(id)).toBe(false);

        MarkdownTemplates.restoreBuiltin(id);
        expect(MarkdownTemplates.getAll().some(t => t.id === id)).toBe(true);
        expect(MarkdownTemplates.getHiddenBuiltinTemplates()).toEqual([]);
    });

    it('isDeletable allows everything except the Blank built-in', () => {
        const user = MarkdownTemplates.add('D', 'd');
        expect(MarkdownTemplates.isDeletable(user.id)).toBe(true);
        expect(MarkdownTemplates.isDeletable('builtin:meeting')).toBe(true);
        expect(MarkdownTemplates.isDeletable('builtin:blank')).toBe(false);
        expect(MarkdownTemplates.isDeletable('missing')).toBe(false);
    });

    it('looks up templates by id across built-ins and user templates', () => {
        const user = MarkdownTemplates.add('Mine', 'body');
        expect(MarkdownTemplates.getById(BUILTIN_TEMPLATES[0].id).name).toBe('Blank');
        expect(MarkdownTemplates.getById(user.id).content).toBe('body');
        expect(MarkdownTemplates.getById('missing')).toBeNull();
        expect(MarkdownTemplates.getById(null)).toBeNull();
    });

    it('distinguishes user templates from built-ins', () => {
        const user = MarkdownTemplates.add('U', 'u');
        expect(MarkdownTemplates.isUserTemplate(user.id)).toBe(true);
        expect(MarkdownTemplates.isUserTemplate(BUILTIN_TEMPLATES[0].id)).toBe(false);
    });

    it('survives corrupted localStorage data', () => {
        localStorage.setItem(STORAGE_KEY, '{not json');
        expect(MarkdownTemplates.getUserTemplates()).toEqual([]);
        localStorage.setItem(STORAGE_KEY, '{"a":1}');
        expect(MarkdownTemplates.getUserTemplates()).toEqual([]);
        // Entries missing name/content are filtered out.
        localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'x' }, { name: 'ok', content: 'c' }]));
        expect(MarkdownTemplates.getUserTemplates()).toHaveLength(1);
    });
});
