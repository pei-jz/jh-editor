import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn(), watch: vi.fn(async () => () => {}) }));

const { revealDirectory } = await import('../src/modules/core/Explorer.js');
const { State } = await import('../src/modules/core/Store.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/* The title bar already showed the file's directory and always had; it was just
   inert text. Each part of it is a folder, and clicking one should take you
   there — in the explorer when it is somewhere the explorer can go, and in the
   OS file manager when it is not. A daily note lives in the config directory,
   which no workspace contains, so "not in the tree" is the ordinary case rather
   than the edge one. */

describe('which folders the explorer can show', () => {
    beforeEach(() => {
        State.currentDir = 'C:/proj';
        State.expandedFolders = new Set();
    });

    it('turns down a path outside the workspace, so the caller can hand it on', async () => {
        await expect(revealDirectory('C:/elsewhere/docs')).resolves.toBe(false);
        // A daily note: the reason this branch exists.
        await expect(revealDirectory('C:/Users/x/AppData/Roaming/jh/notes/daily'))
            .resolves.toBe(false);
    });

    it('turns down everything when no workspace is open', async () => {
        State.currentDir = '';
        await expect(revealDirectory('C:/proj/src')).resolves.toBe(false);
    });

    // "C:/project-backup" starts with "C:/proj" as a STRING and is a different
    // folder. Matching on the prefix alone would send it to the tree, where it
    // is not, and the click would do nothing at all.
    it('is not fooled by a sibling whose name starts the same', async () => {
        await expect(revealDirectory('C:/project-backup/src')).resolves.toBe(false);
    });

    it('accepts a path inside the workspace, and opens the way to it', async () => {
        await expect(revealDirectory('C:/proj/src/modules')).resolves.toBe(true);
        // Every folder between the root and the target, and not the root
        // itself — the root row is the tree and has no expander.
        expect([...State.expandedFolders].sort())
            .toEqual(['C:/proj/src', 'C:/proj/src/modules']);
    });

    it('accepts the workspace root itself', async () => {
        await expect(revealDirectory('C:/proj')).resolves.toBe(true);
        expect([...State.expandedFolders]).toEqual([]);
    });

    it('reads a Windows path however it is spelled', async () => {
        await expect(revealDirectory('C:\\proj\\src')).resolves.toBe(true);
        await expect(revealDirectory('C:/PROJ/src')).resolves.toBe(true);
        await expect(revealDirectory('C:/proj/src/')).resolves.toBe(true);
    });
});

/* The crumbs themselves are drawn straight into the title bar, so the wiring is
   read rather than run: what matters is that the two destinations exist and
   that the fall-through goes to the OS. */
describe('the title bar path is wired to both destinations', () => {
    const src = read('src/modules/core/Editor.js');
    const fn = src.slice(src.indexOf('async function openDirectoryFromCrumb'),
        src.indexOf('export function updateToolbar'));

    it('tries the explorer first', () => {
        expect(fn).toContain('await revealDirectory(dir)');
    });

    it('falls through to the OS file manager when the explorer cannot', () => {
        expect(fn).toContain("invoke('reveal_in_file_manager'");
        expect(fn.indexOf('revealDirectory')).toBeLessThan(fn.indexOf('reveal_in_file_manager'));
    });

    // Moving the cursor in a panel nobody can see is not an answer.
    it('opens the explorer panel if it was hidden', () => {
        expect(fn).toContain('setExplorerVisible(true)');
    });
});
