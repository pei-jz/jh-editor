//! The bytes of a PDF, for the read-only preview (src/modules/views/PdfView.js).
//!
//! The parsing and drawing happen in the webview, in pdf.js. All the backend
//! does is hand the file over, because the webview cannot read an arbitrary
//! path itself: the asset protocol is scoped to $HOME, and a PDF on another
//! drive or a share is as ordinary a thing to open as one in Documents.

use tauri::command;

/// Larger than any document anyone reads page by page, and small enough that a
/// mistaken click on a disk image renamed .pdf does not try to pull gigabytes
/// across the IPC bridge into the webview's memory.
const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;

/// Only a `.pdf`: this is not a general way to read any file as bytes, and the
/// name is all the check there is before the file is opened.
pub fn is_pdf_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

/// Raw bytes rather than JSON: as a JSON array of numbers a 10 MB file would be
/// 40 MB on the wire, and parsed on the way in.
#[command]
pub async fn read_pdf_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    if !is_pdf_path(&path) {
        return Err(format!("Not a PDF file: {}", path));
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {}", path, e))?;
    if meta.len() > MAX_PDF_BYTES {
        return Err(format!("PDF too large to preview: {}", path));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pdf_names_are_read() {
        assert!(is_pdf_path("C:/docs/report.pdf"));
        assert!(is_pdf_path("C:/docs/REPORT.PDF"));
        assert!(!is_pdf_path("C:/docs/report.pdf.exe"));
        assert!(!is_pdf_path("C:/docs/notes.txt"));
        assert!(!is_pdf_path("C:/docs/pdf"));
        assert!(!is_pdf_path("C:/docs/.pdf"));
    }
}
