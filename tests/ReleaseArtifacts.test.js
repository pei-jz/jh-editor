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

    // Previous versions stay in the same directory. Picking by suffix alone
    // left the choice to readdir order — and the wrong pick is not loud. The
    // manifest takes its version from the config, so it would announce the
    // new version while carrying the old installer and the old signature.
    // That verifies, installs, and changes nothing.
    it('picks by version, not by whatever comes first', () => {
        expect(script).toContain('f.includes(`_${version}_`)');

        const ps = read('scripts/publish-release.ps1');
        expect(ps, 'the publish script must filter installers by version')
            .toContain('$_.Name -like "*_${version}_*"');
        expect(ps, 'and the portable zip too')
            .toContain('"*_${version}_*-portable.zip"');
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

describe('publishing', () => {
    const ps = read('scripts/publish-release.ps1');

    // A draft is not in releases/latest, and its assets sit under a temporary
    // untagged-<hash>/ path rather than download/<tag>/ — which is what
    // latest.json points at. So a draft looks finished, carries the right
    // files, and delivers no updates at all. Leaving one behind is the least
    // visible way to fail, so the script only stops at draft when asked to.
    it('does not leave the release as a draft', () => {
        expect(ps).toContain('--draft=false');
        expect(ps).toContain('--json isDraft');
    });
});

describe('licence obligations', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));

    it('states the project licence without a typo in it', () => {
        const text = read('LICENSE');
        expect(text).toContain('MIT License');
        // The name was misspelled here and in the old bundle identifier
        // (`com.jh-editer.app`). A copyright line is the one file where a
        // typo is quoted back at you by everyone who redistributes it.
        expect(text).not.toContain('Editer');
        expect(text).toContain('Copyright (c) 2026 J.H Editor Team');
    });

    // MIT and BSD both require the copyright notice and permission text to
    // travel with copies, and a binary is a copy. Shipping an installer with
    // library code inside it and no notices is a licence violation, whatever
    // this project licenses its own code under.
    it('ships notices for the third-party code it bundles', () => {
        const notices = read('THIRD-PARTY-NOTICES.md');

        // Generated, not maintained by hand: dependencies get added and
        // bumped, and a hand-written list is out of date the first time that
        // happens — at which point it is a list, not compliance.
        expect(notices).toContain('scripts/make-third-party-notices.mjs');

        // The two libraries served straight out of public/lib never appear in
        // any dependency graph, so nothing else would catch them going
        // unattributed.
        expect(notices).toContain('marked');
        expect(notices).toContain('mermaid');

        // Both halves of what actually ships.
        expect(notices).toContain('npm');
        expect(notices).toContain('Rust');
    });

    it('installs those notices next to the application', () => {
        // Terms nobody can find after install are not much better than none.
        expect(conf.bundle.resources).toContain('../THIRD-PARTY-NOTICES.md');
        expect(conf.bundle.resources).toContain('../LICENSE');
    });

    // Left unset, Tauri takes the publisher from the second element of the
    // identifier. `io.github.pei-jz.jheditor` made Windows list the publisher
    // as "github", which reads as though GitHub shipped it.
    it('says who published it', () => {
        expect(conf.bundle.publisher).toBeTruthy();
        expect(conf.bundle.publisher).not.toBe('github');
    });

    it('puts the licence in front of the user during install', () => {
        // The MIT text carries the warranty disclaimer, so the acceptance
        // page doubles as where that gets shown.
        expect(conf.bundle.licenseFile).toBe('../LICENSE');
        expect(conf.bundle.copyright).toContain('2026');
    });
});

describe('a portable copy', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));

    // The updater runs the NSIS installer with /UPDATE and no /D, so the new
    // version always goes to the registered install directory. From a
    // portable exe that "succeeds" while changing nothing the user is running
    // — no error, and the next launch is the same old build. The only way to
    // tell is to ask whether this exe is the installed one.
    it('is told apart by what the installer recorded', () => {
        expect(conf.bundle.windows?.nsis?.installerHooks).toBe('nsis/hooks.nsh');

        const hooks = read('src-tauri/nsis/hooks.nsh');
        expect(hooks).toContain('NSIS_HOOK_POSTINSTALL');
        expect(hooks).toContain('InstallLocation');
        expect(hooks).toContain(conf.identifier);
    });

    // Deleting through SHCTX did not work: after a per-machine uninstall the
    // HKLM value was still there with its files gone. A key that outlives the
    // install is not just untidy — is_installed() reads it, so a portable copy
    // dropped into the old directory would be told it is the installed build.
    // Naming both hives is safe, since removing a key that was never written
    // is not an error.
    it('takes its registry key with it', () => {
        const hooks = read('src-tauri/nsis/hooks.nsh');
        expect(hooks).toContain('NSIS_HOOK_POSTUNINSTALL');
        expect(hooks).toContain('DeleteRegKey HKCU');
        expect(hooks).toContain('DeleteRegKey HKLM');
        expect(hooks, 'SHCTX did not resolve to the write hive on uninstall')
            .not.toContain('DeleteRegKey SHCTX');
    });

    // makensis compiles this file. An encoding mismatch here fails the build,
    // not the test suite, so keep it to ASCII.
    it('keeps the hook file to ASCII', () => {
        const hooks = read('src-tauri/nsis/hooks.nsh');
        const bad = [...hooks].filter((ch) => ch.charCodeAt(0) > 127);
        expect(bad, `non-ASCII in hooks.nsh: ${bad.join(' ')}`).toEqual([]);
    });

    it('does not offer an update it cannot apply', () => {
        const rs = read('src-tauri/src/commands/app.rs');
        expect(rs).toContain('pub fn is_installed()');
        // A string compare fails over a trailing separator or a short path,
        // and every such failure reads as "not installed".
        expect(rs).toContain('canonicalize');

        const ui = read('src/modules/ui/SettingsModal.js');
        expect(ui).toContain("invoke('is_installed')");
        expect(read('src-tauri/src/lib.rs')).toContain('commands::app::is_installed');
    });

    it('says why the button is missing rather than just hiding it', () => {
        expect(read('index.html')).toContain('about-portable-note');
        for (const loc of ['ja', 'zh', 'ko']) {
            expect(read(`src/locales/${loc}.js`), `${loc} is missing the note`)
                .toContain('This is a portable build.');
        }
    });
});

describe('installing', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));

    // The default install mode is per-user and never elevates, so picking
    // C:\Program Files on the directory page produced "Error opening file for
    // writing" partway through — after the progress bar had already started.
    // `both` offers the choice up front and elevates when the user takes the
    // all-users option.
    it('can install somewhere that needs elevation', () => {
        expect(conf.bundle.windows?.nsis?.installMode).toBe('both');
    });

    // Both builds were called jh_editor.exe, so once either was running there
    // was no way to tell which. The installed one takes the product name; the
    // portable copy is renamed inside its zip.
    it('names the installed and portable builds differently', () => {
        expect(conf.mainBinaryName).toBe('J.H Editor');

        const build = read('scripts/build-release.ps1');
        expect(build).toContain("'J.H Editor Portable.exe'");
    });

    // A name only helps until the thing is running. The About panel says
    // which build this is, rather than leaving it to be inferred from whether
    // the update button happens to be there.
    it('says which build is running', () => {
        expect(read('index.html')).toContain('about-install-kind');
        expect(read('src/modules/ui/SettingsModal.js')).toContain("t('Portable')");
        for (const loc of ['ja', 'zh', 'ko']) {
            expect(read(`src/locales/${loc}.js`), `${loc} is missing the label`)
                .toContain("'Portable':");
        }
    });
});
