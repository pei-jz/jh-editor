import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

const editor = read('src/modules/core/Editor.js');
const app = read('src/modules/core/App.js');

/** The body of a function, from its declaration to the first column-0 close. */
const fnBody = (src, decl) => {
    const i = src.indexOf(decl);
    expect(i, decl).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf('\n}', i));
};

/* Four ways to lose work, all of them reachable in an ordinary day: a save that
   overwrote someone else's changes, a watcher that only ever looked at one tab,
   a reload prompt that did not mention it was about to discard your edits, and
   a close dialog whose only way forward was to throw the work away. */

describe('saving over a file that changed underneath', () => {
    it('checks the disk before writing, not after', () => {
        const save = fnBody(editor, 'export async function saveCurrentFile()');
        const guard = save.indexOf('confirmOverwrite(file)');
        const write = save.indexOf('FS.writeFile(file.path');
        expect(guard, 'no overwrite check at all').toBeGreaterThan(-1);
        expect(guard).toBeLessThan(write);
    });

    it('compares content, not just the timestamp', () => {
        const fn = fnBody(editor, 'export async function confirmOverwrite(file)');
        // Touching a file, or a tool that rewrites identical bytes, must not
        // produce a prompt.
        expect(fn).toContain('if (disk === file.content)');
        // The same one-second slack the watcher uses; filesystems round mtimes.
        expect(fn).toContain('now > seen + 1000');
    });

    // A save that refuses to run because a comparison failed is worse than one
    // that goes ahead: the edit is in memory only, and the user asked to keep it.
    it('lets the save through when it cannot tell', () => {
        const fn = fnBody(editor, 'export async function confirmOverwrite(file)');
        expect(fn).toContain('if (!file || !file.path || !file.stats || !file.stats.mtime) return true;');
        expect(fn).toContain('catch (_) { return true; }');
    });
});

describe('watching what is open', () => {
    // One watcher followed the ACTIVE tab and unwatched whatever it was on
    // before, so every background buffer was invisible: changed on disk, still
    // stale in its tab, and written straight back over the change on save.
    it('keeps one watcher per open path instead of one in total', () => {
        expect(editor).toContain('const watchers = new Map();');
        expect(editor).not.toContain('let activeUnwatch = null;');

        const fn = fnBody(editor, 'export async function syncWatchers()');
        expect(fn).toContain('State.openFiles');
        expect(fn).toContain('State.rightOpenFiles');
        expect(fn).toContain('watchers.delete(path)');
    });

    // Two calls in the same tick both saw "not watched" and started a second
    // watcher on the same file.
    it('reserves the slot before awaiting', () => {
        const fn = fnBody(editor, 'export async function syncWatchers()');
        const reserve = fn.indexOf('watchers.set(f.path, () => {});');
        const create = fn.indexOf('await watchFile(f)');
        expect(reserve).toBeGreaterThan(-1);
        expect(reserve).toBeLessThan(create);
    });

    it('still answers the old call shape', () => {
        expect(editor).toContain('export async function setupWatcher(_file)');
    });
});

describe('the reload prompt', () => {
    // "Reload?" was all it said. The one thing the reader needed to know was
    // the one thing it did not mention.
    it('says what a dirty buffer is about to lose', () => {
        const fn = fnBody(editor, 'async function watchFile(file)');
        expect(fn).toContain('file.isDirty');
        expect(fn).toContain('Reloading replaces your edits');
        expect(fn).toContain('Keep my edits');
    });

    it('still asks the plain question when there is nothing to lose', () => {
        const fn = fnBody(editor, 'async function watchFile(file)');
        expect(fn).toContain('has changed on disk. Reload it?');
    });
});

describe('closing with unsaved work', () => {
    it('offers to save the tab, not only to discard it', () => {
        const i = editor.indexOf('if (file.isDirty && !isVirtualTab)');
        const block = editor.slice(i, editor.indexOf('openFiles.splice(index, 1);', i));
        expect(block).toContain("{ label: 'Save and close', value: 'save', primary: true }");
        expect(block).toContain("value: 'discard'");
        expect(block).toContain("value: 'cancel'");
        // saveCurrentFile works on the ACTIVE file, so closing a background tab
        // must front it first or it saves the wrong buffer.
        expect(block).toContain('setPaneActiveIndex(pane, index);');
        // A save that did not happen must not be followed by a close.
        expect(block).toContain('if (file.isDirty) return;');
    });

    it('offers to save everything on quit', () => {
        const i = app.indexOf('appWindow.onCloseRequested');
        const block = app.slice(i, app.indexOf('\n        });', i));
        expect(block).toContain("{ label: 'Save all and quit', value: 'save', primary: true }");
        expect(block).toContain('saveAllDirty(dirty)');
        // Quitting after a failed save loses exactly the work the user just
        // asked to keep.
        expect(block).toContain('if (failed.length)');
        expect(block).toContain('Nothing was closed.');
    });

    it('counts the split pane too, and names the files', () => {
        const i = app.indexOf('appWindow.onCloseRequested');
        const block = app.slice(i, app.indexOf('\n        });', i));
        expect(block).toContain('State.rightOpenFiles');
        expect(block).toContain('names.slice(0, 6)');
        expect(block).not.toContain('You have unsaved changes.');
    });

    // Saving them in place would write the front file's text once per buffer.
    it('fronts each file before saving it', () => {
        const fn = fnBody(app, 'async function saveAllDirty(dirty)');
        expect(fn).toContain('setPaneActiveIndex(pane, index)');
        expect(fn).toContain('await saveCurrentFile()');
        expect(fn).toContain('failed.push');
    });
});

/* Mixed chrome reads as unfinished. The prompts sent to the model are a
   different thing: they decide the language of the ANSWERS, which is a product
   setting, not interface text. */
describe('one language in the interface', () => {
    const JA = /[぀-ヿ一-鿿]/;

    const uiFiles = [
        'src/modules/ui/SelectionActions.js',
        'src/modules/ui/MermaidHelper.js',
        'src/modules/ui/InlineAI.js',
        'src/modules/ai/TaskNotificationPanel.js',
        'src/modules/ai/JhAiActivityPanel.js',
        'src/modules/utils/DailyNotes.js',
        'src/modules/core/Editor.js',
        'src/modules/core/App.js',
    ];

    /** Lines that are neither comments nor a prompt/instruction to the model. */
    const chromeLines = (src) => src.split('\n').filter((line) => {
        const t = line.trim();
        if (!JA.test(line)) return false;
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
        if (/(instruction|prompt|formatRule|systemPrompt)\s*[:=]/.test(t)) return false;
        if (/font(String|-family|Family)|BIZ UD|Meiryo|Gothic|Mincho/i.test(t)) return false;
        return true;
    });

    for (const rel of uiFiles) {
        it(`has no Japanese chrome left in ${rel.split('/').pop()}`, () => {
            const left = chromeLines(read(rel));
            expect(left, left.join('\n')).toEqual([]);
        });
    }

    // The point is that the AI still answers in Japanese; the prompts are why.
    it('leaves the model prompts alone', () => {
        const sel = read('src/modules/ui/SelectionActions.js');
        expect(sel).toMatch(/instruction: '[^']*[぀-ヿ一-鿿]/);
        expect(read('src/modules/ai/JhAiMcp.js'))
            .toMatch(/instruction: '[^']*[぀-ヿ一-鿿]/);
    });
});
