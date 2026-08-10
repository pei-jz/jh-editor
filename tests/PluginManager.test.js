import { describe, it, expect, beforeEach } from 'vitest';
import { PluginManager, pluginManager } from '../src/modules/core/PluginManager.js';

const A = class {};
const B = class {};

describe('PluginManager', () => {
    let pm;
    beforeEach(() => { pm = new PluginManager(); });

    it('starts empty', () => {
        expect(pm.getPlugins()).toEqual([]);
        expect(pm.resolve({ path: 'a.md' })).toBeNull();
    });

    it('defaults priority to 0', () => {
        pm.register({ id: 'x', viewClass: A, extensions: ['txt'], modes: ['text'] });
        expect(pm.getPlugins()[0].priority).toBe(0);
    });

    it('keeps plugins sorted by descending priority', () => {
        pm.register({ id: 'low', viewClass: A, extensions: ['txt'], modes: ['text'], priority: 1 });
        pm.register({ id: 'high', viewClass: B, extensions: ['txt'], modes: ['text'], priority: 10 });
        pm.register({ id: 'mid', viewClass: A, extensions: ['txt'], modes: ['text'], priority: 5 });
        expect(pm.getPlugins().map(p => p.id)).toEqual(['high', 'mid', 'low']);
    });

    it('resolves by file extension', () => {
        pm.register({ id: 'csv', viewClass: A, extensions: ['csv'], modes: ['structure'] });
        expect(pm.resolve({ path: '/w/data.CSV' }).id).toBe('csv');
        expect(pm.resolve({ path: '/w/data.txt' })).toBeNull();
    });

    it('falls back to file.name when there is no path', () => {
        pm.register({ id: 'csv', viewClass: A, extensions: ['csv'], modes: ['structure'] });
        expect(pm.resolve({ name: 'sheet.csv' }).id).toBe('csv');
    });

    it('honours the target mode', () => {
        pm.register({ id: 'struct', viewClass: A, extensions: ['json'], modes: ['structure'], priority: 10 });
        pm.register({ id: 'plain', viewClass: B, extensions: ['json'], modes: ['text'], priority: 1 });

        expect(pm.resolve({ path: 'a.json' }, 'structure').id).toBe('struct');
        expect(pm.resolve({ path: 'a.json' }, 'text').id).toBe('plain');
        // No mode → highest priority wins.
        expect(pm.resolve({ path: 'a.json' }).id).toBe('struct');
    });

    it('returns null when the mode has no matching plugin', () => {
        pm.register({ id: 'struct', viewClass: A, extensions: ['json'], modes: ['structure'] });
        expect(pm.resolve({ path: 'a.json' }, 'text')).toBeNull();
    });

    it('treats an unsaved/untitled buffer as markdown', () => {
        pm.register({ id: 'md', viewClass: A, extensions: ['md', 'markdown'], modes: ['structure'] });
        expect(pm.resolve({ path: '', name: '' }, 'structure').id).toBe('md');
        expect(pm.resolve({ path: 'notes.markdown' }, 'structure').id).toBe('md');
    });

    it('does not treat a named untitled file as markdown when it has another ext', () => {
        pm.register({ id: 'md', viewClass: A, extensions: ['md'], modes: ['structure'] });
        expect(pm.resolve({ path: 'a.txt' }, 'structure')).toBeNull();
    });

    it('exposes a shared singleton', () => {
        expect(pluginManager).toBeInstanceOf(PluginManager);
        expect(Array.isArray(pluginManager.getPlugins())).toBe(true);
    });
});
