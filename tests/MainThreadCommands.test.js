import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'src-tauri', 'src', 'commands');

/*
 * A Tauri command written as a plain `fn` runs on the main thread. While it
 * waits on the disk, the window stops processing messages: it greys out, shows
 * "not responding", and cannot even be closed. Only commands that are known to
 * finish instantly — or that must touch the window/clipboard from the main
 * thread — may stay synchronous.
 */
const MAY_STAY_SYNC = new Set([
    'get_launch_args',      // process args, in memory
    'expand_env_path',      // string work only
    'open_devtools',        // window API
    'create_app_window',    // window creation belongs on the main thread
    'take_launch_path',     // in-memory map
    'paste_files',          // clipboard
    // Hands the walk to its own thread and returns at once. It must stay in
    // call order: the generation it takes is what cancels the older search.
    'start_grep',
    'large_file_close',     // drops a handle; returns () so cannot be async
    'editable_close',       // same
]);

function syncCommands() {
    const found = [];
    for (const name of readdirSync(dir).filter(f => f.endsWith('.rs'))) {
        const src = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
        const re = /#\[(?:tauri::)?command\]\n\s*pub fn (\w+)/g;
        let m;
        while ((m = re.exec(src))) found.push(m[1]);
    }
    return found;
}

describe('Tauri commands and the main thread', () => {
    it('keeps disk and process work off the main thread', () => {
        const offenders = syncCommands().filter(n => !MAY_STAY_SYNC.has(n));
        expect(offenders).toEqual([]);
    });

    it('still finds the allowed synchronous commands (the scan works)', () => {
        expect(syncCommands()).toContain('get_launch_args');
    });
});
