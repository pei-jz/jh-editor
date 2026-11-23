import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    pinnedCount, partitionPinned, clampDropIndex, insertIndexFor, setPinnedInPlace,
    reorderInPlace, planTabRemoval,
} from '../src/modules/core/Panes.js';

/* Pinned tabs. The folder list tab looked like every other tab and got lost
   among them; a pinned tab sits at the front, set apart, and survives the
   bulk closes.

   One rule carries all of it: a pane's pinned tabs are its first tabs, in an
   unbroken run. The strip draws its divider after the run, the closes skip
   it, the session saves it in that order. What could break the rule without
   a failing build: a drag across the boundary, a move to the other pane, a
   restored session, a pin or unpin landing in the wrong place. */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const tab = (name, pinned = false) => (pinned ? { name, pinned: true } : { name });
const names = (files) => files.map((f) => (f.pinned ? `[${f.name}]` : f.name));

describe('the pinned run', () => {
    it('is counted from the front only', () => {
        expect(pinnedCount([tab('a', true), tab('b', true), tab('c')])).toBe(2);
        expect(pinnedCount([tab('a'), tab('b', true)])).toBe(0);
        expect(pinnedCount([])).toBe(0);
    });

    it('is put back together keeping each group’s order', () => {
        const files = [tab('a'), tab('b', true), tab('c'), tab('d', true)];
        partitionPinned(files);
        expect(names(files)).toEqual(['[b]', '[d]', 'a', 'c']);
    });
});

describe('pinning and unpinning', () => {
    it('moves a pinned tab to the end of the run, and an unpinned one to just after it', () => {
        const files = [tab('folder', true), tab('a'), tab('b'), tab('c')];
        expect(setPinnedInPlace(files, 2, true)).toBe(1);
        expect(names(files)).toEqual(['[folder]', '[b]', 'a', 'c']);

        expect(setPinnedInPlace(files, 0, false)).toBe(1);
        expect(names(files)).toEqual(['[b]', 'folder', 'a', 'c']);
        // Unpinned means the flag is gone, not false: the session writes it
        // only when set.
        expect('pinned' in files[1]).toBe(false);
    });

    it('leaves a tab that is already as asked where it is', () => {
        const files = [tab('a', true), tab('b')];
        expect(setPinnedInPlace(files, 1, false)).toBe(1);
        expect(setPinnedInPlace(files, 5, true)).toBe(-1);
        expect(names(files)).toEqual(['[a]', 'b']);
    });
});

describe('dragging and moving', () => {
    it('keeps a dragged tab inside its own group', () => {
        const files = [tab('p1', true), tab('p2', true), tab('a'), tab('b')];
        // An ordinary tab dropped in front of everything lands after the run.
        reorderInPlace(files, 3, clampDropIndex(files, 3, 0));
        expect(names(files)).toEqual(['[p1]', '[p2]', 'b', 'a']);
        // A pinned tab dropped at the far end stays the last pinned one.
        reorderInPlace(files, 0, clampDropIndex(files, 0, files.length));
        expect(names(files)).toEqual(['[p2]', '[p1]', 'b', 'a']);
    });

    it('puts a tab arriving from the other pane in its group there', () => {
        const dest = [tab('q', true), tab('x'), tab('y')];
        expect(insertIndexFor(dest, tab('p', true), null)).toBe(1);
        expect(insertIndexFor(dest, tab('p', true), 3)).toBe(1);
        expect(insertIndexFor(dest, tab('z'), 0)).toBe(1);
        expect(insertIndexFor(dest, tab('z'), null)).toBe(3);
    });
});

describe('closing', () => {
    it('Close Others and the rest pass over pinned tabs', () => {
        const files = [tab('folder', true), tab('a'), tab('b')];
        const keep = files[2];
        const plan = planTabRemoval(files, 2, (f) => f !== keep && !f.pinned);
        expect(names(plan.kept)).toEqual(['[folder]', 'b']);
        expect(plan.activeIndex).toBe(1);
    });

    it('is wired that way in the editor, and switching workspace still closes everything', () => {
        const editor = read('src/modules/core/Editor.js');
        expect(editor).toContain('(f) => f !== keep && !f.pinned');
        expect(editor).toContain('(f, i) => i > index && !f.pinned');
        expect(editor).toMatch(/!f\.isDirty && !f\.pinned/);
        expect(editor).toContain('closeAllTabs(false, { keepPinned: true })');
        expect(editor).toContain('closeAllTabs(true, { keepPinned: true })');
        // The workspace switch closes the pinned tabs too: they belong to the
        // workspace being left.
        expect(read('src/modules/core/App.js')).toMatch(/closed = await closeAllTabs\(\);/);
    });
});

describe('the editor', () => {
    const editor = read('src/modules/core/Editor.js');

    it('draws pinned tabs apart, with a pin where the close button was', () => {
        expect(editor).toContain("tab.classList.add('tab-pinned')");
        expect(editor).toContain("tab.classList.add('tab-pinned-last')");
        expect(editor).toContain("pin.classList.add('tab-pin-mark')");
        const css = read('src/styles/layout.css');
        expect(css).toContain(':root .tab.tab-pinned {');
        expect(css).toContain('.tab.tab-pinned-last::after');
    });

    it('offers Pin and Unpin on the tab menu', () => {
        expect(editor).toContain("t('Pin Tab')");
        expect(editor).toContain("t('Unpin Tab')");
        for (const lang of ['ja', 'ko', 'zh']) {
            const loc = read(`src/locales/${lang}.js`);
            for (const key of ['Pin Tab', 'Unpin Tab', 'Pin the Folder List tab when it opens']) {
                expect(loc, `${key} in ${lang}`).toContain(`'${key}':`);
            }
        }
    });

    it('bounds drags and moves to the tab’s group', () => {
        expect(editor).toContain('reorderInPlace(files, fromIndex, clampDropIndex(files, fromIndex, toIndex))');
        expect(editor).toContain('const at = insertIndexFor(destFiles, file, destIndex);');
    });

    it('opens the folder list tab pinned unless the setting says otherwise', () => {
        expect(editor).toContain('if (folderTabOpensPinned()) file.pinned = true;');
        expect(read('index.html')).toContain('id="folder-tab-pinned"');
        expect(read('src/modules/ui/SettingsModal.js')).toContain('setFolderTabOpensPinned(e.target.checked)');
    });

    it('keeps pins across a restart', () => {
        expect(read('src/modules/core/Session.js')).toContain('...(f.pinned ? { pinned: true } : {})');
        expect(editor).toContain('restorePins(State.openFiles, session.left);');
        expect(editor).toContain('restorePins(State.rightOpenFiles, session.right);');
    });
});

describe('the setting', () => {
    it('defaults to pinned, and remembers being turned off', async () => {
        const store = new Map();
        globalThis.localStorage = {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
        };
        try {
            const prefs = await import('../src/modules/utils/ExplorerPrefs.js');
            expect(prefs.folderTabOpensPinned()).toBe(true);
            prefs.setFolderTabOpensPinned(false);
            expect(prefs.folderTabOpensPinned()).toBe(false);
            prefs.setFolderTabOpensPinned(true);
            expect(prefs.folderTabOpensPinned()).toBe(true);
        } finally {
            delete globalThis.localStorage;
        }
    });
});
