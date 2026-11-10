//! Dragging files out of the app, to Explorer, a mail client, a chat window.
//!
//! An HTML5 drag carries text as far as other applications are concerned, so a
//! row dropped on Explorer did nothing. Only a real OLE drag holding the files
//! themselves is understood out there, and the Shell can build one that carries
//! every format a drag from Explorer would.
//!
//! The drag offers a copy and nothing else. Offering a move would let Explorer
//! carry the file off by itself on a plain drop within a drive, out from under
//! the workspace and any tab open on it.

use tauri::{command, Window};

/// Run an OS drag of `paths`. Resolves when the drag is over, dropped or not.
#[command(async)]
pub fn start_file_drag(window: Window, paths: Vec<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        // DoDragDrop runs its own message loop and has to be on the thread that
        // owns the window. This thread only waits for it.
        window
            .run_on_main_thread(move || {
                let _ = tx.send(platform::drag(hwnd, &paths));
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, paths);
        Err("Dragging files out is not available on this platform".to_string())
    }
}

#[cfg(windows)]
mod platform {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{IBindCtx, IDataObject};
    use windows::Win32::System::Ole::{IDropSource, DROPEFFECT_COPY};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        BHID_DataObject, ILFree, SHCreateShellItemArrayFromIDLists, SHDoDragDrop, SHParseDisplayName,
    };

    /// Frees the Shell's name for a file, however the function holding it ends.
    struct Pidl(*mut ITEMIDLIST);

    impl Drop for Pidl {
        fn drop(&mut self) {
            unsafe { ILFree(Some(self.0 as *const ITEMIDLIST)) };
        }
    }

    pub fn drag(hwnd: isize, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut pidls = Vec::with_capacity(paths.len());
        for path in paths {
            let mut pidl = std::ptr::null_mut();
            // The app's paths can use either slash; the Shell parser takes one.
            let native = HSTRING::from(path.replace('/', "\\"));
            unsafe { SHParseDisplayName(&native, None::<&IBindCtx>, &mut pidl, 0, None) }
                .map_err(|e| format!("{path}: {e}"))?;
            pidls.push(Pidl(pidl));
        }
        let raw: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| p.0 as *const ITEMIDLIST).collect();
        unsafe {
            // A shell item array can span folders, which a multi-selection in
            // the tree may well do.
            let items = SHCreateShellItemArrayFromIDLists(&raw).map_err(|e| e.to_string())?;
            let data: IDataObject = items
                .BindToHandler(None::<&IBindCtx>, &BHID_DataObject)
                .map_err(|e| e.to_string())?;
            // No drop source of our own: the Shell's follows the mouse and Esc
            // and draws the same drag image Explorer does.
            SHDoDragDrop(
                Some(HWND(hwnd as *mut _)),
                &data,
                None::<&IDropSource>,
                DROPEFFECT_COPY,
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        }
    }
}
