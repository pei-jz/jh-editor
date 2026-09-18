//! Read-only previews of Office documents.
//!
//! Opening a spreadsheet to glance at a column should not cost an Excel cold
//! start. These readers pull the content straight out of the file — calamine
//! for workbooks, the OOXML part inside the zip for .docx and .pptx — and hand
//! the frontend plain data to draw. Nothing here writes, so the preview can
//! never be mistaken for an editor.
//!
//! What is deliberately NOT carried over: cell formatting, charts, images,
//! shape geometry, theming. The result is the text and the numbers, which is
//! what a "let me just check something" open is actually after.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::Serialize;
use tauri::command;

/// Rows kept per sheet. A preview that has to page through 200k rows is no
/// longer a preview, and the whole payload crosses IPC as one message.
const MAX_ROWS: usize = 5_000;
/// Columns kept per sheet.
const MAX_COLS: usize = 256;
/// Blocks kept for a .docx. Long enough for any document a person reads;
/// short enough that a generated 10k-page report cannot stall the view.
const MAX_BLOCKS: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
pub struct OfficePreview {
    /// "sheets" (xlsx/xls/ods), "slides" (pptx) or "document" (docx).
    pub kind: String,
    pub sheets: Vec<SheetPreview>,
    pub slides: Vec<SlidePreview>,
    pub blocks: Vec<DocBlock>,
}

