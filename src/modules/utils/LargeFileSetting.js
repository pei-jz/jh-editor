/**
 * LargeFileSetting.js — where "too big to open normally" is drawn.
 *
 * Past this size a file is opened through the Rust mmap viewer instead of being
 * read into a JS string: scrollable and searchable, but read-only, because the
 * text was never in the editor to save back.
 *
 * The line was a constant at 500 MB, chosen on the grounds that CodeMirror can
 * cope. Whether it copes on YOUR machine with YOUR file is not something a
 * constant can know — 500 MB of JSON on 8 GB of RAM is a different proposition
 * from 500 MB of log on 64 GB — so it is a setting, with that constant as the
 * default.
 *
 * Kept in its own module so both the editor and the settings screen can read it
 * without importing each other.
 */

const KEY = 'settings_largeFileThresholdMB';

/** The shipped default, in megabytes. */
export const DEFAULT_THRESHOLD_MB = 500;

/**
 * The narrowest and widest the line may be drawn.
 *
 * Below 1 MB ordinary source files would open read-only, which reads as the
 * editor being broken. Above 4096 MB the number stops meaning anything: the
 * string would exceed what the engine can hold long before that.
 */
export const MIN_THRESHOLD_MB = 1;
export const MAX_THRESHOLD_MB = 4096;

/**
 * Coerce anything to a usable megabyte figure.
 *
 * Absent is NOT zero. `Number('')` and `Number(null)` are both 0, which clamps
 * to the 1 MB floor — so clearing the field would have opened every ordinary
 * source file read-only. Nothing entered means the default.
 */
export function normalizeThresholdMB(value) {
    if (value === null || value === undefined) return DEFAULT_THRESHOLD_MB;
    if (typeof value === 'string' && !value.trim()) return DEFAULT_THRESHOLD_MB;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_THRESHOLD_MB;
    return Math.min(MAX_THRESHOLD_MB, Math.max(MIN_THRESHOLD_MB, n));
}

/** The configured threshold in megabytes. */
export function getLargeFileThresholdMB() {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw === null || raw === '') return DEFAULT_THRESHOLD_MB;
        return normalizeThresholdMB(raw);
    } catch (_) {
        return DEFAULT_THRESHOLD_MB;
    }
}

/** Store a new threshold. Returns the value actually stored. */
export function setLargeFileThresholdMB(value) {
    const mb = normalizeThresholdMB(value);
    try { localStorage.setItem(KEY, String(mb)); } catch (_) { /* ignore */ }
    return mb;
}

/** The same figure in bytes, which is what file sizes are measured in. */
export function largeFileThresholdBytes() {
    return getLargeFileThresholdMB() * 1024 * 1024;
}
