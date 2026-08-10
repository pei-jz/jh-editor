//! Phase 1 of the huge-file roadmap: a memory-mapped, server-side backend for
//! viewing very large text files without ever materializing the whole file in
//! the JS layer.
//!
//! The frontend (LargeFileView) opens a file here, receives only metadata
//! (line count, size, encoding), and then pulls visible line ranges on demand.
//! Search runs here too, over the mmap, so the JS side never holds the content.
//!
//! Caveats:
//!   - Read-only. Editing huge files (a Rust rope) is a later phase.
//!   - The file is memory-mapped; if it is truncated on disk while open, reads
//!     may fault. This matches the trade-off other native large-file viewers make.

use std::collections::HashMap;
use std::fs::File;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chardetng::EncodingDetector;
use encoding_rs::Encoding;
use memmap2::Mmap;
use regex::Regex;
use ropey::Rope;
use serde::Serialize;
use tauri::{command, State};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct LargeFile {
    mmap: Mmap,
    /// Byte offset where each line begins. `line_starts.len()` is the line count.
    /// Line `i` ends at `line_starts[i+1] - 1` (dropping the '\n'), or at the
    /// file end for the last line.
    line_starts: Vec<usize>,
    encoding: &'static Encoding,
}

impl LargeFile {
    fn line_count(&self) -> usize {
        self.line_starts.len()
    }

    /// Raw byte range of line `i`, with any trailing '\r' (from CRLF) trimmed.
    fn line_bytes(&self, i: usize) -> &[u8] {
        let start = self.line_starts[i];
        let mut end = if i + 1 < self.line_starts.len() {
            self.line_starts[i + 1] - 1 // drop the '\n'
        } else {
            self.mmap.len()
        };
        if end > start && self.mmap[end - 1] == b'\r' {
            end -= 1;
        }
        &self.mmap[start..end]
    }

    fn line_text(&self, i: usize) -> String {
        let (cow, _, _) = self.encoding.decode(self.line_bytes(i));
        cow.into_owned()
    }
}

#[derive(Default)]
pub struct LargeFileState {
    files: Mutex<HashMap<u64, LargeFile>>,
}

#[derive(Serialize)]
pub struct LargeFileMeta {
    pub id: u64,
    pub line_count: usize,
    pub size: u64,
    pub encoding: String,
}

#[derive(Serialize)]
pub struct SearchHit {
    pub line: usize,
    /// Column, in UTF-16 code units (so JS String.slice lines up).
    pub col: usize,
    /// Match length, in UTF-16 code units.
    pub length: usize,
}

fn utf16_to_byte(s: &str, utf16_off: usize) -> usize {
    let mut u = 0usize;
    for (b, ch) in s.char_indices() {
        if u >= utf16_off {
            return b;
        }
        u += ch.len_utf16();
    }
    s.len()
}

fn byte_to_utf16(s: &str, byte_off: usize) -> usize {
    s[..byte_off].encode_utf16().count()
}

fn make_hit(line: usize, s: &str, start: usize, end: usize) -> SearchHit {
    SearchHit {
        line,
        col: byte_to_utf16(s, start),
        length: s[start..end].encode_utf16().count(),
    }
}

#[command]
pub fn large_file_open(
    path: String,
    state: State<'_, LargeFileState>,
) -> Result<LargeFileMeta, String> {
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();

    // SAFETY: read-only mapping of a user-selected file. See module caveats.
    let mmap = unsafe { Mmap::map(&file) }.map_err(|e| e.to_string())?;

    // Reject obvious binaries (NUL byte in the first KB).
    let probe_len = std::cmp::min(mmap.len(), 1024);
    if mmap[..probe_len].contains(&0) {
        return Err("Binary file detected".to_string());
    }

    // Detect encoding from a leading sample.
    let sample_len = std::cmp::min(mmap.len(), 64 * 1024);
    let mut detector = EncodingDetector::new();
    detector.feed(&mmap[..sample_len], true);
    let encoding = detector.guess(None, true);

    // Build the line index in one SIMD-accelerated pass over the bytes.
    let mut line_starts = Vec::with_capacity(1024);
    line_starts.push(0usize);
    for pos in memchr::memchr_iter(b'\n', &mmap) {
        line_starts.push(pos + 1);
    }

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let line_count = line_starts.len();

    state.files.lock().unwrap().insert(
        id,
        LargeFile {
            mmap,
            line_starts,
            encoding,
        },
    );

    Ok(LargeFileMeta {
        id,
        line_count,
        size,
        encoding: encoding.name().to_string(),
    })
}

