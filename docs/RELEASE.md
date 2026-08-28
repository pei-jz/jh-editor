# Release handbook

What has to be true before a build is handed to someone else, and the exact
steps for the parts that need a human decision.

---

## Version numbers

Three files carry the version and **must agree**. A mismatch means the About
panel, the installer and the crate all claim something different, and a bug
report becomes unactionable.

| File | Field |
|------|-------|
| `package.json` | `"version"` |
| `src-tauri/tauri.conf.json` | `"version"` |
| `src-tauri/Cargo.toml` | `version` under `[package]` |

`tests/SecurityHardening.test.js` asserts the three stay in step, so `npm test`
catches a half-finished bump.

The running app shows its version in **Settings → General → About**, with a
*Copy version info* button that puts version, platform and Tauri version on the
clipboard. Ask for that string in every bug report.

---

## Pre-release checklist

```sh
npm test                 # unit suite (938 tests)
npm run test:coverage    # coverage gate on the logic layer
npx playwright test      # browser-level UI wiring
npm run tauri build      # the actual artefact
```

Then, by hand:

- Launch the built binary (not `tauri dev`) at least once and open a Markdown
  file with a diagram, a CSV, and a large log.
- Check `git status` is clean. `public/` holds `marked.min.js` and
  `mermaid.min.js`; the app renders no Markdown without them, so a build from a
  fresh clone is the only honest test that they are committed.

---

## Code signing

Unsigned builds are not broken, they are *distrusted*: Windows SmartScreen shows
"Windows protected your PC" and macOS Gatekeeper refuses to open the app from
Finder. Users read that as malware.

Until a certificate is in place, say so plainly in the release notes and the
README rather than letting people discover it:

> This build is not code-signed. Windows will show a SmartScreen warning —
> choose **More info → Run anyway**.

Signing needs, per platform:

- **Windows** — an OV or EV code-signing certificate from a CA, then
  `bundle.windows.certificateThumbprint` in `tauri.conf.json`.
- **macOS** — an Apple Developer ID certificate plus notarisation
  (`APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`).

Both cost money and identity verification. Neither is something this repository
can do for you.

---

## Automatic updates (not yet wired)

The app currently has **no update mechanism**. Once a build is in someone's
hands, there is no way to deliver a fix to it — that is the practical reason to
set this up before the first public release, not after.

Wiring it needs two things only you can provide: a **signing key pair** (the
private half must never enter the repository) and a **URL to publish the update
manifest at**. The steps:

### 1. Generate the key pair

```sh
npm run tauri signer generate -- -w ~/.tauri/jh-editor.key
```

This writes the private key to `~/.tauri/jh-editor.key` and prints the public
key. **Back the private key up somewhere you will still have in two years** —
losing it means every existing install stops accepting updates, permanently, and
the only remedy is asking every user to reinstall by hand.

### 2. Add the plugin

`src-tauri/Cargo.toml`:

```toml
tauri-plugin-updater = "2"
```

`src-tauri/src/lib.rs`, alongside the other plugins:

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

`package.json`:

```sh
npm install @tauri-apps/plugin-updater
```

### 3. Configure the endpoint

`src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/<owner>/<repo>/releases/latest/download/latest.json"
    ],
    "pubkey": "<the public key printed in step 1>"
  }
}
```

And add the updater permissions to `src-tauri/capabilities/default.json`:

```json
"updater:default"
```

### 4. Sign at build time

```sh
TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/jh-editor.key) npm run tauri build
```

On Windows PowerShell:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ~/.tauri/jh-editor.key -Raw; npm run tauri build
```

The build emits `latest.json` next to the installers. Upload both to the GitHub
release.

### 5. Check for updates from the app

The natural home is the About block in **Settings → General**
(`initAboutSection` in `src/modules/ui/SettingsModal.js`) — a *Check for
updates* button beside *Copy version info*:

```js
const { check } = await import('@tauri-apps/plugin-updater');
const update = await check();
if (update) {
    await update.downloadAndInstall();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
}
```

Check on demand rather than silently on launch: an editor that restarts itself
while someone is typing is worse than one that is a version behind.

---

## Platform scope

The backend shells out to `cmd`, `explorer` and `powershell` on Windows paths,
with `sh` / `open` / `xdg-open` equivalents beside them. Those equivalents
compile, but if they have not been exercised on real macOS and Linux machines,
`bundle.targets` should say so:

```json
"bundle": { "targets": ["nsis", "msi"] }
```

Shipping a Windows-only editor honestly beats shipping three targets where two
are untested. EmEditor has done exactly that for twenty years.
