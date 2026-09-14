import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { State } from '../src/modules/core/Store.js';
import {
    scheduleSessionSave, flushSession, saveDrafts, loadDrafts,
} from '../src/modules/core/Session.js';

const DRAFTS_KEY = 'jh_drafts_v1';

/** Keys written to localStorage while `fn` runs. */
function keysWrittenBy(fn) {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    try {
        fn();
        return spy.mock.calls.map((c) => c[0]);
    } finally {
        spy.mockRestore();
    }
}

describe('flushSession({ onlyPending })', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        State.currentDir = '/ws/alpha';
        State.openFiles = [{ path: '/ws/alpha/a.md', content: 'unsaved', isDirty: true }];
        State.rightOpenFiles = [];
        saveDrafts(); // start from "drafts are up to date"
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('skips rewriting drafts when nothing changed since the last write', () => {
        // Hiding the window (switching apps) must not re-serialise every
        // unsaved buffer each time.
        const keys = keysWrittenBy(() => flushSession({ onlyPending: true }));
        expect(keys).not.toContain(DRAFTS_KEY);
    });

    it('writes drafts once an edit has been scheduled', () => {
        State.openFiles[0].content = 'unsaved, and then some';
        scheduleSessionSave();
        const keys = keysWrittenBy(() => flushSession({ onlyPending: true }));
        expect(keys).toContain(DRAFTS_KEY);
        expect(loadDrafts()['/ws/alpha/a.md'].content).toBe('unsaved, and then some');
    });

    it('a plain flush (window close) always writes drafts', () => {
        const keys = keysWrittenBy(() => flushSession());
        expect(keys).toContain(DRAFTS_KEY);
    });
});