#[command]
pub fn large_file_lines(
    id: u64,
    start: usize,
    count: usize,
    state: State<'_, LargeFileState>,
) -> Result<Vec<String>, String> {
    let files = state.files.lock().unwrap();
    let lf = files.get(&id).ok_or("Large file handle not found")?;
    let n = lf.line_count();
    if start >= n {
        return Ok(Vec::new());
    }
    let end = std::cmp::min(start + count, n);
    let mut out = Vec::with_capacity(end - start);
    for i in start..end {
        out.push(lf.line_text(i));
    }
    Ok(out)
}

#[command]
pub fn large_file_search(
    id: u64,
    query: String,
    from_line: usize,
    from_col: i64,
    forward: bool,
    case_sensitive: bool,
    state: State<'_, LargeFileState>,
) -> Result<Option<SearchHit>, String> {
    let files = state.files.lock().unwrap();
    let lf = files.get(&id).ok_or("Large file handle not found")?;
    search_lines(
        lf.line_count(),
        |i| lf.line_text(i),
        &query,
        from_line,
        from_col,
        forward,
        case_sensitive,
    )
}

/// Line-granular regex search shared by the read-only (mmap) and editable (rope)
/// backends. `get_line(i)` returns the decoded text of line `i` (no '\n').
/// `from_col` is a UTF-16 column; negative means "from the very start".
fn search_lines<F: Fn(usize) -> String>(
    n: usize,
    get_line: F,
    query: &str,
    from_line: usize,
    from_col: i64,
    forward: bool,
    case_sensitive: bool,
) -> Result<Option<SearchHit>, String> {
    if query.is_empty() || n == 0 {
        return Ok(None);
    }

    let re = Regex::new(&format!(
        "{}{}",
        if case_sensitive { "" } else { "(?i)" },
        regex::escape(query)
    ))
    .map_err(|e| e.to_string())?;

    let from_line = from_line.min(n - 1);

    if forward {
        // Remainder of the starting line, after the current column.
        {
            let s = get_line(from_line);
            let start_byte = if from_col < 0 {
                0
            } else {
                utf16_to_byte(&s, (from_col as usize) + 1).min(s.len())
            };
            if let Some(m) = re.find_at(&s, start_byte) {
                return Ok(Some(make_hit(from_line, &s, m.start(), m.end())));
            }
        }
        // Subsequent lines, then wrap around to the top.
        let order = ((from_line + 1)..n).chain(0..=from_line);
        for i in order {
            let s = get_line(i);
            if let Some(m) = re.find(&s) {
                return Ok(Some(make_hit(i, &s, m.start(), m.end())));
            }
        }
    } else {
        // Last match before the current column on the starting line.
        {
            let s = get_line(from_line);
            let ceiling = if from_col < 0 {
                0
            } else {
                utf16_to_byte(&s, from_col as usize).min(s.len())
            };
            let mut last = None;
            for m in re.find_iter(&s) {
                if m.start() < ceiling {
                    last = Some((m.start(), m.end()));
                } else {
                    break;
                }
            }
            if let Some((a, b)) = last {
                return Ok(Some(make_hit(from_line, &s, a, b)));
            }
        }
        // Previous lines, then wrap around to the bottom.
        let mut order: Vec<usize> = (0..from_line).rev().collect();
        order.extend((from_line..n).rev());
        for i in order {
            let s = get_line(i);
            if let Some(m) = re.find_iter(&s).last() {
                return Ok(Some(make_hit(i, &s, m.start(), m.end())));
            }
        }
    }

    Ok(None)
}

#[command]
pub fn large_file_close(id: u64, state: State<'_, LargeFileState>) {
    state.files.lock().unwrap().remove(&id);
}

/* ====================================================================== */
/* Editable backend (Phase 2): a ropey::Rope buffer for huge-file editing  */
/* ====================================================================== */

/// An in-memory, editable representation of a file. Unlike the read-only mmap
/// path, the content lives in a rope so inserts/deletes anywhere are cheap.
/// The frontend edits a sliding window of whole lines and commits each window
/// back here as a single char-range replacement (`editable_replace`), which is
/// why no UTF-16/char column conversion is ever needed for edits.
pub struct EditableFile {
    rope: Rope,
    encoding: &'static Encoding,
    /// Line ending to restore on save ("\n" or "\r\n"); content is stored as LF.
    eol: String,
    dirty: bool,
}

