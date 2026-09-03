# Working notes for this repository

## Where personal working files go

`scratch/` is gitignored. Anything that is the maintainer's own working
material belongs there, not in the repository:

- task lists, checklists, "what to capture" notes
- direction and planning documents, options being weighed
- release runbooks and draft release notes
- one-off probes and diagnostic pages

The test is who the file is for. `README.md` is for people using or building
the project, so it is committed. A list of screenshots still to take is a
personal task, so it is not — it went into the repo once as
`docs/images/README.md` and had to be pulled back out.

Documentation that describes the product, its build, or its interfaces is a
different thing and stays tracked: `README.md`, `docs/RELEASE.md`,
`docs/THEMING.md`.

## Version numbers live in three files

`src-tauri/tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml` — plus
`Cargo.lock` and `package-lock.json`, which follow. Miss one and the About
panel, the installer filename and the tag disagree.

`scripts/publish-release.ps1` refuses to publish when they diverge, but they
should be right before it gets that far.

## Releasing

```powershell
.\scripts\build-release.ps1 -KeyPath ~\.tauri\jh-editor.key
.\scripts\publish-release.ps1
```

The signing key never enters the repository and is never pasted into a chat.
Losing it, or its passphrase, permanently cuts the update channel for every
installation already out there.

Once a version is published, its number is spent. Changing what a released
version contains leaves two different builds wearing the same number, and the
updater compares numbers only — so nobody on the old one is ever offered the
fix. Bump instead.

## Comments

Match the file you are editing. Most of `src/` carries Japanese commentary;
some files (`src/modules/ui/MermaidHelper.js` among them) are English
throughout, and `tests/FileSafety.test.js` enforces that for a list of
UI files. Inside `src-tauri/nsis/*.nsh`, stay ASCII — makensis compiles it,
and an encoding mismatch fails the build rather than a test.
