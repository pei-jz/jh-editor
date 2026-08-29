/* Release artefacts: what gets uploaded, and under what name.
 *
 * The update channel breaks silently when this is wrong. A mismatched asset
 * name still builds, still tags, still publishes — and the only symptom is
 * that updates never arrive, reported by a user weeks later.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const script = read('scripts/make-latest-json.mjs');

describe('the installer uploaded to a release', () => {
    // GitHub rewrites spaces in release asset filenames, so `J.H Editor_...exe`
    // is served under a different name than the one written into the manifest.
    it('is named without spaces', () => {
        expect(script).toContain("installer.replace(/\\s+/g, '.')");
    });

    // This one is about not making a person choose. The build emits the name
    // straight from productName, which has a space in it; normalising by COPY
    // left two byte-identical exes side by side, told apart only by their
    // filename. Renaming leaves exactly one, so there is nothing to get wrong.
    it('replaces the build output rather than sitting next to it', () => {
        expect(script).toContain('renameSync');
        expect(script, 'copying leaves two identical installers to choose between')
            .not.toContain('copyFileSync');
    });

    // The signature travels with the file it signs. Leaving the .sig behind
    // under the old name breaks a re-run, which looks for `${installer}.sig`.
    it('carries the signature across with it', () => {
        expect(script).toContain('`${assetName}.sig`');
    });

    it('is the name the manifest points at', () => {
        // The URL is built from assetName, never from the raw build output.
        expect(script).toMatch(/url: `[^`]*\$\{assetName\}`/);
    });
});

describe('the update manifest', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));

    // `tauri build` does not produce latest.json. It writes the installer and
    // the .sig, and stops there; the manifest is the release publisher's job.
    // Hand-writing it is how a wrong signature or a stale URL gets shipped.
    it('is generated, not written by hand', () => {
        expect(conf.bundle.createUpdaterArtifacts).toBe(true);
        expect(script).toContain('latest.json');
    });

    // Both the tag and the owner/repo in the URL come from config, so the
    // manifest cannot drift from what the app actually checks.
    it('derives its URL from the configured endpoint', () => {
        const endpoint = conf.plugins?.updater?.endpoints?.[0];
        expect(endpoint, 'no updater endpoint configured').toBeTruthy();
        expect(script).toContain('conf.plugins?.updater?.endpoints?.[0]');
        expect(script).toContain('const tag = `v${version}`');
    });
});
