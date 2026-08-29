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
npm test                 # unit suite
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

## Code signing — deliberately not done

Releases are **not code-signed**, and that is a decision rather than an
omission. Windows shows "Windows protected your PC" on first run; the README
says so up front, because a warning nobody warned you about reads as malware
and a warning you were told to expect reads as a formality.

The reasoning, so it does not have to be rediscovered:

SmartScreen is a *reputation* system, not an allow-list, and reputation accrues
to a certificate over downloads. A new OV certificate therefore starts at zero
and shows the same warning as no certificate at all, for money, until the
downloads pile up. Only an **EV** certificate suppresses the warning
immediately — and since 2023 its private key must live in an HSM or a USB
token, so it carries hardware and handling cost on top of the fee.

That makes the real choice "free, with a warning" or "expensive, without one",
with very little in between. For a free project at launch, the first is the
better trade.

**This does not weaken updates.** The updater has its own signature scheme
(below), independent of OS code signing: the app refuses any update not signed
with the project's key. Distribution trust and update integrity are separate
problems and only one of them is unsolved here.

Revisit when one of these is true — all of them are consequences of having
users, not of shipping:

- Support load from "it will not install" exceeds the cost of a certificate
- Someone wants to deploy it in an organisation, where unsigned binaries are
  often blocked outright and no amount of explanation helps
- Antivirus false positives start recurring rather than being one-offs

If it is taken up later: **Windows** needs `bundle.windows.certificateThumbprint`
plus a `timestampUrl` (without a timestamp, every binary already shipped becomes
invalid the day the certificate expires). **macOS** needs an Apple Developer ID
certificate and notarisation.

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
compile, but have not been exercised on real macOS or Linux machines — and
`bundle.targets` is still `"all"`, so a build produces artefacts for all three.

Narrow it to what is actually tested:

```json
"bundle": { "targets": ["nsis", "msi"] }
```

Shipping a Windows-only editor honestly beats shipping three targets where two
are untested. EmEditor has done exactly that for twenty years. Add a target back
when someone has run the app on that OS, not when the code compiles for it.

### A blocker for CI, before anyone tries

`@jh/ai-client` resolves from `../jh-ai-agent/packages/jh-ai-client`. That
directory does not exist on a CI runner, so `npm ci` fails there. Publishing the
package, vendoring it, or making it optional is a prerequisite for any build
workflow — local builds are unaffected.
