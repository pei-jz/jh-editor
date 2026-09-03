/* The images the README points at.
 *
 * A missing screenshot is not a broken build, so nothing else catches it —
 * it just shows up as a broken image on the project's front page, to everyone
 * except whoever has the file sitting in their working copy.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8').replace(/\r\n/g, '\n');

const readme = read('README.md');

describe('README screenshots', () => {
    const referenced = [...readme.matchAll(/docs\/images\/[\w.-]+\.(?:png|jpe?g|gif|webp|svg)/g)]
        .map((m) => m[0]);

    it('points only at files that exist', () => {
        expect(referenced.length, 'the README stopped showing anything').toBeGreaterThan(0);
        const missing = [...new Set(referenced)].filter((rel) => !existsSync(join(repo, rel)));
        expect(missing, `referenced but not committed: ${missing.join(', ')}`).toEqual([]);
    });

    // `<picture>` commits to the `<source>` whose media query matches and does
    // NOT fall back to the `<img>` if that file 404s. Measured rather than
    // assumed: with the source missing, naturalWidth comes back 0. A dark
    // variant listed before it is captured breaks the hero for every reader
    // browsing GitHub in dark mode — the half that never sees the light one.
    it('offers no art-directed source it does not have', () => {
        const sources = [...readme.matchAll(/<source[^>]*srcset="([^"]+)"/g)].map((m) => m[1]);
        const missing = sources.filter((rel) => !existsSync(join(repo, rel)));
        expect(missing, `<picture> source with no file: ${missing.join(', ')}`).toEqual([]);
    });
});
