import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const invoke = vi.fn(async () => null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/path', () => ({ appConfigDir: async () => 'C:/cfg' }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

const Notes = await import('../src/modules/utils/Notes.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/* Quick notes used to live in localStorage and could only be edited inside
   their own modal — no highlighting, no block view, no outline, no split, no
   search, no file on disk. Daily notes had been real files since they were
   added, for exactly the reasons the quick ones were missing out on. So both
   are files now, and this covers the move. */

const call = (name) => invoke.mock.calls.filter(([c]) => c === name);

describe('the day a daily note belongs to', () => {
    it('is the LOCAL date, because a journal is kept in local days', () => {
        // 23:30 on the 17th is the 17th, wherever the machine is. Built from a
        // local-time Date so the test does not depend on the runner's zone.
        expect(Notes.dayId(new Date(2026, 8, 17, 23, 30))).toBe('2026-09-17');
        expect(Notes.dayId(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
    });

    it('pads, so the names sort as dates', () => {
        expect(Notes.dayId(new Date(2026, 2, 3))).toBe('2026-03-03');
    });
});

describe('listing a notes folder', () => {
    beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue(null); });

    it('asks the backend once, not once per note', async () => {
        invoke.mockResolvedValue([{ path: 'a.md', name: 'a.md', size: 1, mtime: 1, title: 'A' }]);
        const rows = await Notes.listNotes('C:/cfg/notes/daily');
        expect(call('list_notes')).toHaveLength(1);
        expect(rows).toHaveLength(1);
    });

    // A folder that does not exist yet is not an error; it is a folder with no
    // notes in it. The browser must open on a fresh install.
    it('is empty rather than broken when there is nothing there', async () => {
        invoke.mockRejectedValue(new Error('not found'));
        await expect(Notes.listNotes('C:/nope')).resolves.toEqual([]);
        invoke.mockResolvedValue(null);
        await expect(Notes.listNotes('C:/nope')).resolves.toEqual([]);
    });
});

describe('bringing the old localStorage notes across', () => {
    const writes = () => call('write_file').map(([, a]) => a);

    beforeEach(() => {
        localStorage.clear();
        invoke.mockReset();
        invoke.mockImplementation(async (cmd) => (cmd === 'exists' ? false : null));
    });

    it('writes one file per note, content untouched', async () => {
        localStorage.setItem('jh_notes_v1', JSON.stringify([
            { id: 'note-aaa111', content: '# Shopping\n\n- milk', createdAt: Date.UTC(2026, 8, 10) },
        ]));
        expect(await Notes.migrateQuickNotes()).toBe(1);
        expect(writes()).toHaveLength(1);
        expect(writes()[0].content).toBe('# Shopping\n\n- milk');
        expect(writes()[0].path).toMatch(/\/notes\/quick\/.*\.md$/);
    });

    /* The originals stay. A migration that deletes on the way out has one
       chance to be right about every note, and this one runs unattended on an
       ordinary launch. Copying costs a duplicate; deleting costs the note. */
    it('never removes what it copied', async () => {
        const legacy = JSON.stringify([{ id: 'n1', content: 'keep me', createdAt: 1 }]);
        localStorage.setItem('jh_notes_v1', legacy);
        await Notes.migrateQuickNotes();
        expect(localStorage.getItem('jh_notes_v1')).toBe(legacy);
    });

    it('runs once, however many times it is called', async () => {
        localStorage.setItem('jh_notes_v1', JSON.stringify([{ id: 'n1', content: 'x', createdAt: 1 }]));
        expect(await Notes.migrateQuickNotes()).toBe(1);
        expect(await Notes.migrateQuickNotes()).toBe(0);
        expect(await Notes.migrateQuickNotes()).toBe(0);
        expect(writes()).toHaveLength(1);
    });

    it('leaves empty notes behind rather than making empty files', async () => {
        localStorage.setItem('jh_notes_v1', JSON.stringify([
            { id: 'n1', content: '   \n  ', createdAt: 1 },
            { id: 'n2', content: 'real', createdAt: 2 },
        ]));
        expect(await Notes.migrateQuickNotes()).toBe(1);
        expect(writes().map((w) => w.content)).toEqual(['real']);
    });

    it('marks itself done even with nothing to move, so it stops looking', async () => {
        expect(await Notes.migrateQuickNotes()).toBe(0);
        expect(Notes.quickNotesMigrated()).toBe(true);
    });

    // Oldest first, so the newest note is still the newest file afterwards.
    it('keeps the order the notes were written in', async () => {
        localStorage.setItem('jh_notes_v1', JSON.stringify([
            { id: 'new', content: 'newest', createdAt: Date.UTC(2026, 8, 17) },
            { id: 'old', content: 'oldest', createdAt: Date.UTC(2026, 8, 1) },
        ]));
        await Notes.migrateQuickNotes();
        expect(writes().map((w) => w.content)).toEqual(['oldest', 'newest']);
    });
});

/* A note's name is a real file's name. Quick notes used to be stamped with the
   time and nothing else, which is a fine fallback and a poor title. */
describe('naming a note', () => {
    it('keeps an ordinary name as it is', () => {
        expect(Notes.safeNoteName('meeting notes')).toBe('meeting notes');
        expect(Notes.safeNoteName('  設計メモ  ')).toBe('設計メモ');
    });

    it('does not let a name become a path', () => {
        expect(Notes.safeNoteName('a/b')).toBe('ab');
        // Real backslashes, built from the character so no escaping layer can
        // quietly turn this into a test of nothing.
        const bs = String.fromCharCode(92);
        expect(Notes.safeNoteName(`..${bs}..${bs}etc${bs}passwd`)).toBe('....etcpasswd');
        expect(Notes.safeNoteName('/')).toBe('');
    });

    it('drops the characters a filesystem refuses', () => {
        expect(Notes.safeNoteName('re: <plan> "v2"?|*')).toBe('re plan v2');
    });

    /* Windows drops trailing dots and spaces silently, so "notes." and "notes"
       would be one file wearing two names. */
    it('strips trailing dots and spaces', () => {
        expect(Notes.safeNoteName('notes.')).toBe('notes');
        expect(Notes.safeNoteName('notes   ')).toBe('notes');
    });

    // CON.md is still the console on Windows, extension or not.
    it('steps around the reserved device names', () => {
        expect(Notes.safeNoteName('con')).toBe('con_');
        expect(Notes.safeNoteName('LPT1')).toBe('LPT1_');
        expect(Notes.safeNoteName('console')).toBe('console');
    });

    it('takes the .md off rather than burying it in the name', () => {
        expect(Notes.safeNoteName('plan.md')).toBe('plan');
    });

    it('answers with nothing when nothing usable was typed', () => {
        expect(Notes.safeNoteName('')).toBe('');
        expect(Notes.safeNoteName('   ')).toBe('');
        expect(Notes.safeNoteName('???')).toBe('');
        expect(Notes.safeNoteName(null)).toBe('');
    });
});

describe('creating a named quick note', () => {
    beforeEach(() => {
        invoke.mockReset();
        invoke.mockImplementation(async (cmd) => (cmd === 'exists' ? false : null));
    });

    it('uses the name for the file', async () => {
        const path = await Notes.createQuick('body', 'release checklist');
        expect(path).toBe('C:/cfg/notes/quick/release checklist.md');
    });

    it('falls back to the time when no name was given', async () => {
        const path = await Notes.createQuick('body', '');
        expect(path).toMatch(/\/quick\/\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
    });

    // Creating gets a suffix because nobody named that file; renaming does not
    // (see below), because someone did.
    it('suffixes rather than overwriting a name already in use', async () => {
        invoke.mockImplementation(async (cmd, args) => {
            if (cmd === 'exists') return args.path === 'C:/cfg/notes/quick/plan.md';
            return null;
        });
        const path = await Notes.createQuick('', 'plan');
        expect(path).toBe('C:/cfg/notes/quick/plan-2.md');
    });
});

describe('renaming a note', () => {
    beforeEach(() => {
        invoke.mockReset();
        invoke.mockImplementation(async (cmd) => (cmd === 'exists' ? false : null));
    });

    it('moves the file, keeping it in its folder', async () => {
        const next = await Notes.renameNote('C:/cfg/notes/quick/old.md', 'new name');
        expect(next).toBe('C:/cfg/notes/quick/new name.md');
        expect(call('rename_file')[0][1]).toEqual({
            oldPath: 'C:/cfg/notes/quick/old.md',
            newPath: 'C:/cfg/notes/quick/new name.md',
        });
    });

    /* It REFUSES rather than suffixing. The user typed a specific name; saving
       it as "meeting-2" instead would be a different answer to the one they
       asked for, and they would not find out until they went looking. */
    it('refuses to write over a note that is already there', async () => {
        invoke.mockImplementation(async (cmd) => (cmd === 'exists' ? true : null));
        const res = await Notes.renameNote('C:/cfg/notes/quick/a.md', 'taken');
        expect(res).toEqual({ error: 'exists', path: 'C:/cfg/notes/quick/taken.md' });
        expect(call('rename_file')).toHaveLength(0);
    });

    it('does nothing when the name has not really changed', async () => {
        const res = await Notes.renameNote('C:/cfg/notes/quick/same.md', 'same');
        expect(res).toBe('C:/cfg/notes/quick/same.md');
        expect(call('rename_file')).toHaveLength(0);
    });

    it('does nothing when nothing usable was typed', async () => {
        expect(await Notes.renameNote('C:/cfg/notes/quick/a.md', '   ')).toBeNull();
        expect(await Notes.renameNote('C:/cfg/notes/quick/a.md', '/')).toBeNull();
        expect(call('rename_file')).toHaveLength(0);
    });

    it('reports a failure instead of pretending it worked', async () => {
        invoke.mockImplementation(async (cmd) => {
            if (cmd === 'exists') return false;
            if (cmd === 'rename_file') throw new Error('locked');
            return null;
        });
        const res = await Notes.renameNote('C:/cfg/notes/quick/a.md', 'b');
        expect(res.error).toBe('failed');
    });
});

/* Which list the browser opens on. Quick notes are what "my notes" means; a
   daily note is a particular day's page and you reach it by saying so. It used
   to open on Daily and to remember whichever tab was left showing, so an hour
   after glancing at the calendar you were still landing on it. */
describe('the browser opens on quick notes', () => {
    const src = read('src/modules/ui/NotesPanel.js');

    it('starts on quick every time, not on whatever was last used', () => {
        expect(src).toMatch(/let tab = 'quick';/);
        // Not module state: that is what made it survive between openings.
        expect(src).not.toMatch(/^let _tab/m);
    });

    it('puts the tab that opens first', () => {
        const line = src.split(String.fromCharCode(10))
            .find((l) => l.includes('tabs.append(mkTab('));
        expect(line.indexOf("'quick'")).toBeLessThan(line.indexOf("'daily'"));
    });

    // The three ways to a daily note, all of which are the user saying so.
    it('still reaches the daily notes when asked', () => {
        expect(src).toContain("mkTab('daily'");
        expect(src).toContain('DailyNotes.openToday()');
    });

    /* The filter box and the cursor row were module state too, so the panel
       came back holding a search from an hour ago over a list it had just
       re-read. Nothing survives an opening now. */
    it('keeps no list state between openings', () => {
        for (const stale of ['let _rows', 'let _focused']) {
            expect(src, stale).not.toContain(stale);
        }
    });
});

/* The panel is a PICKER now. What makes that true is that it has no editor of
   its own and hands every choice to openFile — vitest cannot run it that far
   (it ends in a real editor view), so the wiring is read. */
describe('the notes panel opens notes in the editor', () => {
    const src = read('src/modules/ui/NotesPanel.js');

    it('routes a chosen note through the normal open path', () => {
        expect(src).toContain('window.app?.openFile');
    });

    it('has stopped being an editor', () => {
        // The modal's own textarea, title field and preview are gone.
        for (const gone of ['notes-body-input', 'notes-title-input', 'notes-preview', 'renderMarkdown']) {
            expect(src, gone).not.toContain(gone);
        }
    });

    // The prose still mentions localStorage, because that is where the notes
    // used to be; what must be gone is any code that touches it.
    it('no longer keeps notes in localStorage', () => {
        expect(src).not.toMatch(/localStorage\.(get|set|remove)Item/);
        expect(src).not.toContain('jh_notes_v1');
    });
});

/* The confirmation the delete button asks for came up BEHIND the list it was
   asked from: the dialog overlay sat at z-index 100000 and the notes browser at
   100005. "Delete this note?" was on screen and unreachable. It was never only
   about notes — the command palette is 100010 and the AI panel 100004, so a
   dialog raised from any of them was under it. */
describe('a dialog is always on top of whatever asked for it', () => {
    const zOf = (text, sel) => {
        const at = text.indexOf(sel);
        if (at < 0) return null;
        const m = /z-index:\s*(\d+)/.exec(text.slice(at, at + 400));
        return m ? Number(m[1]) : null;
    };

    const dialogZ = zOf(read('src/modules/ui/Dialog.js'), '.app-dialog-overlay');
    const features = read('src/styles/features.css');

    it('outranks the notes browser it is asked from', () => {
        expect(dialogZ).toBeGreaterThan(zOf(features, '.notes-overlay'));
    });

    it('outranks every other overlay in the app', () => {
        // Whatever anyone sets next, this is the ceiling.
        const others = [];
        for (const file of ['src/styles/features.css', 'src/styles/csv.css',
            'src/styles/ai.css', 'src/styles/layout.css', 'src/styles/editor.css']) {
            for (const m of read(file).matchAll(/z-index:\s*(\d+)/g)) others.push(Number(m[1]));
        }
        expect(others.length).toBeGreaterThan(5);
        expect(dialogZ).toBeGreaterThan(Math.max(...others));
    });
});
