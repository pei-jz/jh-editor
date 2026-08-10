import { describe, it, expect, beforeEach, vi } from 'vitest';
import { State } from '../src/modules/core/Store.js';
import {
    saveSession, loadSession, clearSession,
    saveDrafts, loadDrafts, dropDraft, clearDrafts,
    suspend, resume, flushSession, setEnabled, isEnabled,
    scheduleSessionSave,
} from '../src/modules/core/Session.js';

const reset = () => {
    localStorage.clear();
    State.currentDir = '/ws/alpha';
    State.openFiles = [];
    State.rightOpenFiles = [];
    State.activeTabIndex = -1;
    State.rightActiveTabIndex = -1;
    State.splitMode = false;
    setEnabled(true);
};

const mkFile = (over = {}) => ({
    path: '/ws/alpha/a.md',
    name: 'a.md',
    content: 'hello',
    encoding: 'UTF-8',
    eol: '\n',
    isDirty: false,
    ...over,
});

describe('Session — open tabs', () => {
    beforeEach(reset);

    it('round-trips the open tabs for the current workspace', () => {
        State.openFiles = [mkFile(), mkFile({ path: '/ws/alpha/b.txt', name: 'b.txt' })];
        State.activeTabIndex = 1;
        saveSession();

        const s = loadSession();
        expect(s.left.map(e => e.path)).toEqual(['/ws/alpha/a.md', '/ws/alpha/b.txt']);
        expect(s.activeIndex).toBe(1);
    });

    it('scopes sessions per workspace', () => {
        State.openFiles = [mkFile()];
        saveSession();

        State.currentDir = '/ws/beta';
        expect(loadSession()).toBeNull();

        State.openFiles = [mkFile({ path: '/ws/beta/z.md' })];
        saveSession();
        expect(loadSession().left[0].path).toBe('/ws/beta/z.md');

        // The first workspace is untouched.
        State.currentDir = '/ws/alpha';
        expect(loadSession().left[0].path).toBe('/ws/alpha/a.md');
    });

    it('excludes virtual tabs that have no file on disk', () => {
        State.openFiles = [
            mkFile(),
            { path: 'search://results-1', type: 'search-results', content: '' },
            { path: '/x/diff', viewMode: 'diff', content: '' },
            { path: 'ai://out.md', content: '' },
            { path: null, name: 'Untitled.txt', content: 'draft' },
        ];
        saveSession();
        expect(loadSession().left.map(e => e.path)).toEqual(['/ws/alpha/a.md']);
    });

    it('clearSession removes only the current workspace', () => {
        State.openFiles = [mkFile()];
        saveSession();
        clearSession();
        expect(loadSession()).toBeNull();
    });
});

describe('Session — drafts (crash recovery)', () => {
    beforeEach(reset);

    it('stores content only for dirty buffers', () => {
        State.openFiles = [
            mkFile({ isDirty: false, content: 'clean' }),
            mkFile({ path: '/ws/alpha/dirty.md', isDirty: true, content: 'unsaved!' }),
        ];
        saveDrafts();

        const d = loadDrafts();
        expect(d['/ws/alpha/a.md']).toBeUndefined();
        expect(d['/ws/alpha/dirty.md'].content).toBe('unsaved!');
    });

    it('keeps untitled buffers, which have no disk copy at all', () => {
        const untitled = { name: 'Untitled.txt', path: null, content: 'notes', isDirty: true };
        State.openFiles = [untitled];
        saveDrafts();

        const d = loadDrafts();
        const entry = Object.values(d)[0];
        expect(entry.content).toBe('notes');
        expect(entry.path).toBeNull();
        expect(entry.workspace).toBe('/ws/alpha');
    });

    it('dropDraft forgets a buffer once it has been saved', () => {
        const f = mkFile({ isDirty: true, content: 'x' });
        State.openFiles = [f];
        saveDrafts();
        expect(loadDrafts()['/ws/alpha/a.md']).toBeDefined();

        dropDraft(f);
        expect(loadDrafts()['/ws/alpha/a.md']).toBeUndefined();
    });

    it('skips buffers too large to persist safely', () => {
        const huge = 'x'.repeat(2 * 1024 * 1024 + 10);
        State.openFiles = [mkFile({ isDirty: true, content: huge })];
        saveDrafts();
        expect(Object.keys(loadDrafts())).toHaveLength(0);
    });

    it('skips backend-backed large files (content is not in memory)', () => {
        State.openFiles = [mkFile({ isDirty: true, isLarge: true, content: '' })];
        saveDrafts();
        expect(Object.keys(loadDrafts())).toHaveLength(0);
    });
});