impl EditableFile {
    fn new(text: &str, encoding: &'static Encoding, eol: String) -> Self {
        EditableFile {
            rope: Rope::from_str(text),
            encoding,
            eol,
            dirty: false,
        }
    }

    fn line_count(&self) -> usize {
        self.rope.len_lines()
    }

    /// Decoded text of line `i` with any trailing line break trimmed.
    fn line_text(&self, i: usize) -> String {
        if i >= self.rope.len_lines() {
            return String::new();
        }
        let mut s = self.rope.line(i).to_string();
        while s.ends_with('\n') || s.ends_with('\r') {
            s.pop();
        }
        s
    }

    /// Exact substring covering whole lines `[start_line, start_line+count)`,
    /// plus the char range it occupies (so the frontend can commit it back).
    fn window(&self, start_line: usize, count: usize) -> (String, usize, usize) {
        let n = self.rope.len_lines();
        let start_line = start_line.min(n);
        let end_line = start_line.saturating_add(count).min(n);
        let start_char = self.rope.line_to_char(start_line);
        let end_char = if end_line >= n {
            self.rope.len_chars()
        } else {
            // Exclude the '\n' that separates this window from the next line, so
            // the frontend textarea has no phantom trailing empty line. That '\n'
            // is preserved on commit because the replaced range stops before it.
            self.rope.line_to_char(end_line).saturating_sub(1)
        };
        let text = self.rope.slice(start_char..end_char).to_string();
        (text, start_char, end_char)
    }

    /// Replace char range `[start, end)` with `text`. Bounds are clamped so a
    /// stale range from the frontend can never panic.
    fn replace(&mut self, start: usize, end: usize, text: &str) -> usize {
        let len = self.rope.len_chars();
        let start = start.min(len);
        let end = end.min(len).max(start);
        if start != end {
            self.rope.remove(start..end);
        }
        if !text.is_empty() {
            self.rope.insert(start, text);
        }
        self.dirty = true;
        self.line_count()
    }

    /// Bytes to write to disk: LF restored to the original EOL, then encoded.
    fn save_bytes(&self) -> Vec<u8> {
        let s = self.rope.to_string();
        let s = if self.eol != "\n" {
            s.replace('\n', &self.eol)
        } else {
            s
        };
        let (cow, _, _) = self.encoding.encode(&s);
        cow.into_owned()
    }
}

#[derive(Default)]
pub struct EditableState {
    files: Mutex<HashMap<u64, EditableFile>>,
}

#[derive(Serialize)]
pub struct EditableMeta {
    pub id: u64,
    pub line_count: usize,
    pub encoding: String,
    pub eol: String,
}

#[derive(Serialize)]
pub struct EditableWindow {
    pub text: String,
    pub start_char: usize,
    pub end_char: usize,
}

fn detect_eol(s: &str) -> String {
    if s.contains("\r\n") {
        "\r\n".to_string()
    } else if s.contains('\r') {
        "\r".to_string()
    } else {
        "\n".to_string()
    }
}

#[command]
pub fn editable_open(
    path: String,
    state: State<'_, EditableState>,
) -> Result<EditableMeta, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;

    let probe_len = std::cmp::min(bytes.len(), 1024);
    if bytes[..probe_len].contains(&0) {
        return Err("Binary file detected".to_string());
    }

    let sample_len = std::cmp::min(bytes.len(), 64 * 1024);
    let mut detector = EncodingDetector::new();
    detector.feed(&bytes[..sample_len], true);
    let encoding = detector.guess(None, true);

    let (decoded, _, _) = encoding.decode(&bytes);
    let eol = detect_eol(&decoded);
    // Store content normalized to LF; restore `eol` on save.
    let normalized = decoded.replace("\r\n", "\n").replace('\r', "\n");

    let ef = EditableFile::new(&normalized, encoding, eol.clone());
    let line_count = ef.line_count();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    state.files.lock().unwrap().insert(id, ef);

    Ok(EditableMeta {
        id,
        line_count,
        encoding: encoding.name().to_string(),
        eol,
    })
}

