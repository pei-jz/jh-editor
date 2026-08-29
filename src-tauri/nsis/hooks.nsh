; Installer hooks: record where the app was installed.
;
; The updater downloads an NSIS installer and runs it with /UPDATE and no /D,
; so it always installs into the registered location. Run a portable copy of
; the exe and take an update, and the new version lands in the install
; directory while the copy you are running stays exactly as it was. Nothing
; fails, nothing is reported, and the next launch is still the old build.
;
; So the app has to know whether it IS the installed copy. Reading the value
; written here and comparing it against its own directory answers that: a
; portable exe either finds no key at all, or finds one pointing somewhere
; else. See is_installed() in src/commands/app.rs.
;
; Comments and strings here are kept ASCII on purpose. This file is spliced
; into Tauri's installer.nsi and compiled by makensis, and an encoding
; mismatch there fails the build rather than the test suite.

!macro NSIS_HOOK_POSTINSTALL
  ; SHCTX follows the install mode Tauri chose (per-user or per-machine), so
  ; this lands in the same hive the rest of the install did.
  WriteRegStr SHCTX "Software\io.github.pei-jz.jheditor" "InstallLocation" "$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\io.github.pei-jz.jheditor"
!macroend