impl OfficePreview {
    fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            sheets: Vec::new(),
            slides: Vec::new(),
            blocks: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SheetPreview {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    /// Size of the used range, before the preview caps were applied — so the
    /// view can say what it is not showing instead of quietly cutting off.
    pub total_rows: usize,
    pub total_cols: usize,
    pub truncated: bool,
    /// Why this sheet has no rows, when the reason is not "it is empty".
    ///
    /// A sheet that would not parse used to be dropped from the list, which
    /// meant a workbook quietly came back with one fewer tab than it has —
    /// indistinguishable, from the outside, from a sheet that was never there.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SlidePreview {
    pub number: usize,
    pub title: String,
    pub bullets: Vec<Bullet>,
    pub notes: String,
    /// Pictures on the slide. A deck exported as one image per slide parses to
    /// no text at all, which is not a failure — but the view has to be able to
    /// say why it is empty instead of showing a blank card.
    pub pictures: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Bullet {
    /// Indent level as authored (0 = top level).
    pub level: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DocBlock {
    /// "heading", "paragraph", "list" or "table".
    pub kind: String,
    /// Heading level (1-6) or list indent depth; 0 otherwise.
    pub level: usize,
    pub text: String,
    /// Populated for "table" only.
    pub rows: Vec<Vec<String>>,
}

impl DocBlock {
    fn text_block(kind: &str, level: usize, text: String) -> Self {
        Self { kind: kind.to_string(), level, text, rows: Vec::new() }
    }
}

/// Every extension this module can preview. The frontend asks before it decides
/// how to open a file, so the list lives in one place.
pub fn is_office_path(path: &str) -> bool {
    matches!(
        extension_of(path).as_str(),
        "xlsx" | "xlsm" | "xls" | "ods" | "docx" | "pptx"
    )
}

fn extension_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

#[command]
pub async fn read_office_preview(path: String) -> Result<OfficePreview, String> {
    let ext = extension_of(&path);
    // Checked before the read so a mistaken route costs an error, not the time
    // to pull a gigabyte of something else into memory first.
    if !is_office_path(&path) {
        return Err(format!("Not an Office file this can preview: .{}", ext));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;

    match ext.as_str() {
        "xlsx" | "xlsm" | "xls" | "ods" => read_workbook(bytes, &ext),
        "docx" => read_docx(bytes),
        "pptx" => read_pptx(bytes),
        other => Err(format!("Not an Office file this can preview: .{}", other)),
    }
}

/// Hand a previewed file to the application the OS opens it with.
///
/// Its own command rather than the shell plugin's `open`, which the preview
/// tried first and which silently refused: the JS side of that API is scoped to
/// `http(s):`, `tel:` and `mailto:` links, so a path was rejected before it
/// reached the shell and the button appeared to do nothing at all.
///
/// Deliberately narrow. Opening a file with its default handler is a shell
/// execute, which for an `.exe` means running it; this takes only the formats
/// the preview itself can show, and only when the file is really there. So a
/// path arriving from somewhere unexpected cannot turn it into a launcher.
#[command]
pub fn open_office_file(path: String) -> Result<(), String> {
    if !is_office_path(&path) {
        return Err(format!("Not a file this preview opens: {}", path));
    }
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("File not found: {}", path));
    }
    // Detached: the editor must not wait on Word, or sit holding a child
    // process for as long as the document stays open.
    open::that_detached(&path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Workbooks
// ---------------------------------------------------------------------------

fn read_workbook(bytes: Vec<u8>, ext: &str) -> Result<OfficePreview, String> {
    use calamine::{open_workbook_from_rs, Ods, Xls, Xlsx};

    let cursor = Cursor::new(bytes);
    match ext {
        "xlsx" | "xlsm" => {
            let mut wb = open_workbook_from_rs::<Xlsx<_>, _>(cursor)
                .map_err(|e| format!("Could not open the workbook: {}", e))?;
            collect_sheets(&mut wb)
        }
        "xls" => {
            let mut wb = open_workbook_from_rs::<Xls<_>, _>(cursor)
                .map_err(|e| format!("Could not open the workbook: {}", e))?;
            collect_sheets(&mut wb)
        }
        _ => {
            let mut wb = open_workbook_from_rs::<Ods<_>, _>(cursor)
                .map_err(|e| format!("Could not open the workbook: {}", e))?;
            collect_sheets(&mut wb)
        }
    }
}

fn collect_sheets<R, RS>(workbook: &mut R) -> Result<OfficePreview, String>
where
    R: calamine::Reader<RS>,
    R::Error: std::fmt::Display,
    RS: Read + std::io::Seek,
{
    let mut preview = OfficePreview::new("sheets");

    for name in workbook.sheet_names().to_vec() {
        let range = match workbook.worksheet_range(&name) {
            Ok(range) => range,
            Err(e) => {
                preview.sheets.push(SheetPreview {
                    name,
                    rows: Vec::new(),
                    total_rows: 0,
                    total_cols: 0,
                    truncated: false,
                    error: Some(e.to_string()),
                });
                continue;
            }
        };

        let (total_rows, total_cols) = range.get_size();
        let keep_cols = total_cols.min(MAX_COLS);
        let mut rows: Vec<Vec<String>> = Vec::new();

        for row in range.rows().take(MAX_ROWS) {
            let mut out = Vec::with_capacity(keep_cols);
            for cell in row.iter().take(keep_cols) {
                out.push(cell_text(cell));
            }
            rows.push(out);
        }

        // A used range that Excel padded out with blank rows at the bottom
        // would otherwise show as hundreds of empty lines.
        while rows.last().is_some_and(|r| r.iter().all(|c| c.is_empty())) {
            rows.pop();
        }

        preview.sheets.push(SheetPreview {
            name,
            // Measured against the caps, not against what survived the trim:
            // a sheet whose used range ends in blank rows is not truncated
            // just because they were dropped.
            truncated: total_rows > MAX_ROWS || total_cols > keep_cols,
            rows,
            total_rows,
            total_cols,
            error: None,
        });
    }

    Ok(preview)
}

fn cell_text(cell: &calamine::Data) -> String {
    match cell {
        calamine::Data::Empty => String::new(),
        calamine::Data::String(s) => s.clone(),
        calamine::Data::Float(f) => {
            // 3 and 3.0 are the same cell to Excel; showing "3" is what the
            // sheet itself shows.
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                f.to_string()
            }
        }
        calamine::Data::Int(i) => i.to_string(),
        calamine::Data::Bool(b) => b.to_string(),
        calamine::Data::DateTime(d) => excel_date_text(d),
        calamine::Data::DateTimeIso(s) => s.clone(),
        calamine::Data::DurationIso(s) => s.clone(),
        calamine::Data::Error(e) => error_text(e),
    }
}

/// What the sheet itself prints in an error cell.
///
/// The debug name of calamine's enum is not it: `#Div0` appears in no
/// spreadsheet anywhere, and a reader comparing the preview against Excel
/// would take it for a fault in the preview rather than in their formula.
fn error_text(e: &calamine::CellErrorType) -> String {
    use calamine::CellErrorType::*;
    match e {
        Div0 => "#DIV/0!",
        NA => "#N/A",
        Name => "#NAME?",
        Null => "#NULL!",
        Num => "#NUM!",
        Ref => "#REF!",
        Value => "#VALUE!",
        GettingData => "#GETTING_DATA",
    }
    .to_string()
}

/// A date cell as the sheet shows it, not as Excel stores it.
///
/// `ExcelDateTime`'s own Display prints the serial number — 46056 for what the
/// spreadsheet shows as 2026/02/03 — so the conversion has to be asked for.
/// The cell's own number format is not carried over: one ISO-ish shape reads
/// the same to everyone, which a preview of someone else's file needs more
/// than it needs to match their locale.
fn excel_date_text(d: &calamine::ExcelDateTime) -> String {
    if d.is_duration() {
        // An elapsed-time cell ([hh]:mm) is not a point in time and must not be
        // rendered as one; 36 hours is not "1900-01-01 12:00".
        return match d.as_duration() {
            Some(dur) => format!("{}:{:02}:{:02}",
                dur.num_hours(), dur.num_minutes() % 60, dur.num_seconds() % 60),
            None => d.as_f64().to_string(),
        };
    }
    match d.as_datetime() {
        // Midnight means the cell is a date, not a date at 00:00.
        Some(dt) if dt.time() == chrono::NaiveTime::MIN => dt.format("%Y-%m-%d").to_string(),
        Some(dt) if dt.time().format("%S").to_string() == "00" =>
            dt.format("%Y-%m-%d %H:%M").to_string(),
        Some(dt) => dt.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => d.as_f64().to_string(),
    }
}

// ---------------------------------------------------------------------------
// OOXML zip plumbing (.docx / .pptx)
// ---------------------------------------------------------------------------

type Archive = zip::ZipArchive<Cursor<Vec<u8>>>;

fn open_ooxml(bytes: Vec<u8>) -> Result<Archive, String> {
    zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Not a readable Office file: {}", e))
}

fn part(zip: &mut Archive, name: &str) -> Option<String> {
    let mut entry = zip.by_name(name).ok()?;
    let mut xml = String::new();
    entry.read_to_string(&mut xml).ok()?;
    Some(xml)
}

/// The `w:val` / `type` / `lvl` style of attribute lookup, by qualified name.
fn attr(e: &quick_xml::events::BytesStart, name: &[u8]) -> Option<String> {
    for a in e.attributes().flatten() {
        if a.key.as_ref() == name {
            return Some(String::from_utf8_lossy(a.value.as_ref()).to_string());
        }
    }
    None
}

/// Collapse the runs of whitespace a run-split paragraph leaves behind.
fn tidy(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

/// Turn `word/document.xml` into a flat list of blocks.
///
/// Element names are matched with their `w:` prefix rather than by local name.
/// Every producer of .docx writes that prefix, and the local name `tab` is
/// ambiguous — `w:tabs/w:tab` declares tab STOPS in paragraph properties and
/// would otherwise inject whitespace into headings that merely set them.
fn read_docx(bytes: Vec<u8>) -> Result<OfficePreview, String> {
    let mut zip = open_ooxml(bytes)?;
    let xml = part(&mut zip, "word/document.xml")
        .ok_or_else(|| "This .docx has no word/document.xml part.".to_string())?;

    let mut preview = OfficePreview::new("document");
    preview.blocks = read_docx_body(&xml)?;
    Ok(preview)
}

fn read_docx_body(xml: &str) -> Result<Vec<DocBlock>, String> {
    let mut blocks: Vec<DocBlock> = Vec::new();

    let mut reader = Reader::from_str(xml);
    reader.trim_text(false);

    // Paragraph being read.
    let mut para = String::new();
    let mut style: Option<String> = None;
    let mut is_list = false;
    let mut ilvl = 0usize;
    let mut in_text = false;

    // Table being read. Depth, not a bool: a nested table's cells are folded
    // into the outer cell rather than producing a second table block.
    let mut tbl_depth = 0usize;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();

    loop {
        match reader.read_event() {
            Err(e) => return Err(format!("word/document.xml is malformed: {}", e)),
            Ok(Event::Eof) => break,

            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"w:tbl" => {
                    tbl_depth += 1;
                    if tbl_depth == 1 {
                        rows.clear();
                    }
                }
                b"w:tr" if tbl_depth == 1 => row.clear(),
                b"w:tc" if tbl_depth == 1 => cell.clear(),
                b"w:p" => {
                    para.clear();
                    style = None;
                    is_list = false;
                    ilvl = 0;
                }
                b"w:pStyle" => style = attr(&e, b"w:val"),
                b"w:numPr" => is_list = true,
                b"w:ilvl" => {
                    ilvl = attr(&e, b"w:val").and_then(|v| v.parse().ok()).unwrap_or(0)
                }
                b"w:t" => in_text = true,
                _ => {}
            },

            Ok(Event::Empty(e)) => match e.name().as_ref() {
                b"w:pStyle" => style = attr(&e, b"w:val"),
                b"w:ilvl" => {
                    ilvl = attr(&e, b"w:val").and_then(|v| v.parse().ok()).unwrap_or(0)
                }
                b"w:br" | b"w:cr" | b"w:tab" => para.push(' '),
                _ => {}
            },

            Ok(Event::Text(t)) if in_text => {
                para.push_str(&t.unescape().unwrap_or_default());
            }

            Ok(Event::End(e)) => match e.name().as_ref() {
                b"w:t" => in_text = false,
                b"w:p" => {
                    let text = tidy(&para);
                    if tbl_depth > 0 {
                        if !text.is_empty() {
                            if !cell.is_empty() {
                                cell.push('\n');
                            }
                            cell.push_str(&text);
                        }
                    } else if !text.is_empty() && blocks.len() < MAX_BLOCKS {
                        blocks.push(docx_block(style.as_deref(), is_list, ilvl, text));
                    }
                    para.clear();
                }
                b"w:tc" if tbl_depth == 1 => row.push(std::mem::take(&mut cell)),
                b"w:tr" if tbl_depth == 1 => rows.push(std::mem::take(&mut row)),
                b"w:tbl" => {
                    tbl_depth = tbl_depth.saturating_sub(1);
                    if tbl_depth == 0 && !rows.is_empty() && blocks.len() < MAX_BLOCKS {
                        blocks.push(DocBlock {
                            kind: "table".to_string(),
                            level: 0,
                            text: String::new(),
                            rows: std::mem::take(&mut rows),
                        });
                    }
                }
                _ => {}
            },

            _ => {}
        }
    }

    Ok(blocks)
}

/// Which kind of block a paragraph's style makes it.
///
/// Only the English style IDs are recognised, which is not the limitation it
/// looks like: Word stores the built-in styles under their English IDs whatever
/// the UI language, and localises only the display name.
fn docx_block(style: Option<&str>, is_list: bool, ilvl: usize, text: String) -> DocBlock {
    if let Some(s) = style {
        let s = s.replace(' ', "");
        if s.eq_ignore_ascii_case("Title") {
            return DocBlock::text_block("heading", 1, text);
        }
        if s.eq_ignore_ascii_case("Subtitle") {
            return DocBlock::text_block("heading", 2, text);
        }
        if let Some(rest) = s.strip_prefix("Heading").or_else(|| s.strip_prefix("heading")) {
            if let Ok(level) = rest.parse::<usize>() {
                return DocBlock::text_block("heading", level.clamp(1, 6), text);
            }
        }
        // A list can come from the STYLE instead of from numbering on the
        // paragraph: "ListBullet2" carries both the bullet and the depth, and
        // the paragraph has no <w:numPr> at all. Looking only for numbering
        // rendered those documents as flat prose — every bullet in them lost.
        //
        // "ListParagraph" is deliberately not here. Word applies it to
        // anything indented, list or not, and the ones that really are lists
        // carry numbering anyway, which `is_list` already catches.
        for prefix in ["ListBullet", "ListNumber", "ListContinue"] {
            if let Some(rest) = strip_prefix_ci(&s, prefix) {
                // The trailing digit is 1-based in the style name and 0-based
                // as a depth: ListBullet2 is one level in.
                let level = rest.parse::<usize>().unwrap_or(1).saturating_sub(1);
                return DocBlock::text_block("list", level.min(6), text);
            }
        }
    }
    if is_list {
        return DocBlock::text_block("list", ilvl, text);
    }
    DocBlock::text_block("paragraph", 0, text)
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    if text.len() >= prefix.len() && text[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&text[prefix.len()..])
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

fn read_pptx(bytes: Vec<u8>) -> Result<OfficePreview, String> {
    let mut zip = open_ooxml(bytes)?;

    let parts = slide_parts(&mut zip);
    if parts.is_empty() {
        return Err("This .pptx has no slides in it.".to_string());
    }

    let mut preview = OfficePreview::new("slides");

    for (index, slide_part) in parts.iter().enumerate() {
        let Some(xml) = part(&mut zip, slide_part) else { continue };
        let drawing = read_drawing_text(&xml)?;

        let mut title = String::new();
        let mut bullets = Vec::new();
        for shape in drawing.shapes {
            if shape.placeholder.as_deref() == Some("title")
                || shape.placeholder.as_deref() == Some("ctrTitle")
            {
                if title.is_empty() {
                    title = shape
                        .paragraphs
                        .iter()
                        .map(|p| p.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    continue;
                }
            }
            bullets.extend(shape.paragraphs);
        }

        let notes = notes_part(&mut zip, slide_part)
            .and_then(|path| part(&mut zip, &path))
            .and_then(|xml| read_drawing_text(&xml).ok())
            .map(|drawing| {
                drawing
                    .shapes
                    .into_iter()
                    // The notes page carries the slide-number placeholder too;
                    // a stray "7" under every slide's notes is noise.
                    .filter(|s| s.placeholder.as_deref() != Some("sldNum"))
                    .flat_map(|s| s.paragraphs)
                    .map(|p| p.text)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();

        preview.slides.push(SlidePreview {
            number: index + 1,
            title,
            bullets,
            notes,
            pictures: drawing.pictures,
        });
    }

    Ok(preview)
}

/// The slide parts, in the order the deck presents them.
///
/// Taken from `presentation.xml`'s `sldIdLst` through the relationships rather
/// than from the file names: reordering slides in PowerPoint rewrites that list
/// and leaves `slide1.xml` where it was, so a reordered deck read by file
/// number comes out shuffled. The numeric scan below is the fallback, for a
/// package whose `presentation.xml` will not parse.
fn slide_parts(zip: &mut Archive) -> Vec<String> {
    let rels = read_rels(zip, "ppt/presentation.xml");
    if let Some(xml) = part(zip, "ppt/presentation.xml") {
        let mut ordered = Vec::new();
        let mut reader = Reader::from_str(&xml);
        reader.trim_text(true);
        let mut in_list = false;
        loop {
            match reader.read_event() {
                Err(_) | Ok(Event::Eof) => break,
                Ok(Event::Start(e)) if e.name().as_ref() == b"p:sldIdLst" => in_list = true,
                Ok(Event::End(e)) if e.name().as_ref() == b"p:sldIdLst" => break,
                Ok(Event::Start(e)) | Ok(Event::Empty(e))
                    if in_list && e.name().as_ref() == b"p:sldId" =>
                {
                    if let Some(id) = attr(&e, b"r:id") {
                        if let Some(target) = rels.get(&id) {
                            ordered.push(target.clone());
                        }
                    }
                }
                _ => {}
            }
        }
        if !ordered.is_empty() {
            return ordered;
        }
    }

    let mut numbers: Vec<usize> = zip
        .file_names()
        .filter_map(|n| slide_number(n, "ppt/slides/slide"))
        .collect();
    numbers.sort_unstable();
    numbers
        .into_iter()
        .map(|n| format!("ppt/slides/slide{}.xml", n))
        .collect()
}

/// The notes page belonging to one slide, if it has one.
///
/// Followed through the slide's own relationships. Notes parts are numbered in
/// the order they were CREATED, not by the slide they belong to: in a deck
/// where only the second slide has notes they live in `notesSlide1.xml`, and
/// pairing by number files them under slide 1 — words in the preview that the
/// author wrote about a different slide.
fn notes_part(zip: &mut Archive, slide_part: &str) -> Option<String> {
    rels_of(zip, slide_part)
        .into_iter()
        .find(|(_, kind, _)| kind.ends_with("/notesSlide"))
        .map(|(_, _, target)| target)
}

/// `rId` -> the part it points at, as a path from the root of the package.
fn read_rels(zip: &mut Archive, part_path: &str) -> HashMap<String, String> {
    rels_of(zip, part_path)
        .into_iter()
        .map(|(id, _, target)| (id, target))
        .collect()
}

/// A part's relationships, as (id, type, resolved target).
fn rels_of(zip: &mut Archive, part_path: &str) -> Vec<(String, String, String)> {
    let (dir, file) = part_path.rsplit_once('/').unwrap_or(("", part_path));
    let rels_path = if dir.is_empty() {
        format!("_rels/{}.rels", file)
    } else {
        format!("{}/_rels/{}.rels", dir, file)
    };
    let Some(xml) = part(zip, &rels_path) else { return Vec::new() };

    let mut out = Vec::new();
    let mut reader = Reader::from_str(&xml);
    reader.trim_text(true);
    loop {
        match reader.read_event() {
            Err(_) | Ok(Event::Eof) => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.name().as_ref() == b"Relationship" => {
                // An external relationship (a hyperlink) points outside the
                // package, and is not a part to go and read.
                if attr(&e, b"TargetMode").as_deref() == Some("External") {
                    continue;
                }
                let id = attr(&e, b"Id").unwrap_or_default();
                let kind = attr(&e, b"Type").unwrap_or_default();
                if let Some(target) = attr(&e, b"Target") {
                    out.push((id, kind, resolve_part(part_path, &target)));
                }
            }
            _ => {}
        }
    }
    out
}

/// A relationship target, which is written relative to the folder of the part
/// that declares it, as a path from the root of the package.
fn resolve_part(from_part: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_string();
    }
    let dir = from_part.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let mut segments: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for step in target.split('/') {
        match step {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            name => segments.push(name),
        }
    }
    segments.join("/")
}

fn slide_number(name: &str, prefix: &str) -> Option<usize> {
    name.strip_prefix(prefix)?.strip_suffix(".xml")?.parse().ok()
}

struct Drawing {
    shapes: Vec<Shape>,
    pictures: usize,
}

struct Shape {
    /// `p:ph type="…"` — "title", "ctrTitle", "body", "sldNum", …
    placeholder: Option<String>,
    paragraphs: Vec<Bullet>,
}

/// Pull the text out of a DrawingML part (a slide, or a notes slide).
///
/// Shapes are kept separate because the title is identified by its placeholder,
/// not by being first: plenty of decks put the title box below the body.
fn read_drawing_text(xml: &str) -> Result<Drawing, String> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(false);

    let mut shapes: Vec<Shape> = Vec::new();
    let mut pictures = 0usize;
    let mut current: Option<Shape> = None;
    let mut para = String::new();
    let mut level = 0usize;
    let mut in_para = false;
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Err(e) => return Err(format!("A slide part is malformed: {}", e)),
            Ok(Event::Eof) => break,

            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"p:sp" | b"p:graphicFrame" | b"p:pic" => {
                    if e.name().as_ref() == b"p:pic" {
                        pictures += 1;
                    }
                    current = Some(Shape { placeholder: None, paragraphs: Vec::new() });
                }
                b"p:ph" => {
                    if let Some(s) = current.as_mut() {
                        // No `type` means the body placeholder, which is what
                        // PowerPoint omits it for.
                        s.placeholder = Some(attr(&e, b"type").unwrap_or_else(|| "body".into()));
                    }
                }
                b"a:p" => {
                    in_para = true;
                    para.clear();
                    level = 0;
                }
                b"a:pPr" => {
                    level = attr(&e, b"lvl").and_then(|v| v.parse().ok()).unwrap_or(0)
                }
                b"a:t" => in_text = true,
                _ => {}
            },

            Ok(Event::Empty(e)) => match e.name().as_ref() {
                b"p:ph" => {
                    if let Some(s) = current.as_mut() {
                        s.placeholder = Some(attr(&e, b"type").unwrap_or_else(|| "body".into()));
                    }
                }
                b"a:pPr" => {
                    level = attr(&e, b"lvl").and_then(|v| v.parse().ok()).unwrap_or(0)
                }
                b"a:br" => para.push(' '),
                _ => {}
            },

            Ok(Event::Text(t)) if in_text && in_para => {
                para.push_str(&t.unescape().unwrap_or_default());
            }

            Ok(Event::End(e)) => match e.name().as_ref() {
                b"a:t" => in_text = false,
                b"a:p" => {
                    in_para = false;
                    let text = tidy(&para);
                    if !text.is_empty() {
                        let shape = current.get_or_insert(Shape {
                            placeholder: None,
                            paragraphs: Vec::new(),
                        });
                        shape.paragraphs.push(Bullet { level, text });
                    }
                    para.clear();
                }
                b"p:sp" | b"p:graphicFrame" | b"p:pic" => {
                    if let Some(s) = current.take() {
                        if !s.paragraphs.is_empty() {
                            shapes.push(s);
                        }
                    }
                }
                _ => {}
            },

            _ => {}
        }
    }

    // A part that never closed its last shape (or never opened one) still has
    // text worth showing.
    if let Some(s) = current.take() {
        if !s.paragraphs.is_empty() {
            shapes.push(s);
        }
    }

    Ok(Drawing { shapes, pictures })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an OOXML package in memory. Stored, not deflated — a test should
    /// not depend on the compressor to prove the reader works.
    fn package(parts: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let mut out = Vec::new();
        {
            let mut w = zip::ZipWriter::new(Cursor::new(&mut out));
            let opts: zip::write::FileOptions<()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, body) in parts {
                w.start_file(*name, opts).unwrap();
                w.write_all(body.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        out
    }

    #[test]
    fn a_workbook_comes_back_as_rows_of_values() {
        // The smallest package calamine will accept as a workbook. Worth
        // carrying so the whole path — zip, relationships, sheet — is under
        // test and not just the loop over the parsed range.
        let bytes = package(&[
            ("[Content_Types].xml", r#"<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#),
            ("_rels/.rels", r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#),
            ("xl/workbook.xml", r#"<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Orders" sheetId="1" r:id="rId1"/></sheets></workbook>"#),
            ("xl/_rels/workbook.xml.rels", r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#),
            ("xl/worksheets/sheet1.xml", r#"<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:B4"/><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Bolt</t></is></c><c r="B2"><v>12</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Nut</t></is></c><c r="B3"><v>4.5</v></c></row>
<row r="4"/>
</sheetData></worksheet>"#),
        ]);

        let preview = read_workbook(bytes, "xlsx").unwrap();
        assert_eq!(preview.kind, "sheets");
        assert_eq!(preview.sheets.len(), 1);

        let sheet = &preview.sheets[0];
        assert_eq!(sheet.name, "Orders");
        // The trailing blank row is dropped — a used range Excel padded out
        // would otherwise show as empty lines under the data.
        assert_eq!(sheet.rows.len(), 3);
        assert_eq!(sheet.rows[1], vec!["Bolt".to_string(), "12".to_string()]);
        assert_eq!(sheet.rows[2][1], "4.5");
        // …and dropping it is not truncation. Saying otherwise would have the
        // view claim rows are missing when none are.
        assert!(!sheet.truncated);
    }

    #[test]
    fn a_package_with_no_presentation_part_falls_back_to_file_order() {
        let slide = |body: &str| format!(r#"<?xml version="1.0"?>
<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
  <p:txBody><a:p><a:r><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>"#, body);

        let notes = r#"<?xml version="1.0"?>
<p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr>
  <p:txBody><a:p><a:r><a:t>2</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
  <p:txBody><a:p><a:r><a:t>Keep this short.</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>"#;

        let bytes = package(&[
            // Deliberately out of order in the archive, and with a layout part
            // that must not be mistaken for a slide.
            ("ppt/slides/slide2.xml", &slide("Second")),
            ("ppt/slideLayouts/slideLayout1.xml", &slide("Not a slide")),
            ("ppt/slides/slide1.xml", &slide("First")),
        ]);
        let _ = notes;

        let preview = read_pptx(bytes).unwrap();
        assert_eq!(preview.kind, "slides");
        // With nothing better to go on, numbered order — whatever order the zip
        // happens to store the parts in.
        let titles: Vec<&str> = preview.slides.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, vec!["First", "Second"]);
        assert_eq!(preview.slides[1].number, 2);
    }

    #[test]
    fn a_relationship_target_resolves_against_the_part_that_declares_it() {
        assert_eq!(
            resolve_part("ppt/slides/slide2.xml", "../notesSlides/notesSlide1.xml"),
            "ppt/notesSlides/notesSlide1.xml"
        );
        assert_eq!(
            resolve_part("ppt/presentation.xml", "slides/slide3.xml"),
            "ppt/slides/slide3.xml"
        );
        // A leading slash is already a path from the root of the package.
        assert_eq!(resolve_part("ppt/presentation.xml", "/ppt/slides/slide1.xml"),
                   "ppt/slides/slide1.xml");
    }

    #[test]
    fn a_deck_is_read_in_its_own_order_with_its_own_notes() {
        // The two traps this guards, both of which a real deck walks into:
        //
        //   * slide1.xml is the SECOND slide here. Reordering slides in
        //     PowerPoint rewrites sldIdLst and leaves the file names alone, so
        //     reading by file number shuffles the deck.
        //   * the notes belong to the second slide but live in notesSlide1.xml,
        //     because notes parts are numbered as they are created. Pairing by
        //     number puts them under the wrong slide — text in the preview that
        //     the author wrote about something else.
        let slide = |t: &str| format!(r#"<?xml version="1.0"?>
<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
  <p:txBody><a:p><a:r><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>"#, t);

        let rel = |id: &str, kind: &str, target: &str| format!(
            r#"<Relationship Id="{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{}" Target="{}"/>"#,
            id, kind, target);
        let rels = |body: String| format!(
            r#"<?xml version="1.0"?><Relationships xmlns="r">{}</Relationships>"#, body);

        let presentation = r#"<?xml version="1.0"?>
<p:presentation xmlns:p="p" xmlns:r="r">
<p:sldIdLst><p:sldId id="256" r:id="rA"/><p:sldId id="257" r:id="rB"/></p:sldIdLst>
</p:presentation>"#;

        let notes = r#"<?xml version="1.0"?>
<p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr>
  <p:txBody><a:p><a:r><a:t>2</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
  <p:txBody><a:p><a:r><a:t>Keep this short.</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>"#;

        let pres_rels = rels(format!("{}{}",
            rel("rA", "slide", "slides/slide2.xml"),
            rel("rB", "slide", "slides/slide1.xml")));
        // Only the second-presented slide (slide1.xml) has notes.
        let slide1_rels = rels(rel("rN", "notesSlide", "../notesSlides/notesSlide1.xml"));

        let bytes = package(&[
            ("ppt/presentation.xml", presentation),
            ("ppt/_rels/presentation.xml.rels", &pres_rels),
            ("ppt/slides/slide1.xml", &slide("Presented second")),
            ("ppt/slides/_rels/slide1.xml.rels", &slide1_rels),
            ("ppt/slides/slide2.xml", &slide("Presented first")),
            ("ppt/notesSlides/notesSlide1.xml", notes),
        ]);

        let preview = read_pptx(bytes).unwrap();
        let titles: Vec<&str> = preview.slides.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, vec!["Presented first", "Presented second"]);

        // Numbered by where they appear, not by what the file is called.
        assert_eq!(preview.slides[0].number, 1);
        assert_eq!(preview.slides[1].number, 2);

        assert_eq!(preview.slides[0].notes, "");
        assert_eq!(preview.slides[1].notes, "Keep this short.");
    }

    #[test]
    fn a_bulleted_style_is_a_list_even_with_no_numbering_on_it() {
        // Word writes a list two ways. The toolbar button puts <w:numPr> on the
        // paragraph; applying the style does not, and leaves only the style
        // name. Reading just the first way turned every bullet in such a
        // document into flat prose.
        let plain = docx_block(Some("ListBullet"), false, 0, "x".into());
        assert_eq!((plain.kind.as_str(), plain.level), ("list", 0));

        // The digit in the style name is 1-based; the depth is 0-based.
        assert_eq!(docx_block(Some("ListBullet2"), false, 0, "x".into()).level, 1);
        assert_eq!(docx_block(Some("List Number 3"), false, 0, "x".into()).level, 2);

        // Not ListParagraph: Word gives it to anything indented, and the ones
        // that really are lists carry numbering anyway.
        assert_eq!(docx_block(Some("ListParagraph"), false, 0, "x".into()).kind, "paragraph");
        assert_eq!(docx_block(Some("ListParagraph"), true, 1, "x".into()).kind, "list");
    }

    #[test]
    fn a_document_is_read_out_of_the_package() {
        let bytes = package(&[("word/document.xml", r#"<?xml version="1.0"?>
<w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Scope</w:t></w:r></w:p>
<w:p><w:r><w:t>One line.</w:t></w:r></w:p>
</w:body></w:document>"#)]);

        let preview = read_docx(bytes).unwrap();
        assert_eq!(preview.kind, "document");
        assert_eq!(preview.blocks.len(), 2);
        assert_eq!(preview.blocks[0].kind, "heading");
    }

    #[test]
    fn a_package_with_nothing_readable_in_it_says_so() {
        // A .pptx that is really a renamed zip, or a .docx whose main part is
        // missing: the reader has to fail with a sentence, not an empty tab.
        let empty = package(&[("docProps/app.xml", "<x/>")]);
        assert!(read_docx(empty.clone()).is_err());
        assert!(read_pptx(empty).is_err());
        assert!(open_ooxml(b"not a zip at all".to_vec()).is_err());
    }

    #[test]
    fn the_shell_is_only_ever_handed_a_file_this_can_preview() {
        // Opening with the default handler is a shell execute: for an .exe it
        // means running it. Both guards are refusals, so neither of these
        // launches anything.
        assert!(open_office_file("C:/windows/system32/calc.exe".into()).is_err());
        assert!(open_office_file("notes.md".into()).is_err());
        // The right extension is not enough — the file has to be there.
        assert!(open_office_file("C:/nowhere/absent.xlsx".into()).is_err());
    }

    #[test]
    fn recognises_the_extensions_it_can_read() {
        assert!(is_office_path("C:/work/report.xlsx"));
        assert!(is_office_path("/home/a/Book.XLS"));
        assert!(is_office_path("deck.pptx"));
        assert!(is_office_path("spec.docx"));
        // Formats with no reader here must not be claimed, or the frontend
        // routes them into a preview that can only fail.
        assert!(!is_office_path("old.doc"));
        assert!(!is_office_path("old.ppt"));
        assert!(!is_office_path("notes.md"));
        assert!(!is_office_path("xlsx"));
    }

    #[test]
    fn a_heading_style_outranks_a_plain_paragraph() {
        let h = docx_block(Some("Heading2"), false, 0, "Scope".into());
        assert_eq!(h.kind, "heading");
        assert_eq!(h.level, 2);

        // Word writes "Heading 3" with a space in some documents.
        assert_eq!(docx_block(Some("Heading 3"), false, 0, "x".into()).level, 3);
        assert_eq!(docx_block(Some("Title"), false, 0, "x".into()).kind, "heading");

        // A numbered paragraph is a list, and its indent survives.
        let l = docx_block(None, true, 2, "item".into());
        assert_eq!((l.kind.as_str(), l.level), ("list", 2));

        assert_eq!(docx_block(Some("BodyText"), false, 0, "x".into()).kind, "paragraph");
        // Heading10 is not a heading level Word has; clamped rather than trusted.
        assert_eq!(docx_block(Some("Heading10"), false, 0, "x".into()).level, 6);
    }

    #[test]
    fn slide_numbers_come_out_of_the_part_names() {
        assert_eq!(slide_number("ppt/slides/slide12.xml", "ppt/slides/slide"), Some(12));
        assert_eq!(slide_number("ppt/slides/_rels/slide1.xml.rels", "ppt/slides/slide"), None);
        assert_eq!(slide_number("ppt/slideLayouts/slideLayout1.xml", "ppt/slides/slide"), None);
    }

    #[test]
    fn a_slide_keeps_its_title_apart_from_its_bullets() {
        let xml = r#"<?xml version="1.0"?>
<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
    <p:txBody>
      <a:p><a:r><a:t>First point</a:t></a:r></a:p>
      <a:p><a:pPr lvl="1"/><a:r><a:t>Nested </a:t></a:r><a:r><a:t>point</a:t></a:r></a:p>
    </p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
    <p:txBody><a:p><a:r><a:t>Quarter in review</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>"#;

        let shapes = read_drawing_text(xml).unwrap().shapes;
        assert_eq!(shapes.len(), 2);

        // Runs inside one paragraph join into one bullet, and the title is
        // found by its placeholder even though the body shape comes first.
        assert_eq!(shapes[0].placeholder.as_deref(), Some("body"));
        assert_eq!(shapes[0].paragraphs[0].text, "First point");
        assert_eq!(shapes[0].paragraphs[1].text, "Nested point");
        assert_eq!(shapes[0].paragraphs[1].level, 1);
        assert_eq!(shapes[1].placeholder.as_deref(), Some("title"));
        assert_eq!(shapes[1].paragraphs[0].text, "Quarter in review");
    }

    #[test]
    fn a_document_keeps_its_shape_and_its_tables() {
        // `w:tabs/w:tab` sets tab STOPS — it is not a tab character, and
        // matching on the local name `tab` used to smuggle one into the
        // heading. Kept in the fixture so the distinction stays tested.
        let xml = r#"<?xml version="1.0"?>
<w:document xmlns:w="w"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>
     <w:r><w:t>Scope</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">The plan </w:t></w:r><w:r><w:t>in one line.</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr>
     <w:r><w:t>An indented item</w:t></w:r></w:p>
  <w:p/>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Qty</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Bolt</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
</w:body></w:document>"#;

        let blocks = read_docx_body(xml).unwrap();
        // The empty <w:p/> contributes nothing — a preview full of blank rows
        // is how a Word document with spacing paragraphs reads otherwise.
        assert_eq!(blocks.len(), 4);

        assert_eq!((blocks[0].kind.as_str(), blocks[0].level), ("heading", 1));
        assert_eq!(blocks[0].text, "Scope");
        // Runs split mid-sentence join back up with exactly one space.
        assert_eq!(blocks[1].text, "The plan in one line.");
        assert_eq!((blocks[2].kind.as_str(), blocks[2].level), ("list", 1));
        assert_eq!(blocks[3].kind, "table");
        assert_eq!(blocks[3].rows, vec![
            vec!["Name".to_string(), "Qty".to_string()],
            vec!["Bolt".to_string(), "12".to_string()],
        ]);
    }

    #[test]
    fn an_error_cell_says_what_the_sheet_says() {
        use calamine::CellErrorType;
        // The enum's debug name is "Div0", which appears in no spreadsheet
        // anywhere — a reader would read it as a fault in the preview.
        assert_eq!(cell_text(&calamine::Data::Error(CellErrorType::Div0)), "#DIV/0!");
        assert_eq!(cell_text(&calamine::Data::Error(CellErrorType::Ref)), "#REF!");
        assert_eq!(cell_text(&calamine::Data::Error(CellErrorType::NA)), "#N/A");
    }

    #[test]
    fn a_date_cell_reads_as_a_date_and_not_as_its_serial_number() {
        use calamine::{Data, ExcelDateTime, ExcelDateTimeType};

        // 45383 is 2024-04-01. Excel stores that number; the sheet shows the
        // date, and so must the preview — ExcelDateTime's own Display prints
        // the number, which is the trap this guards.
        let date = ExcelDateTime::new(45383.0, ExcelDateTimeType::DateTime, false);
        assert_eq!(cell_text(&Data::DateTime(date)), "2024-04-01");

        // Midnight means the cell is a date, not a date at 00:00.
        let noon = ExcelDateTime::new(45383.5, ExcelDateTimeType::DateTime, false);
        assert_eq!(cell_text(&Data::DateTime(noon)), "2024-04-01 12:00");

        // An elapsed-time cell is a span, not a point: 36 hours must not come
        // back as a day in January 1900.
        let span = ExcelDateTime::new(1.5, ExcelDateTimeType::TimeDelta, false);
        assert_eq!(cell_text(&Data::DateTime(span)), "36:00:00");
    }

    #[test]
    fn a_number_that_is_whole_reads_as_a_whole_number() {
        // Excel stores every number as a float; "3.0" in a quantity column is
        // not what the sheet shows.
        assert_eq!(cell_text(&calamine::Data::Float(3.0)), "3");
        assert_eq!(cell_text(&calamine::Data::Float(3.5)), "3.5");
        assert_eq!(cell_text(&calamine::Data::Empty), "");
    }




}