#[command]
pub fn editable_window(
    id: u64,
    start_line: usize,
    count: usize,
    state: State<'_, EditableState>,
) -> Result<EditableWindow, String> {
    let files = state.files.lock().unwrap();
    let ef = files.get(&id).ok_or("Editable file handle not found")?;
    let (text, start_char, end_char) = ef.window(start_line, count);
    Ok(EditableWindow {
        text,
        start_char,
        end_char,
    })
}

#[command]
pub fn editable_replace(
    id: u64,
    start_char: usize,
    end_char: usize,
    text: String,
    state: State<'_, EditableState>,
) -> Result<usize, String> {
    let mut files = state.files.lock().unwrap();
    let ef = files.get_mut(&id).ok_or("Editable file handle not found")?;
    Ok(ef.replace(start_char, end_char, &text))
}

#[command]
pub fn editable_line_count(id: u64, state: State<'_, EditableState>) -> Result<usize, String> {
    let files = state.files.lock().unwrap();
    let ef = files.get(&id).ok_or("Editable file handle not found")?;
    Ok(ef.line_count())
}

#[command]
pub fn editable_search(
    id: u64,
    query: String,
    from_line: usize,
    from_col: i64,
    forward: bool,
    case_sensitive: bool,
    state: State<'_, EditableState>,
) -> Result<Option<SearchHit>, String> {
    let files = state.files.lock().unwrap();
    let ef = files.get(&id).ok_or("Editable file handle not found")?;
    search_lines(
        ef.line_count(),
        |i| ef.line_text(i),
        &query,
        from_line,
        from_col,
        forward,
        case_sensitive,
    )
}

#[command]
pub fn editable_save(
    id: u64,
    path: String,
    state: State<'_, EditableState>,
) -> Result<(), String> {
    let mut files = state.files.lock().unwrap();
    let ef = files.get_mut(&id).ok_or("Editable file handle not found")?;
    let bytes = ef.save_bytes();
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    ef.dirty = false;
    Ok(())
}

#[command]
pub fn editable_close(id: u64, state: State<'_, EditableState>) {
    state.files.lock().unwrap().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ef(text: &str) -> EditableFile {
        EditableFile::new(text, encoding_rs::UTF_8, "\n".to_string())
    }

    #[test]
    fn line_count_matches_readonly_convention() {
        assert_eq!(ef("").line_count(), 1);
        assert_eq!(ef("a\nb\nc").line_count(), 3);
        assert_eq!(ef("a\nb\n").line_count(), 3); // trailing empty line
    }

    #[test]
    fn window_returns_exact_char_range() {
        let f = ef("a\nb\nc");
        // Non-EOF window excludes the separating '\n' (no phantom empty line).
        let (text, start, end) = f.window(0, 2);
        assert_eq!(text, "a\nb");
        assert_eq!((start, end), (0, 3));

        let (text, start, end) = f.window(2, 10); // clamp past EOF
        assert_eq!(text, "c");
        assert_eq!((start, end), (4, 5));
    }

    #[test]
    fn replace_swaps_window_and_preserves_separator() {
        let mut f = ef("a\nb\nc");
        let (_, start, end) = f.window(0, 2); // "a\nb" -> [0,3)
        let new_count = f.replace(start, end, "X");
        // The '\n' before 'c' is preserved because it was outside the window.
        assert_eq!(f.rope.to_string(), "X\nc");
        assert_eq!(new_count, 2);
        assert!(f.dirty);
    }

    #[test]
    fn replace_clamps_stale_bounds_without_panic() {
        let mut f = ef("abc");
        // end far past the end is clamped instead of panicking.
        f.replace(1, 999, "Z");
        assert_eq!(f.rope.to_string(), "aZ");
    }

    #[test]
    fn save_bytes_restores_crlf_and_encoding() {
        let f = EditableFile::new("x\ny", encoding_rs::UTF_8, "\r\n".to_string());
        assert_eq!(f.save_bytes(), b"x\r\ny");
    }

    #[test]
    fn search_finds_across_lines_case_insensitive() {
        let f = ef("foo bar\nbaz Foo\nqux");
        let hit = search_lines(f.line_count(), |i| f.line_text(i), "foo", 0, -1, true, false)
            .unwrap()
            .unwrap();
        assert_eq!((hit.line, hit.col, hit.length), (0, 0, 3));

        // continue forward from the first hit
        let hit2 = search_lines(f.line_count(), |i| f.line_text(i), "foo", 0, 0, true, false)
            .unwrap()
            .unwrap();
        assert_eq!((hit2.line, hit2.col), (1, 4));
    }
}
