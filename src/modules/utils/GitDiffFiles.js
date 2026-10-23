import { invoke } from '@tauri-apps/api/core';

/**
 * The files that differ between `fromRev` and `toRev` ('' = working tree).
 *
 * `git diff <rev>` leaves out files git does not track yet, so a comparison
 * with the working tree never showed a file just created. Those are added
 * here as added files (ignored ones stay out).
 */
export async function listChangedFiles(root, fromRev, toRev) {
    const files = await invoke('git_diff_files', { path: root, fromRev, toRev });
    if (toRev !== '') return files;
    try {
        const out = await invoke('git_exec', {
            args: ['ls-files', '--others', '--exclude-standard', '-z'], cwd: root,
        });
        const known = new Set(files.map((f) => f.path));
        for (const path of String(out || '').split('\0')) {
            if (path && !known.has(path)) files.push({ status: 'A', path, untracked: true });
        }
    } catch (err) {
        console.warn('listing untracked files failed', err);
    }
    return files;
}
