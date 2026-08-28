import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* ── Why some of this file reads source and some of it runs code ────────────
   The guards below are ordinary functions, so they are CALLED: a test that
   greps for `if (disk === file.content)` passes whether or not the branch
   works, and one that greps a function body passes when the function is never
   reached. The Tab-accept bug proved that the hard way — every source-reading
   test was green while the feature was dead.

   What stays structural is what vitest cannot execute: CSS, Rust, the HTML
   markup, and the wiring between a DOM button and the module it calls. Those
   are checked by reading the file because there is nothing else to do. They are
   grouped at the bottom under that name so the distinction is visible. */

const readText = vi.fn();
const watchSpy = vi.fn();
const getFileStats = vi.fn();
const showConfirm = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
    readFile: (...a) => readText(...a),
    watch: (...a) => watchSpy(...a),
}));
vi.mock('../src/modules/utils/FileSystem.js', async (orig) => ({
    ...await orig(),
    getFileStats: (...a) => getFileStats(...a),
    readFileText: (...a) => readText(...a),
}));
vi.mock('../src/modules/ui/Dialog.js', () => ({
    showAlert: vi.fn(async () => true),
    showConfirm: (...a) => showConfirm(...a),
    showDialog: vi.fn(async () => 'cancel'),
}));

const { confirmOverwrite, syncWatchers } = await import('../src/modules/core/Editor.js');
const { State } = await import('../src/modules/core/Store.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

/** A file object as the editor holds one. */
const fileAt = (mtime, content = 'mine') => ({
    path: 'C:/proj/a.js', name: 'a.js', content, encoding: 'UTF-8',
    stats: { size: content.length, mtime },
});
/** readFileText hands back decoded text, not bytes. */
const onDisk = (t) => t;

const OLD = '2026-01-01T00:00:00.000Z';
const NEW = '2026-01-01T00:00:10.000Z';   // ten seconds later

beforeEach(async () => {
    // The watcher set is module state, so it outlives a test. Emptying the
    // panes and syncing is the module's own way of letting everything go —
    // no reaching inside, and it exercises the teardown path every time.
    State.openFiles = [];
    State.rightOpenFiles = [];
    await syncWatchers();

    readText.mockReset();
    watchSpy.mockReset();
    getFileStats.mockReset();
    showConfirm.mockReset();
    showConfirm.mockResolvedValue(true);
});

/* A save used to write over whatever was on disk. A `git pull`, another editor
   or a formatter all lost their work, silently. */
describe('confirmOverwrite', () => {
    it('asks before replacing a file that really changed', async () => {
        getFileStats.mockResolvedValue({ mtime: NEW });
        readText.mockResolvedValue(onDisk('someone else'));

        const file = fileAt(OLD);
        expect(await confirmOverwrite(file)).toBe(true);
        expect(showConfirm).toHaveBeenCalledOnce();
        expect(showConfirm.mock.calls[0][0]).toContain('changed on disk');
        // Saying yes accepts the new baseline, so the next save does not re-ask.
        expect(file.stats.mtime).toBe(NEW);
    });

    it('stops the save when the user keeps the disk copy', async () => {
        getFileStats.mockResolvedValue({ mtime: NEW });
        readText.mockResolvedValue(onDisk('someone else'));
        showConfirm.mockResolvedValue(false);

        const file = fileAt(OLD);
        expect(await confirmOverwrite(file)).toBe(false);
        // ...and the baseline is NOT moved, or the next attempt would sail past.
        expect(file.stats.mtime).toBe(OLD);
    });

    // Touching a file, or a tool that rewrites identical bytes, must not nag.
    it('says nothing when only the timestamp moved', async () => {
        getFileStats.mockResolvedValue({ mtime: NEW });
        readText.mockResolvedValue(onDisk('mine'));

        const file = fileAt(OLD, 'mine');
        expect(await confirmOverwrite(file)).toBe(true);
        expect(showConfirm).not.toHaveBeenCalled();
        expect(file.stats.mtime).toBe(NEW);
    });

    // Filesystems round mtimes, and our own write moves it moments earlier.
    it('allows a second of slack', async () => {
        getFileStats.mockResolvedValue({ mtime: '2026-01-01T00:00:00.500Z' });
        const file = fileAt(OLD);
        expect(await confirmOverwrite(file)).toBe(true);
        expect(showConfirm).not.toHaveBeenCalled();
        expect(readText).not.toHaveBeenCalled();
    });

    /* A save that refuses to run because a COMPARISON failed is worse than one
       that goes ahead: the edit exists only in memory, and the user asked to
       keep it. Every unknown resolves to "let it through". */
    it('lets the save through when it cannot tell', async () => {
        const cases = {
            'no stats recorded': async () => confirmOverwrite({ path: 'a', content: '' }),
            'no file at all': async () => confirmOverwrite(null),
            'stats unreadable': async () => {
                getFileStats.mockRejectedValue(new Error('EACCES'));
                return confirmOverwrite(fileAt(OLD));
            },
            'stats came back empty': async () => {
                getFileStats.mockResolvedValue(null);
                return confirmOverwrite(fileAt(OLD));
            },
            'content unreadable': async () => {
                getFileStats.mockResolvedValue({ mtime: NEW });
                readText.mockResolvedValue(null);   // readFileText's own answer
                return confirmOverwrite(fileAt(OLD));
            },
        };
        for (const [name, run] of Object.entries(cases)) {
            getFileStats.mockReset();
            readText.mockReset();
            showConfirm.mockClear();
            expect(await run(), name).toBe(true);
            expect(showConfirm, name).not.toHaveBeenCalled();
        }
    });
});

/* One watcher followed the ACTIVE tab and unwatched whatever it was on before,
   so every background buffer was invisible: changed on disk, still stale in its
   tab, and written straight back over the change on save. */
describe('syncWatchers', () => {
    const openFile = (path) => ({ path, name: path.split('/').pop(), content: '', stats: { mtime: OLD } });

    it('watches every open file, in both panes', async () => {
        const unwatch = vi.fn();
        watchSpy.mockResolvedValue(unwatch);
        State.openFiles = [openFile('C:/proj/a.js'), openFile('C:/proj/b.js')];
        State.rightOpenFiles = [openFile('C:/proj/c.js')];

        await syncWatchers();

        expect(watchSpy.mock.calls.map((c) => c[0]).sort())
            .toEqual(['C:/proj/a.js', 'C:/proj/b.js', 'C:/proj/c.js']);
    });

    it('drops the watcher when the tab closes', async () => {
        const unwatchA = vi.fn();
        const unwatchB = vi.fn();
        watchSpy.mockResolvedValueOnce(unwatchA).mockResolvedValueOnce(unwatchB);
        State.openFiles = [openFile('C:/proj/a.js'), openFile('C:/proj/b.js')];
        await syncWatchers();

        State.openFiles = [State.openFiles[1]];   // a.js closed
        await syncWatchers();

        expect(unwatchA).toHaveBeenCalledOnce();
        expect(unwatchB).not.toHaveBeenCalled();
    });

    it('does not start a second watcher on a file it already has', async () => {
        watchSpy.mockResolvedValue(vi.fn());
        State.openFiles = [openFile('C:/proj/a.js')];
        await syncWatchers();
        await syncWatchers();
        await syncWatchers();
        expect(watchSpy).toHaveBeenCalledOnce();
    });

    // Two calls in the same tick both saw "not watched" and each started one.
    it('survives being called twice before the first finishes', async () => {
        let release;
        watchSpy.mockReturnValue(new Promise((r) => { release = () => r(vi.fn()); }));
        State.openFiles = [openFile('C:/proj/a.js')];

        const both = Promise.all([syncWatchers(), syncWatchers()]);
        release();
        await both;
        expect(watchSpy).toHaveBeenCalledOnce();
    });

    it('ignores buffers with nothing on disk behind them', async () => {
        watchSpy.mockResolvedValue(vi.fn());
        State.openFiles = [
            { path: null, name: 'Untitled' },              // never saved
            { path: 'relative.txt', name: 'relative.txt' }, // not anchored yet
            { path: 'C:/proj/diff', type: 'diff' },         // a virtual tab
        ];
        await syncWatchers();
        expect(watchSpy).not.toHaveBeenCalled();
    });
});

/* ── Structural: things vitest cannot run ───────────────────────────────────
   CSS, Rust, HTML and the wiring between them. Read, because there is no way
   to execute them here — not because running them would be inconvenient. */
describe('structural', () => {
    const editor = read('src/modules/core/Editor.js');
    const app = read('src/modules/core/App.js');

    it('checks the disk before writing, not after', () => {
        const i = editor.indexOf('export async function saveCurrentFile()');
        const save = editor.slice(i, editor.indexOf('\n}', i));
        const guard = save.indexOf('confirmOverwrite(file)');
        const write = save.indexOf('FS.writeFile(file.path');
        expect(guard, 'no overwrite check at all').toBeGreaterThan(-1);
        expect(guard).toBeLessThan(write);
    });

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

    it('offers to save everything on quit, and names the files', () => {
        const i = app.indexOf('appWindow.onCloseRequested');
        const block = app.slice(i, app.indexOf('\n        });', i));
        expect(block).toContain("{ label: 'Save all and quit', value: 'save', primary: true }");
        expect(block).toContain('saveAllDirty(dirty)');
        expect(block).toContain('State.rightOpenFiles');
        expect(block).toContain('names.slice(0, 6)');
        // Quitting after a failed save loses exactly the work the user just
        // asked to keep.
        expect(block).toContain('if (failed.length)');
        expect(block).toContain('Nothing was closed.');
    });

    // Saving them in place would write the front file's text once per buffer.
    it('fronts each file before saving it', () => {
        const i = app.indexOf('async function saveAllDirty(dirty)');
        const fn = app.slice(i, app.indexOf('\n}', i));
        expect(fn).toContain('setPaneActiveIndex(pane, index)');
        expect(fn).toContain('await saveCurrentFile()');
        expect(fn).toContain('failed.push');
    });

    it('warns a dirty buffer what a reload costs it', () => {
        const i = editor.indexOf('async function watchFile(file)');
        const fn = editor.slice(i, editor.indexOf('\n}', i));
        expect(fn).toContain('file.isDirty');
        expect(fn).toContain('Reloading replaces your edits');
        expect(fn).toContain('Keep my edits');
        // ...and still asks the plain question when there is nothing to lose.
        expect(fn).toContain('has changed on disk. Reload it?');
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
        // Per-language prompt maps: `ja: '…'` inside an `{ en:…, ja:… }` block are
        // model prompts (they choose the answer's language), not interface chrome.
        if (/^(en|ja|zh|ko)\s*:/.test(t)) return false;
        if (/font(String|-family|Family)|BIZ UD|Meiryo|Gothic|Mincho/i.test(t)) return false;
        return true;
    });

    for (const rel of uiFiles) {
        it(`has no Japanese chrome left in ${rel.split('/').pop()}`, () => {
            const left = chromeLines(read(rel));
            expect(left, left.join('\n')).toEqual([]);
        });
    }

    // Prompts decide the language of the answers and now FOLLOW the UI language:
    // the Japanese instruction is one of the supported languages, not a hardcoded
    // default. The UI-language independence is what this is really asserting.
    it('keeps the model prompts language-aware', () => {
        expect(read('src/modules/ui/SelectionActions.js'))
            .toMatch(/ja:\s*'選択されたテキストを簡潔に要約/);
        expect(read('src/modules/ai/JhAiMcp.js'))
            .toMatch(/instruction:\s*'次の選択コード/);
    });
});

/* Windows keeps CRLF on disk; the buffer always holds LF. Comparing the two
   raw would differ on every line and claim every Windows file had been
   rewritten the moment its timestamp moved. */
describe('CRLF is not a change', () => {
    it('compares both sides in LF', async () => {
        getFileStats.mockResolvedValue({ mtime: NEW });
        readText.mockResolvedValue('a\r\nb\r\nc');

        const file = fileAt(OLD, 'a\nb\nc');
        file.eol = '\r\n';
        expect(await confirmOverwrite(file)).toBe(true);
        expect(showConfirm).not.toHaveBeenCalled();
    });

    it('still notices a real edit in a CRLF file', async () => {
        getFileStats.mockResolvedValue({ mtime: NEW });
        readText.mockResolvedValue('a\r\nCHANGED\r\nc');

        const file = fileAt(OLD, 'a\nb\nc');
        file.eol = '\r\n';
        await confirmOverwrite(file);
        expect(showConfirm).toHaveBeenCalledOnce();
    });
});
