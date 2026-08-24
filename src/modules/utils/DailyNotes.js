/**
 * DailyNotes.js — daily journal notes stored as real .md files (Phase 3).
 *
 * Unlike the quick notes (localStorage), a daily note is a normal Markdown file
 * living in the app's per-user config directory (`appConfigDir()/notes/daily/`),
 * one file per day: `YYYY-MM-DD.md`. It opens as a regular editor tab (so every
 * editing mode, preview, save, and the workspace watcher work unchanged) while
 * never touching the user's project files.
 *
 * All file IO goes through the existing Rust `write_file` / `read_file_auto_detect`
 * / `exists` commands, so no filesystem scope changes are required.
 */

import { invoke } from '@tauri-apps/api/core';
import { appConfigDir } from '@tauri-apps/api/path';

function todayId() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function slugDate() {
    return todayId();
}

/** Resolve the daily-note directory, creating it as needed. */
async function dailyDir() {
    let base;
    try {
        base = await appConfigDir();
    } catch (_) {
        base = null;
    }
    if (!base) {
        // Fallback: best-effort per-OS config path via the env expander.
        try {
            base = await invoke('expand_env_path', { path: '%APPDATA%/JHEditor' });
        } catch (_) {
            base = '';
        }
    }
    const dir = `${String(base).replace(/[\\/]+$/, '')}/notes/daily`;
    try { await invoke('create_dir', { path: dir }); } catch (_) { /* already exists */ }
    return dir;
}

export const DailyNotes = {
    /** Open (or create) today's daily note as a normal editor tab. */
    async openToday() {
        const dir = await dailyDir();
        const path = `${dir}/${slugDate()}.md`;

        let exists = false;
        try { exists = await invoke('exists', { path }); } catch (_) { exists = false; }

        if (!exists) {
            const header = `# Daily Note — ${slugDate()}\n\n`;
            try { await invoke('write_file', { path, content: header, encoding: 'UTF-8' }); }
            catch (e) {
                if (window.showToast) window.showToast(`デイリーノートを作成できませんでした: ${e.message || e}`);
                return;
            }
        }

        if (window.app?.openFile) {
            window.app.openFile(path);
        }
    },

    todayId,
};
