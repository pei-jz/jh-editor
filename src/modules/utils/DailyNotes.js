/**
 * DailyNotes.js — the daily journal, one Markdown file per day.
 *
 * The files themselves, and where they live, are Notes.js's business now: the
 * quick notes moved into the same folder tree and the two were describing the
 * same directory twice. What is left here is the journal's own idea — today,
 * and opening a given day.
 */

import { dayId, dailyPath, listDaily } from './Notes.js';

export const DailyNotes = {
    /** Open (or create) today's daily note as a normal editor tab. */
    async openToday() {
        return this.openDay(dayId());
    },

    /** Open (or create) the note for `YYYY-MM-DD` as a normal editor tab. */
    async openDay(id) {
        const path = await dailyPath(id);
        if (!path) {
            if (window.showToast) window.showToast(`Could not open the note for ${id}`);
            return null;
        }
        if (window.app?.openFile) await window.app.openFile(path);
        return path;
    },

    /** Every daily note on disk, newest first. */
    list: listDaily,

    todayId: dayId,
};
