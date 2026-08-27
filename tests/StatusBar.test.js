import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn(), watch: vi.fn(async () => () => {}) }));

const { bufferByteSize, formatByteSize, formatModified, needsStatsRefresh } =
    await import('../src/modules/core/Editor.js');

/* The status bar was reading `file.stats`, which is what the file was when it
   was last read from disk. A buffer that has never been saved carries the
   placeholder `{ size: 0, mtime: 0 }`, and both halves were printed as if they
   were measurements: "0 B" next to a screen full of text, and "1970/1/1
   9:00:00" — the epoch — as a modification date. */

describe('the size in the status bar', () => {
    it('measures the buffer, not the last thing read from disk', () => {
        const file = { content: 'hello', eol: '\n', stats: { size: 0, mtime: 0 } };
        expect(bufferByteSize(file)).toBe(5);
    });

    it('counts what the bytes actually are, not the characters', () => {
        // Three kana, three bytes each in UTF-8.
        expect(bufferByteSize({ content: 'あいう', eol: '\n' })).toBe(9);
    });

    // A CRLF file is one byte per line longer than the LF text held in memory,
    // which is exactly what the save path writes.
    it('counts line endings the way they will be written', () => {
        const lf = { content: 'a\nb\nc', eol: '\n' };
        const crlf = { content: 'a\nb\nc', eol: '\r\n' };
        expect(bufferByteSize(lf)).toBe(5);
        expect(bufferByteSize(crlf)).toBe(7);
    });

    // A huge file opened through the mmap viewer has no content in JS, so the
    // size on disk is the only thing there is to report.
    it('falls back to the file size when the text is not in memory', () => {
        expect(bufferByteSize({ isLarge: true, content: '', stats: { size: 900 } })).toBe(900);
        expect(bufferByteSize({ isLarge: true, content: '', stats: { size: 0 } })).toBeNull();
        expect(bufferByteSize(null)).toBeNull();
    });

    it('scales the unit, and prints nothing for nothing', () => {
        expect(formatByteSize(0)).toBe('0 B');
        expect(formatByteSize(512)).toBe('512 B');
        expect(formatByteSize(1024)).toBe('1.0 KB');
        expect(formatByteSize(1536)).toBe('1.5 KB');
        expect(formatByteSize(1024 * 1024)).toBe('1.0 MB');
        expect(formatByteSize(null)).toBe('');
        expect(formatByteSize(NaN)).toBe('');
    });
});

describe('the modified date', () => {
    // Nothing is better than something invented: a blank reads as "not saved
    // yet", while a 1970 date reads as information.
    it('says nothing for a buffer that was never written', () => {
        expect(formatModified({ stats: { size: 0, mtime: 0 } })).toBe('');
        expect(formatModified({ stats: { size: 0 } })).toBe('');
        expect(formatModified({})).toBe('');
        expect(formatModified(null)).toBe('');
    });

    it('says nothing for a date it cannot read', () => {
        expect(formatModified({ stats: { mtime: 'not a date' } })).toBe('');
        expect(formatModified({ stats: { mtime: -1 } })).toBe('');
    });

    it('formats a real one', () => {
        const at = new Date('2026-03-04T05:06:07Z');
        const out = formatModified({ stats: { mtime: at.toISOString() } });
        expect(out).not.toBe('');
        expect(out).toBe(at.toLocaleString());
    });
});

describe('with no file open', () => {
    // Leaving the last file's numbers on screen is the same fault as inventing
    // them: they describe nothing that is there.
    it('clears the size and the date, not just the caret position', async () => {
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const { dirname, join } = await import('node:path');
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(join(here, '..', 'src/modules/core/Editor.js'), 'utf8');
        const i = src.indexOf('export function updateStatusBar(');
        const block = src.slice(i, src.indexOf('const isMd', i));
        expect(block).toContain("'status-size'");
        expect(block).toContain("'status-last-modified'");
    });
});

/* `file.stats` is captured once, when the file is opened, and getFileStats
   returns null on any error. A failure there left the buffer holding the
   placeholder `{ size: 0, mtime: 0 }` for the rest of the session — so the date
   was never shown for that file again, however many times it was redrawn. */
describe('recovering a missing modification time', () => {
    it('goes looking when a real file has no date', () => {
        expect(needsStatsRefresh({ path: 'C:/proj/a.js', stats: { size: 0, mtime: 0 } })).toBe(true);
        expect(needsStatsRefresh({ path: '/home/x/a.js' })).toBe(true);
    });

    it('leaves it alone once the date is known', () => {
        expect(needsStatsRefresh({
            path: 'C:/proj/a.js', stats: { mtime: '2026-03-04T05:06:07Z' },
        })).toBe(false);
    });

    it('does not stat what is not on disk', () => {
        expect(needsStatsRefresh({ path: null })).toBe(false);
        expect(needsStatsRefresh({ path: 'Untitled.txt' })).toBe(false);   // never saved
        expect(needsStatsRefresh({ path: 'C:/proj/x', type: 'diff' })).toBe(false);
        expect(needsStatsRefresh(null)).toBe(false);
    });

    // The status bar redraws on every keystroke; one request at a time.
    it('does not pile up requests', () => {
        expect(needsStatsRefresh({ path: 'C:/proj/a.js', _statsPending: true })).toBe(false);
    });

    // A file that genuinely cannot be stat'ed must not be retried forever...
    it('gives up on a path that failed', () => {
        expect(needsStatsRefresh({ path: 'C:/proj/a.js', _statsFailedFor: 'C:/proj/a.js' }))
            .toBe(false);
    });

    // ...but Save As gives it a new path, which deserves a fresh attempt.
    it('tries again after the file is saved somewhere else', () => {
        expect(needsStatsRefresh({ path: 'C:/proj/b.js', _statsFailedFor: 'C:/proj/a.js' }))
            .toBe(true);
    });
});
