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

; Delete from both hives by name rather than through SHCTX.
;
; SHCTX follows the install mode, and on uninstall it did not come back as the
; hive the value was written to: a per-machine install left
; HKLM\Software\io.github.pei-jz.jheditor behind after its files were gone.
; A key that outlives the install is not just untidy: is_installed() reads it,
; so a portable copy dropped into the old directory would be told it is the
; installed build and offered updates it cannot apply.
;
; Removing a key that was never there is not an error, so naming both is safe
; whichever mode was used.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\io.github.pei-jz.jheditor"
  DeleteRegKey HKLM "Software\io.github.pei-jz.jheditor"
!macroend