describe('Session — suspend/resume', () => {
    beforeEach(reset);

    it('does not overwrite a saved session while suspended', () => {
        State.openFiles = [mkFile()];
        saveSession();

        // Simulates switchProject(): tabs are closed before currentDir moves.
        suspend();
        State.openFiles = [];
        saveSession();
        expect(loadSession().left).toHaveLength(1); // preserved

        resume();
        saveSession();
        expect(loadSession().left).toHaveLength(0); // now it applies
    });

    it('is re-entrant', () => {
        State.openFiles = [mkFile()];
        saveSession();

        suspend();
        suspend();
        resume();
        State.openFiles = [];
        saveSession();
        expect(loadSession().left).toHaveLength(1); // still suspended

        resume();
        saveSession();
        expect(loadSession().left).toHaveLength(0);
    });
});

describe('Session — persistence failures are non-fatal', () => {
    beforeEach(reset);

    it('survives a localStorage quota error', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        State.openFiles = [mkFile({ isDirty: true })];
        expect(() => flushSession()).not.toThrow();
        spy.mockRestore();
    });

    it('tolerates corrupted stored JSON', () => {
        localStorage.setItem('jh_session_v1', '{not json');
        localStorage.setItem('jh_drafts_v1', 'garbage');
        expect(loadSession()).toBeNull();
        expect(loadDrafts()).toEqual({});
    });
});

describe('Session — scheduling & toggles', () => {
    beforeEach(() => {
        reset();
        vi.useFakeTimers();
    });

    it('debounces the writes instead of persisting on every keystroke', () => {
        State.openFiles = [mkFile({ isDirty: true, content: 'typing' })];
        scheduleSessionSave();
        // Nothing written yet — both timers are still pending.
        expect(localStorage.getItem('jh_session_v1')).toBeNull();

        vi.advanceTimersByTime(500);   // session timer (400ms)
        expect(loadSession().left).toHaveLength(1);

        vi.advanceTimersByTime(1000);  // draft timer (1200ms total)
        expect(loadDrafts()['/ws/alpha/a.md'].content).toBe('typing');
        vi.useRealTimers();
    });

    it('coalesces rapid calls into a single write', () => {
        State.openFiles = [mkFile({ isDirty: true })];
        const spy = vi.spyOn(Storage.prototype, 'setItem');
        for (let i = 0; i < 20; i++) scheduleSessionSave();
        vi.advanceTimersByTime(2000);
        // 2 writes total (session + drafts), not 40.
        expect(spy.mock.calls.filter(c => c[0].startsWith('jh_')).length).toBe(2);
        spy.mockRestore();
        vi.useRealTimers();
    });

    it('does not schedule anything while suspended', () => {
        suspend();
        State.openFiles = [mkFile({ isDirty: true })];
        scheduleSessionSave();
        vi.advanceTimersByTime(2000);
        expect(localStorage.getItem('jh_session_v1')).toBeNull();
        resume();
        vi.useRealTimers();
    });

    it('flushSession() writes immediately and cancels pending timers', () => {
        State.openFiles = [mkFile({ isDirty: true, content: 'x' })];
        scheduleSessionSave();
        flushSession();
        expect(loadSession().left).toHaveLength(1);
        expect(loadDrafts()['/ws/alpha/a.md']).toBeDefined();

        // The cancelled timers must not fire a second write.
        const spy = vi.spyOn(Storage.prototype, 'setItem');
        vi.advanceTimersByTime(3000);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        vi.useRealTimers();
    });

    it('setEnabled(false) disables persistence entirely', () => {
        vi.useRealTimers();
        setEnabled(false);
        expect(isEnabled()).toBe(false);
        State.openFiles = [mkFile({ isDirty: true })];
        flushSession();
        expect(localStorage.getItem('jh_session_v1')).toBeNull();
        setEnabled(true);
        expect(isEnabled()).toBe(true);
    });

    it('clearDrafts() empties the store', () => {
        vi.useRealTimers();
        State.openFiles = [mkFile({ isDirty: true })];
        saveDrafts();
        expect(Object.keys(loadDrafts())).toHaveLength(1);
        clearDrafts();
        expect(loadDrafts()).toEqual({});
    });

    it('dropDraft ignores unknown or null buffers', () => {
        vi.useRealTimers();
        expect(() => dropDraft(null)).not.toThrow();
        expect(() => dropDraft({ path: '/nope.md' })).not.toThrow();
    });
});
