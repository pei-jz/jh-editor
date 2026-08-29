import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    getLargeFileThresholdMB, setLargeFileThresholdMB, largeFileThresholdBytes,
    normalizeThresholdMB, DEFAULT_THRESHOLD_MB, MIN_THRESHOLD_MB, MAX_THRESHOLD_MB,
} from '../src/modules/utils/LargeFileSetting.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/* The line between "edit this" and "view this read-only" was a constant at
   500 MB. Whether that is right depends on the machine and the file, so it is
   a setting — with the constant it replaced as the default. */
describe('the large-file threshold', () => {
    beforeEach(() => { localStorage.clear(); });

    it('defaults to what the constant used to be', () => {
        expect(DEFAULT_THRESHOLD_MB).toBe(500);
        expect(getLargeFileThresholdMB()).toBe(500);
        expect(largeFileThresholdBytes()).toBe(500 * 1024 * 1024);
    });

    it('remembers a new value, in bytes as well', () => {
        expect(setLargeFileThresholdMB(20)).toBe(20);
        expect(getLargeFileThresholdMB()).toBe(20);
        expect(largeFileThresholdBytes()).toBe(20 * 1024 * 1024);
    });

    /* Below 1 MB ordinary source files would open read-only, which reads as the
       editor being broken; above 4 GB the number stops meaning anything. */
    it('clamps instead of accepting a number that breaks the editor', () => {
        expect(setLargeFileThresholdMB(0)).toBe(MIN_THRESHOLD_MB);
        expect(setLargeFileThresholdMB(-40)).toBe(MIN_THRESHOLD_MB);
        expect(setLargeFileThresholdMB(999999)).toBe(MAX_THRESHOLD_MB);
        expect(normalizeThresholdMB(12.7)).toBe(13);
    });

    it('falls back to the default on anything it cannot read as a number', () => {
        for (const junk of ['', 'abc', null, undefined, NaN, {}]) {
            expect(normalizeThresholdMB(junk), String(junk)).toBe(DEFAULT_THRESHOLD_MB);
        }
        localStorage.setItem('settings_largeFileThresholdMB', 'nonsense');
        expect(getLargeFileThresholdMB()).toBe(DEFAULT_THRESHOLD_MB);
    });

    // The setting is worth nothing if the editor still reads a constant.
    it('is what the editor actually consults', () => {
        const editor = read('src/modules/core/Editor.js');
        expect(editor).toContain("import { largeFileThresholdBytes } from '../utils/LargeFileSetting.js';");
        expect(editor).not.toContain('const LARGE_FILE_VIEW_THRESHOLD');
        // Both decisions: opening from disk, and a huge buffer with no path.
        expect((editor.match(/largeFileThresholdBytes\(\)/g) || []).length).toBe(2);
    });

    it('has a field in Settings that writes back what was stored', () => {
        expect(read('index.html')).toContain('id="large-file-threshold"');
        const settings = read('src/modules/ui/SettingsModal.js');
        // Writing the STORED value back means an out-of-range entry corrects
        // itself in the box instead of lying about what is set.
        expect(settings).toContain('String(setLargeFileThresholdMB(largeFileInput.value))');
    });
});
