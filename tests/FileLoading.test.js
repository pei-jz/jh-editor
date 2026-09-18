import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beginLoad, beginFileLoad, formatSize } from '../src/modules/ui/LoadingOverlay.js';

/* Opening a few hundred megabytes takes seconds. The editor spent all of them
   showing the file you were already looking at — no caret, no movement, nothing
   — and then the new text, all at once. It looked like a hang, and it was
   reported as one.

   Two things have to hold for the panel to be an improvement rather than a new
   annoyance: it has to appear when an open is slow, and it has to stay out of
   the way entirely when an open is fast. A panel that flashes up on every
   Ctrl+P is worse than no panel at all. */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const panel = () => document.querySelector('.file-loading.visible');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the size shown beside the file name', () => {
    // "912 MB" is the part a reader can act on — it tells them which file this
    // is and roughly how long they are in for. An unlabelled spinner does not.
    it('scales to a unit a person reads at a glance', () => {
        expect(formatSize(1024)).toBe('1.0 KB');
        expect(formatSize(38_150_000)).toBe('36 MB');
        expect(formatSize(956_301_312)).toBe('912 MB');
        expect(formatSize(3 * 1024 ** 3)).toBe('3.0 GB');
    });

    // One decimal below ten, none above: "9.4 MB" is worth knowing, "9.4" out
    // of 912 is noise.
    it('drops the decimal once the number is big enough not to need it', () => {
        expect(formatSize(9.4 * 1024 ** 2)).toBe('9.4 MB');
        expect(formatSize(124 * 1024 ** 2)).toBe('124 MB');
    });

    it('says nothing rather than something wrong when there is no size', () => {
        expect(formatSize(0)).toBe('');
        expect(formatSize(null)).toBe('');
        expect(formatSize(undefined)).toBe('');
        expect(formatSize(NaN)).toBe('');
    });
});

describe('the loading panel', () => {
    let pane;

    beforeEach(() => {
        pane = document.createElement('div');
        pane.id = 'editor-container';
        pane.className = 'editor-pane active';
        pane.innerHTML = '<div id="tab-bar"></div>';
        document.body.appendChild(pane);
    });

    afterEach(() => {
        document.querySelectorAll('.file-loading').forEach((n) => n.remove());
        pane.remove();
    });

    it('stays away for an open that finishes quickly', async () => {
        const load = beginFileLoad('small.txt', { delayMs: 60 });
        await wait(20);
        load.done();
        await wait(120);
        expect(panel()).toBeNull();
        expect(load.shown).toBe(false);
    });

    it('appears once an open has run long enough to look stuck', async () => {
        const load = beginFileLoad('production.log', { delayMs: 30 });
        await wait(90);
        expect(panel()).toBeTruthy();
        expect(load.shown).toBe(true);
        expect(panel().textContent).toContain('production.log');
        load.done();
        expect(panel()).toBeNull();
    });

    /* beginFileLoad writes the sentence AROUND a file name; beginLoad takes a
       finished one. Restoring a session went through the first and came out as
       "Restoring your tabs を読み込み中…" — a sentence wrapped around another
       sentence. Two entry points, because there are two kinds of caller. */
    it('keeps a caller-supplied title whole', async () => {
        const load = beginLoad('Restoring your tabs', { delayMs: 30 });
        await wait(90);
        expect(panel().querySelector('.file-loading-title').textContent)
            .toBe('Restoring your tabs');
        load.done();
    });

    it('writes the sentence around a bare file name', async () => {
        const load = beginFileLoad('notes.md', { delayMs: 30 });
        await wait(90);
        const title = panel().querySelector('.file-loading-title').textContent;
        expect(title).toContain('notes.md');
        expect(title).not.toBe('notes.md');   // a sentence, not just the name
        load.done();
    });

    /* The read starts at once and the panel waits 180ms, so nearly every
       update lands BEFORE there is anything to write it on. Dropping those is
       what shipped a panel whose second line was blank: "big.log を読み込み中…"
       and then nothing — the size, the one thing on there the reader wanted,
       never appeared. */
    it('remembers an update made before it was on screen', async () => {
        const load = beginFileLoad('big.log', { delayMs: 60 });
        load.update('Reading 912 MB…');          // panel is not up yet
        expect(load.shown).toBe(false);
        await wait(120);
        expect(panel().textContent).toContain('Reading 912 MB…');
        load.done();
    });

    it('names the phase, so a stall says which half it is in', async () => {
        const load = beginFileLoad('production.log', { delayMs: 30 });
        await wait(90);
        load.update('Reading 912 MB…');
        expect(panel().textContent).toContain('Reading 912 MB…');
        load.update('Opening in the editor…');
        expect(panel().textContent).toContain('Opening in the editor…');
        expect(panel().textContent).not.toContain('Reading 912 MB…');
        load.done();
    });

    // Restoring a session opens several files in a row. The first one finishing
    // must not take the panel down while the rest are still going.
    it('survives until the last of several opens is finished', async () => {
        const a = beginFileLoad('a.log', { delayMs: 30 });
        const b = beginFileLoad('b.log', { delayMs: 30 });
        await wait(90);
        expect(panel()).toBeTruthy();
        a.done();
        expect(panel()).toBeTruthy();
        b.done();
        expect(panel()).toBeNull();
    });

    it('ignores a second done(), so a retry cannot unbalance the count', async () => {
        const a = beginFileLoad('a.log', { delayMs: 30 });
        const b = beginFileLoad('b.log', { delayMs: 30 });
        await wait(90);
        a.done();
        a.done();
        a.done();
        expect(panel()).toBeTruthy();
        b.done();
        expect(panel()).toBeNull();
    });

    // A status region, not an alert: the editor must keep the focus, and the
    // panel must not swallow a click meant for the tab underneath it.
    it('reports without taking over the pane', async () => {
        const load = beginFileLoad('a.log', { delayMs: 30 });
        await wait(90);
        const el = panel();
        expect(el.getAttribute('role')).toBe('status');
        expect(el.getAttribute('aria-live')).toBe('polite');
        expect(read('src/styles/editor.css')).toMatch(/\.file-loading\s*\{[^}]*pointer-events:\s*none/);
        load.done();
    });
});

/* vitest cannot run openFile far enough to prove this — it ends in a
   CodeMirror view — so the wiring is read instead. What matters is that the
   panel is taken down on EVERY exit: a file that fails to open (a dead link is
   deliberately silenced here) would otherwise leave it up for the session. */
describe('openFile puts the panel up and always takes it down', () => {
    const src = read('src/modules/core/Editor.js');
    const body = src.slice(src.indexOf('export async function openFile('),
        src.indexOf('\n}', src.indexOf('pendingOpens.delete(resolvedPath);')));

    it('starts before the read', () => {
        expect(body).toContain('const loading = beginFileLoad(');
        expect(body.indexOf('const loading = beginFileLoad('))
            .toBeLessThan(body.indexOf('await FS.getFileStats('));
    });

    it('ends in the finally, not on the happy path', () => {
        const finallyBlock = body.slice(body.lastIndexOf('} finally {'));
        expect(finallyBlock).toContain('loading.done();');
        expect(body.match(/loading\.done\(\)/g)).toHaveLength(1);
    });

    // Everything after the read is synchronous, so the last message would never
    // be painted without giving the browser a frame first.
    it('lets the last message reach the screen before the editor blocks', () => {
        expect(body).toContain('await nextPaint();');
        expect(body.indexOf('await nextPaint();'))
            .toBeLessThan(body.indexOf('const settled = findOpenFile(normalizedPath);'));
    });
});
