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
/// Merged ranges kept per sheet. A grid-paper drawing can have thousands; a
/// sheet with more than this is not something a preview can help with anyway.
const MAX_MERGES: usize = 10_000;

/// Pixels per character of Excel's column-width unit.
///
/// The unit is "how many '0' characters fit", measured in the workbook's
/// default font, so the true figure depends on that font. 7 is the value for
/// Calibri 11 at 96dpi, which is what an .xlsx written this decade has unless
/// someone changed it — and being a few pixels out on a column is invisible
/// next to getting its width from the wrong thing entirely.
const COL_UNIT_PX: f64 = 7.0;
/// Excel's own padding inside a column: two pixels of margin either side plus
/// the gridline.
const COL_PADDING_PX: f64 = 5.0;
/// Row heights are in points, and everything here is in CSS pixels.
const PT_TO_PX: f64 = 96.0 / 72.0;

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
    /// The sheet's own geometry, when the format records it. None for the
    /// formats whose widths this cannot read (see read_sheet_layouts).
    pub layout: Option<SheetLayout>,
}

/// How the sheet is laid out, in CSS pixels.
///
/// Sizing columns from their contents is a reasonable guess for a list of
/// data and quite wrong for a document. A Japanese 設計書 is often drawn on
/// a grid of 2.5-character columns, with the boxes made of merged cells;
/// measured and re-fitted, that comes out as forty fat columns with no
/// relation to the page anyone wrote.
#[derive(Debug, Clone, Serialize)]
pub struct SheetLayout {
    /// One per column of `rows`. Empty when the sheet declares nothing.
    pub col_widths: Vec<f64>,
    /// One per kept row. Empty when every row is the default height.
    pub row_heights: Vec<f64>,
    pub merges: Vec<Merge>,
    /// Whether the sheet is drawn with Excel's faint background grid. Sheets
    /// laid out as documents usually turn it off, and honouring that is most
    /// of the difference between "a spreadsheet" and "the page they wrote".
    pub gridlines: bool,
    /// What a column with no width of its own is, in px. Used to pad the view
    /// out to the edge of the window.
    pub default_col_width: f64,
    /// The distinct cell formats this sheet uses. Index 0 is always the plain
    /// one, so a cell that says nothing can say 0.
    pub styles: Vec<CellStyle>,
    /// An index into `styles` per cell, shaped like `rows`. Empty when every
    /// cell is plain — which is most spreadsheets, and the whole grid would
    /// otherwise be a second copy of the sheet made of zeroes.
    pub style_ids: Vec<Vec<usize>>,
}

/// As much of a cell's format as a read-only preview can honestly show.
///
/// Not the font, the fill or the colour of anything: those decide how a
/// document LOOKS, and a preview that half-applies them looks broken rather
/// than plain. These three decide how it READS — where the boxes are, whether
/// a paragraph wraps, and where the text sits in its cell.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CellStyle {
    /// "", "thin", "thick", "double", "dashed" or "dotted", per edge.
    pub top: String,
    pub right: String,
    pub bottom: String,
    pub left: String,
    pub wrap: bool,
    /// "", "left", "center" or "right".
    pub halign: String,
    /// "", "top", "center" or "bottom".
    pub valign: String,
}

impl CellStyle {
    fn is_plain(&self) -> bool {
        *self == CellStyle::default()
    }
}

/// A merged range, clipped to the rows and columns the preview kept.
/// Zero-based, and counted in cells rather than as an end coordinate.
#[derive(Debug, Clone, Serialize)]
pub struct Merge {
    pub row: usize,
    pub col: usize,
    pub rows: usize,
    pub cols: usize,
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

    // calamine reads values and nothing else — its Range::width() is a count of
    // columns, not a size, and the crate never looks at <cols> at all. So the
    // geometry is read here, from the same package, before the values are.
    // A failure is not fatal: the view falls back to sizing from content.
    let layouts = match ext {
        "xlsx" | "xlsm" => read_sheet_layouts(&bytes).unwrap_or_default(),
        _ => HashMap::new(),
    };

    let cursor = Cursor::new(bytes);
    match ext {
        "xlsx" | "xlsm" => {
            let mut wb = open_workbook_from_rs::<Xlsx<_>, _>(cursor)
                .map_err(|e| format!("Could not open the workbook: {}", e))?;
            collect_sheets(&mut wb, &layouts)
        }
        "xls" => {
            let mut wb = open_workbook_from_rs::<Xls<_>, _>(cursor)
                .map_err(|e| format!("Could not open the workbook: {}", e))?;
            collect_sheets(&mut wb, &layouts)
        }
        _ => {
            let mut wb = open_workbook_from_rs::<Ods<_>, _>(cursor)
                .map_err(|e| format!("Could not open the workbook: {}", e))?;
            collect_sheets(&mut wb, &layouts)
        }
    }
}

/// The sheet geometry in an .xlsx, keyed by sheet name.
///
/// Only the OOXML spreadsheet formats. A .xls keeps its widths in BIFF records
/// and an .ods keeps them in a stylesheet; both need a reader of their own, and
/// neither has one here, so those workbooks keep the measured-from-content
/// columns they had before.
fn read_sheet_layouts(bytes: &[u8]) -> Option<HashMap<String, RawLayout>> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).ok()?;
    let styles = part(&mut zip, "xl/styles.xml")
        .map(|x| read_style_book(&x))
        .unwrap_or_default();
    let rels = read_rels(&mut zip, "xl/workbook.xml");
    let xml = part(&mut zip, "xl/workbook.xml")?;

    // name -> part, through the relationship id, the same way the slide order
    // is read. The file names are not dependable: sheet3.xml can be the first
    // tab, and a renamed sheet keeps whatever part it was created with.
    let mut parts: Vec<(String, String)> = Vec::new();
    let mut reader = Reader::from_str(&xml);
    reader.trim_text(true);
    loop {
        match reader.read_event() {
            Err(_) | Ok(Event::Eof) => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.name().as_ref() == b"sheet" => {
                let name = attr(&e, b"name").unwrap_or_default();
                if let Some(id) = attr(&e, b"r:id") {
                    if let Some(target) = rels.get(&id) {
                        parts.push((name, target.clone()));
                    }
                }
            }
            _ => {}
        }
    }

    // Print areas are workbook-level defined names, tied to a sheet by its
    // position in the list above.
    let print_areas = read_print_areas(&xml);

    let mut out = HashMap::new();
    for (index, (name, path)) in parts.into_iter().enumerate() {
        if let Some(sheet_xml) = part(&mut zip, &path) {
            if let Some(mut layout) = read_sheet_geometry(&sheet_xml) {
                layout.styles = styles.clone();
                layout.print_area = print_areas.get(&index).copied();
                out.insert(name, layout);
            }
        }
    }
    Some(out)
}

/// The print area of each sheet, by its index in the workbook's sheet list.
///
/// Stored as a defined name rather than on the sheet:
///   <definedName name="_xlnm.Print_Area" localSheetId="0">Sheet1!$A$1:$H$40</definedName>
///
/// Worth following, because it is the author saying how far the document goes.
/// Anything past it is scratch space, and anything inside it is the page —
/// including the empty half of a form.
fn read_print_areas(workbook_xml: &str) -> HashMap<usize, (usize, usize, usize, usize)> {
    let mut out = HashMap::new();
    let mut reader = Reader::from_str(workbook_xml);
    reader.trim_text(true);

    let mut pending: Option<usize> = None;
    loop {
        match reader.read_event() {
            Err(_) | Ok(Event::Eof) => break,
            Ok(Event::Start(e)) if e.name().as_ref() == b"definedName" => {
                pending = match attr(&e, b"name").as_deref() {
                    Some("_xlnm.Print_Area") => num(&e, b"localSheetId").map(|n| n as usize),
                    _ => None,
                };
            }
            Ok(Event::Text(t)) => {
                if let Some(index) = pending.take() {
                    if let Some(range) = parse_area_ref(&t.unescape().unwrap_or_default()) {
                        out.insert(index, range);
                    }
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"definedName" => pending = None,
            _ => {}
        }
    }
    out
}

/// "Sheet1!$A$1:$H$40" -> the rectangle, dropping the sheet it names.
///
/// A print area can be several ranges, separated by commas, which print as
/// separate pages. One preview cannot be several pages, so they are taken
/// together as the rectangle that holds them all.
fn parse_area_ref(text: &str) -> Option<(usize, usize, usize, usize)> {
    let mut bounds: Option<(usize, usize, usize, usize)> = None;
    for piece in text.split(',') {
        let piece = piece.trim();
        if piece.is_empty() || piece.contains("#REF") {
            continue;
        }
        // Everything up to the last '!' is the sheet's name, which may itself
        // be quoted and contain one.
        let range = piece.rsplit_once('!').map(|(_, r)| r).unwrap_or(piece);
        let Some(r) = parse_ref(range).or_else(|| parse_cell_ref(range).map(|(a, b)| (a, b, a, b)))
        else {
            continue;
        };
        bounds = Some(match bounds {
            None => r,
            Some(b) => (b.0.min(r.0), b.1.min(r.1), b.2.max(r.2), b.3.max(r.3)),
        });
    }
    bounds
}

/// The workbook's cell formats: one entry per <xf> in <cellXfs>, in order,
/// because that order is what a cell's `s` attribute indexes.
fn read_style_book(xml: &str) -> StyleBook {
    let mut book = StyleBook::default();

    // Custom formats first: a cell names its format by id, and every id above
    // the built-in range is defined here.
    let mut codes: HashMap<usize, String> = HashMap::new();
    let mut borders: Vec<[String; 4]> = Vec::new();

    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);

    let mut in_borders = false;
    let mut in_cell_xfs = false;
    let mut edges: [String; 4] = Default::default();
    // True while an <xf> is open, so its <alignment> child knows which entry
    // it belongs to. A self-closing <xf/> has no child and no End event.
    let mut xf_open = false;

    loop {
        let (e, self_closing) = match reader.read_event() {
            Err(_) | Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => (e.into_owned(), false),
            Ok(Event::Empty(e)) => (e.into_owned(), true),
            Ok(Event::End(e)) => {
                match e.name().as_ref() {
                    b"border" if in_borders => borders.push(std::mem::take(&mut edges)),
                    b"borders" => in_borders = false,
                    b"cellXfs" => in_cell_xfs = false,
                    b"xf" => xf_open = false,
                    _ => {}
                }
                continue;
            }
            _ => continue,
        };

        match e.name().as_ref() {
            b"numFmt" => {
                if let (Some(id), Some(code)) = (num(&e, b"numFmtId"), attr(&e, b"formatCode")) {
                    codes.insert(id as usize, code);
                }
            }
            b"borders" => in_borders = true,
            b"border" if in_borders => {
                edges = Default::default();
                // <border/> with no edges at all is the plain one.
                if self_closing {
                    borders.push(Default::default());
                }
            }
            b"top" | b"right" | b"bottom" | b"left" if in_borders => {
                let slot = match e.name().as_ref() {
                    b"top" => 0,
                    b"right" => 1,
                    b"bottom" => 2,
                    _ => 3,
                };
                edges[slot] = border_kind(&attr(&e, b"style").unwrap_or_default()).to_string();
            }
            b"cellXfs" => in_cell_xfs = true,
            b"xf" if in_cell_xfs => {
                let border_id = num(&e, b"borderId").unwrap_or(0.0) as usize;
                let fmt_id = num(&e, b"numFmtId").unwrap_or(0.0) as usize;
                let mut style = CellStyle::default();
                if let Some(b) = borders.get(border_id) {
                    style.top = b[0].clone();
                    style.right = b[1].clone();
                    style.bottom = b[2].clone();
                    style.left = b[3].clone();
                }
                book.xfs.push(style);
                if let Some(code) = date_format_code(fmt_id, &codes) {
                    book.date_formats.insert(book.xfs.len() - 1, code);
                }
                xf_open = !self_closing;
            }
            b"alignment" if in_cell_xfs && xf_open => {
                if let Some(style) = book.xfs.last_mut() {
                    style.wrap = flag(&e, b"wrapText");
                    style.halign = match attr(&e, b"horizontal").as_deref() {
                        Some("left") | Some("justify") | Some("distributed") => "left",
                        Some("center") | Some("centerContinuous") => "center",
                        Some("right") => "right",
                        _ => "",
                    }
                    .to_string();
                    style.valign = match attr(&e, b"vertical").as_deref() {
                        Some("top") => "top",
                        Some("center") | Some("justify") | Some("distributed") => "center",
                        Some("bottom") => "bottom",
                        _ => "",
                    }
                    .to_string();
                }
            }
            _ => {}
        }
    }

    book
}

/// OOXML's border styles, reduced to what CSS can draw honestly.
fn border_kind(style: &str) -> &'static str {
    match style {
        "" | "none" => "",
        "hair" | "thin" => "thin",
        "medium" | "thick" => "thick",
        "double" => "double",
        "dotted" => "dotted",
        // dashed, mediumDashed, dashDot, slantDashDot and the rest all read as
        // "a broken line" at the size a preview draws them.
        _ => "dashed",
    }
}

/// The format code for a cell that holds a date, or None when it holds
/// something else.
///
/// Only dates. Implementing Excel's number formats by halves — its thousands
/// separators, its accounting brackets, its conditional colours — would be
/// wrong in more places than it was right, and a number reads fine as a
/// number. A date does not: 46056 is not a date to anybody.
fn date_format_code(fmt_id: usize, custom: &HashMap<usize, String>) -> Option<String> {
    if let Some(code) = custom.get(&fmt_id) {
        return if looks_like_a_date(code) { Some(code.clone()) } else { None };
    }
    // The built-in date and time formats. 14 is locale-dependent, and renders
    // as yyyy/m/d in a Japanese Excel — which is the audience for this.
    let code = match fmt_id {
        14 => "yyyy/m/d",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "yyyy/m/d h:mm",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mm:ss.0",
        _ => return None,
    };
    Some(code.to_string())
}

fn looks_like_a_date(code: &str) -> bool {
    // Only the first section: what follows ';' is how the cell shows text and
    // negatives, and a stray 'd' in there is not a date.
    let head = code.split(';').next().unwrap_or("");
    let mut quoted = false;
    for ch in head.chars() {
        match ch {
            '"' => quoted = !quoted,
            'y' | 'd' | 'h' | 's' if !quoted => return true,
            _ => {}
        }
    }
    false
}

/// What one worksheet part says about its own shape, in sheet coordinates.
#[derive(Clone)]
struct RawLayout {
    /// Width of a column with no <col> entry covering it, in px.
    default_col_px: Option<f64>,
    /// (first column, last column, px) — 1-based and inclusive, as written.
    cols: Vec<(usize, usize, f64)>,
    default_row_px: Option<f64>,
    /// 1-based row -> px, only for rows that set their own height.
    rows: HashMap<usize, f64>,
    /// (first row, first col, last row, last col), 1-based inclusive.
    merges: Vec<(usize, usize, usize, usize)>,
    /// (row, col) -> index into the workbook's cellXfs, 1-based coordinates.
    cell_xf: HashMap<(usize, usize), usize>,
    /// The workbook's table, copied onto each sheet so clipping needs one input.
    styles: StyleBook,
    /// <dimension ref="A1:S45">: Excel's own idea of how far the sheet goes,
    /// which unlike the range of VALUES includes cells that are only formatted.
    /// A bordered box drawn past the last word is the ordinary case in a form.
    dimension: Option<(usize, usize, usize, usize)>,
    /// The sheet's print area, when one is set.
    print_area: Option<(usize, usize, usize, usize)>,
    /// <sheetView showGridLines="0">. True unless the sheet says otherwise.
    gridlines: bool,
}

impl Default for RawLayout {
    fn default() -> Self {
        Self {
            default_col_px: None,
            cols: Vec::new(),
            default_row_px: None,
            rows: HashMap::new(),
            merges: Vec::new(),
            cell_xf: HashMap::new(),
            styles: StyleBook::default(),
            dimension: None,
            print_area: None,
            // Excel's own default, and the answer for any sheet that does not
            // write a <sheetView> at all.
            gridlines: true,
        }
    }
}

/// The workbook-wide style table, shared by every sheet in it.
#[derive(Default, Clone)]
struct StyleBook {
    /// One per cellXfs entry, in order.
    xfs: Vec<CellStyle>,
    /// cellXfs index -> the date format code that entry asks for, if any.
    /// Kept out of CellStyle because the view never sees it: the dates are
    /// already rendered by the time they leave here.
    date_formats: HashMap<usize, String>,
}

fn read_sheet_geometry(xml: &str) -> Option<RawLayout> {
    let mut out = RawLayout::default();
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);

    loop {
        match reader.read_event() {
            Err(_) | Ok(Event::Eof) => break,
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.name().as_ref() {
                b"dimension" => {
                    out.dimension = attr(&e, b"ref").and_then(|r| parse_ref(&r));
                }
                b"sheetView" => {
                    // Absent means on, which is why this reads the attribute
                    // rather than defaulting the field to false.
                    if let Some(v) = attr(&e, b"showGridLines") {
                        out.gridlines = !matches!(v.trim(), "0" | "false");
                    }
                }
                b"sheetFormatPr" => {
                    // defaultColWidth is in the same character unit as <col>.
                    // baseColWidth is the fallback Excel writes instead, and
                    // means the same thing.
                    out.default_col_px = num(&e, b"defaultColWidth")
                        .or_else(|| num(&e, b"baseColWidth"))
                        .map(col_width_px);
                    out.default_row_px = num(&e, b"defaultRowHeight").map(|h| h * PT_TO_PX);
                }
                b"col" => {
                    let (Some(min), Some(max)) = (num(&e, b"min"), num(&e, b"max")) else { continue };
                    // A hidden column is zero wide, whatever width it records.
                    let px = if flag(&e, b"hidden") {
                        0.0
                    } else {
                        match num(&e, b"width") {
                            Some(w) => col_width_px(w),
                            None => continue,
                        }
                    };
                    out.cols.push((min as usize, max as usize, px));
                }
                b"row" => {
                    let Some(r) = num(&e, b"r") else { continue };
                    if flag(&e, b"hidden") {
                        out.rows.insert(r as usize, 0.0);
                    } else if let Some(ht) = num(&e, b"ht") {
                        out.rows.insert(r as usize, ht * PT_TO_PX);
                    }
                }
                b"c" => {
                    // A cell's `s` indexes cellXfs. Only worth recording when
                    // it is not the plain one, which most cells are.
                    let Some(xf) = num(&e, b"s") else { continue };
                    if xf <= 0.0 { continue; }
                    if let Some((r, c)) = attr(&e, b"r").and_then(|r| parse_cell_ref(&r)) {
                        out.cell_xf.insert((r, c), xf as usize);
                    }
                }
                b"mergeCell" => {
                    if out.merges.len() >= MAX_MERGES {
                        continue;
                    }
                    if let Some(range) = attr(&e, b"ref").and_then(|r| parse_ref(&r)) {
                        out.merges.push(range);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    let empty = out.gridlines
        && out.dimension.is_none()
        && out.default_col_px.is_none()
        && out.cols.is_empty()
        && out.default_row_px.is_none()
        && out.rows.is_empty()
        && out.merges.is_empty()
        && out.cell_xf.is_empty();
    if empty { None } else { Some(out) }
}

/// Excel's column-width unit into pixels.
///
/// Zero stays zero: that is a hidden column, not a column five pixels wide.
fn col_width_px(width: f64) -> f64 {
    if width <= 0.0 {
        0.0
    } else {
        (width * COL_UNIT_PX + COL_PADDING_PX).round()
    }
}

fn num(e: &quick_xml::events::BytesStart, name: &[u8]) -> Option<f64> {
    attr(e, name)?.trim().parse().ok()
}

/// An OOXML boolean attribute: absent is false, and "0"/"false" are too.
fn flag(e: &quick_xml::events::BytesStart, name: &[u8]) -> bool {
    match attr(e, name) {
        Some(v) => !matches!(v.trim(), "0" | "false" | ""),
        None => false,
    }
}

/// "B3:D7" -> (3, 2, 7, 4), all 1-based and inclusive.
fn parse_ref(range: &str) -> Option<(usize, usize, usize, usize)> {
    let (a, b) = range.split_once(':')?;
    let (r1, c1) = parse_cell_ref(a)?;
    let (r2, c2) = parse_cell_ref(b)?;
    Some((r1.min(r2), c1.min(c2), r1.max(r2), c1.max(c2)))
}

/// "AB12" -> (12, 28). Letters are base-26 with no zero, so A is 1 and Z is 26.
fn parse_cell_ref(cell: &str) -> Option<(usize, usize)> {
    let mut col = 0usize;
    let mut row = 0usize;
    let mut seen_digit = false;
    for ch in cell.chars() {
        if ch.is_ascii_alphabetic() {
            if seen_digit {
                return None; // letters after digits: not a cell reference
            }
            col = col * 26 + (ch.to_ascii_uppercase() as usize - 'A' as usize + 1);
        } else if ch.is_ascii_digit() {
            seen_digit = true;
            row = row * 10 + (ch as usize - '0' as usize);
        } else if ch != '$' {
            return None;
        }
    }
    if col == 0 || row == 0 { None } else { Some((row, col)) }
}

/// Cut the sheet's geometry down to the rows and columns the preview kept.
///
/// `origin` is the sheet cell that the first kept row and column came from:
/// calamine hands back the USED range, so a sheet whose data starts at C5 has
/// its own (5, 3) sitting at (0, 0) here.
fn clip_layout(
    raw: &RawLayout,
    rows: usize,
    cols: usize,
    origin: (usize, usize),
) -> SheetLayout {
    let default_col = raw.default_col_px.unwrap_or(0.0);
    let mut col_widths = vec![default_col; cols];
    for &(min, max, px) in &raw.cols {
        // `max` is 16384 on a sheet that sets one width for everything, so the
        // loop has to be bounded by what is actually being drawn.
        let first = min.max(origin.1);
        let last = max.min(origin.1 + cols - 1);
        for c in first..=last {
            col_widths[c - origin.1] = px;
        }
    }
    // Nothing useful to say: let the view measure instead of forcing zeroes.
    if col_widths.iter().all(|w| *w <= 0.0) {
        col_widths.clear();
    }

    let mut row_heights = Vec::new();
    if raw.default_row_px.is_some() || !raw.rows.is_empty() {
        let default_row = raw.default_row_px.unwrap_or(0.0);
        row_heights = (0..rows)
            .map(|r| *raw.rows.get(&(r + origin.0)).unwrap_or(&default_row))
            .collect();
        if row_heights.iter().all(|h| *h <= 0.0) {
            row_heights.clear();
        }
    }

    let last_row = origin.0 + rows.saturating_sub(1);
    let last_col = origin.1 + cols.saturating_sub(1);
    let merges = raw
        .merges
        .iter()
        .filter_map(|&(r1, c1, r2, c2)| {
            // Clipped rather than dropped: a range running off the bottom of a
            // truncated sheet still covers what IS shown.
            if r1 > last_row || c1 > last_col || r2 < origin.0 || c2 < origin.1 {
                return None;
            }
            let (r1, c1) = (r1.max(origin.0), c1.max(origin.1));
            let (r2, c2) = (r2.min(last_row), c2.min(last_col));
            // A one-by-one "merge" is a range Excel wrote and nothing to draw.
            if r2 == r1 && c2 == c1 {
                return None;
            }
            Some(Merge {
                row: r1 - origin.0,
                col: c1 - origin.1,
                rows: r2 - r1 + 1,
                cols: c2 - c1 + 1,
            })
        })
        .collect();

    // The style grid, renumbered so it carries only the formats this sheet's
    // visible cells actually use. A workbook's cellXfs runs to hundreds of
    // entries; a sheet usually touches a dozen.
    let mut styles = vec![CellStyle::default()];
    let mut seen: HashMap<usize, usize> = HashMap::new();
    let mut style_ids: Vec<Vec<usize>> = Vec::new();
    let mut any = false;
    for r in 0..rows {
        let mut line = vec![0usize; cols];
        for c in 0..cols {
            let Some(&xf) = raw.cell_xf.get(&(r + origin.0, c + origin.1)) else { continue };
            let Some(style) = raw.styles.xfs.get(xf) else { continue };
            if style.is_plain() {
                continue;
            }
            let id = *seen.entry(xf).or_insert_with(|| {
                styles.push(style.clone());
                styles.len() - 1
            });
            line[c] = id;
            any = true;
        }
        style_ids.push(line);
    }
    if !any {
        styles.clear();
        style_ids.clear();
    }

    SheetLayout {
        col_widths,
        row_heights,
        merges,
        gridlines: raw.gridlines,
        default_col_width: raw.default_col_px.unwrap_or(0.0),
        styles,
        style_ids,
    }
}

fn collect_sheets<R, RS>(
    workbook: &mut R,
    layouts: &HashMap<String, RawLayout>,
) -> Result<OfficePreview, String>
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
                    layout: None,
                });
                continue;
            }
        };

        let raw = layouts.get(&name);
        let (origin, extent) = sheet_extent(&range, raw);
        let (total_rows, total_cols) = (extent.0, extent.1);
        let keep_rows = total_rows.min(MAX_ROWS);
        let keep_cols = total_cols.min(MAX_COLS);

        let mut rows: Vec<Vec<String>> = Vec::new();
        for r in 0..keep_rows {
            let mut out = Vec::with_capacity(keep_cols);
            for c in 0..keep_cols {
                // Absolute, and zero-based: the grid is built over the whole
                // extent now, which can reach past the cells that hold values.
                let cell = range.get_value((
                    (origin.0 + r - 1) as u32,
                    (origin.1 + c - 1) as u32,
                ));
                // A date is written the way the sheet writes it. Without the
                // cell's own format every date came out as yyyy-mm-dd, which
                // is both not what the author chose and wider than the column
                // they sized for it.
                let format = raw.and_then(|raw| {
                    let xf = raw.cell_xf.get(&(r + origin.0, c + origin.1))?;
                    raw.styles.date_formats.get(xf)
                });
                out.push(match (cell, format) {
                    (Some(calamine::Data::DateTime(d)), Some(code)) => format_excel_date(d, code),
                    (Some(value), _) => cell_text(value),
                    (None, _) => String::new(),
                });
            }
            rows.push(out);
        }

        // A used range that Excel padded out with blank rows at the bottom
        // would otherwise show as hundreds of empty lines. But "blank" has to
        // mean blank: a row of empty cells inside a bordered box is the empty
        // half of a form, which is most of what a form is, and the version
        // that only looked at values cut the frame off at the last word.
        //
        // A print area settles it outright — that is the author saying where
        // the page ends.
        let floor = raw
            .and_then(|r| r.print_area)
            .map(|pa| pa.2.saturating_sub(origin.0) + 1)
            .unwrap_or(0);
        while rows.len() > floor
            && rows.last().is_some_and(|r| r.iter().all(|c| c.is_empty()))
            && !row_is_formatted(raw, origin, rows.len() - 1, keep_cols)
        {
            rows.pop();
        }

        let layout = raw.map(|raw| clip_layout(raw, rows.len(), keep_cols, origin));

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
            layout,
        });
    }

    Ok(preview)
}

/// How far the sheet goes, and where it starts, in its own 1-based coordinates.
///
/// The range of VALUES is the wrong answer for a document. A form is mostly
/// empty cells inside a bordered box; a minutes template has its title at the
/// top and nothing below it until someone fills it in. Stopping at the last
/// word cuts the page off mid-frame, which is exactly what it looked like.
///
/// So the extent is the union of what the sheet says about itself: the values
/// calamine found, the print area if the author set one, Excel's own declared
/// dimension, and the last cell carrying a format.
fn sheet_extent(
    range: &calamine::Range<calamine::Data>,
    raw: Option<&RawLayout>,
) -> ((usize, usize), (usize, usize)) {
    // 1-based, inclusive, and empty until something claims otherwise.
    let mut bounds: Option<(usize, usize, usize, usize)> = None;
    let mut claim = |r1: usize, c1: usize, r2: usize, c2: usize| {
        if r2 < r1 || c2 < c1 {
            return;
        }
        bounds = Some(match bounds {
            None => (r1, c1, r2, c2),
            Some(b) => (b.0.min(r1), b.1.min(c1), b.2.max(r2), b.3.max(c2)),
        });
    };

    if let (Some(start), Some(end)) = (range.start(), range.end()) {
        claim(
            start.0 as usize + 1,
            start.1 as usize + 1,
            end.0 as usize + 1,
            end.1 as usize + 1,
        );
    }

    if let Some(raw) = raw {
        if let Some(pa) = raw.print_area {
            claim(pa.0, pa.1, pa.2, pa.3);
        }
        if let Some(d) = raw.dimension {
            claim(d.0, d.1, d.2, d.3);
        }
        // A cell with a border and nothing in it is still part of the drawing.
        for &(r, c) in raw.cell_xf.keys() {
            claim(r, c, r, c);
        }
        for &(r1, c1, r2, c2) in &raw.merges {
            claim(r1, c1, r2, c2);
        }
    }

    let Some((r1, c1, r2, c2)) = bounds else { return ((1, 1), (0, 0)) };
    ((r1, c1), (r2 - r1 + 1, c2 - c1 + 1))
}

/// Does this row carry any formatting — a border, a fill, an alignment?
///
/// Asked of a row that holds no values, to tell the bottom of a drawn form
/// from the blank space Excel left under a list.
fn row_is_formatted(
    raw: Option<&RawLayout>,
    origin: (usize, usize),
    row: usize,
    cols: usize,
) -> bool {
    let Some(raw) = raw else { return false };
    (0..cols).any(|c| {
        raw.cell_xf
            .get(&(row + origin.0, c + origin.1))
            .and_then(|xf| raw.styles.xfs.get(*xf))
            .is_some_and(|style| !style.is_plain())
    })
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

/// A date cell rendered through the sheet's own format code.
///
/// Enough of Excel's date tokens for what a document actually uses: y/m/d/h/s
/// in their one-to-four letter forms, AM/PM, quoted literals (a Japanese sheet
/// writes yyyy"年"m"月"d"日") and the punctuation between them. The section
/// after ';' describes text and negatives, not the date, and is dropped.
///
/// The awkward one is `m`, which is both months and minutes. Excel decides by
/// context: directly after an hour, or directly before seconds, it is minutes.
/// Everywhere else it is the month.
fn format_excel_date(d: &calamine::ExcelDateTime, code: &str) -> String {
    use chrono::{Datelike, Timelike};

    let Some(dt) = d.as_datetime() else { return excel_date_text(d) };
    let head: Vec<char> = code.split(';').next().unwrap_or(code).chars().collect();

    let twelve_hour = contains_at(&head, 0, "AM/PM").is_some()
        || head.windows(5).any(|w| w.iter().collect::<String>() == "AM/PM");

    let mut out = String::new();
    let mut i = 0;
    let mut quoted = false;
    // Whether the field just written was an hour, which is what makes the next
    // `m` minutes rather than a month.
    let mut after_hour = false;

    while i < head.len() {
        let ch = head[i];

        if ch == '"' {
            quoted = !quoted;
            i += 1;
            continue;
        }
        if quoted {
            out.push(ch);
            i += 1;
            continue;
        }

        // The marker is a token, not five letters: 'M' inside it must not be
        // read as a month.
        if let Some(len) = contains_at(&head, i, "AM/PM").or_else(|| contains_at(&head, i, "am/pm")) {
            let upper = head[i] == 'A';
            let marker = if dt.hour() < 12 { "AM" } else { "PM" };
            out.push_str(&if upper { marker.to_string() } else { marker.to_lowercase() });
            i += len;
            continue;
        }

        match ch {
            // An escaped literal, and the "as wide as" marker before one.
            '\\' | '_' => {
                if i + 1 < head.len() {
                    if ch == '\\' {
                        out.push(head[i + 1]);
                    }
                    i += 2;
                } else {
                    i += 1;
                }
            }
            // [h] is an elapsed count and [$-409] a locale. Neither is output.
            '[' => {
                while i < head.len() && head[i] != ']' {
                    i += 1;
                }
                i += 1;
            }
            'y' | 'Y' => {
                let n = run_length(&head, i);
                // One or two letters is the short year, three or more the full.
                if n <= 2 {
                    out.push_str(&format!("{:02}", dt.year().rem_euclid(100)));
                } else {
                    out.push_str(&dt.year().to_string());
                }
                i += n;
                after_hour = false;
            }
            'd' | 'D' => {
                let n = run_length(&head, i);
                // ddd and dddd are weekday names, which need a locale this does
                // not carry. The day number is not what was asked for, but it
                // is never misleading.
                if n == 1 {
                    out.push_str(&dt.day().to_string());
                } else {
                    out.push_str(&format!("{:02}", dt.day()));
                }
                i += n;
                after_hour = false;
            }
            'h' | 'H' => {
                let n = run_length(&head, i);
                let mut hour = dt.hour();
                if twelve_hour {
                    hour = if hour % 12 == 0 { 12 } else { hour % 12 };
                }
                if n == 1 {
                    out.push_str(&hour.to_string());
                } else {
                    out.push_str(&format!("{:02}", hour));
                }
                i += n;
                after_hour = true;
            }
            's' | 'S' => {
                let n = run_length(&head, i);
                if n == 1 {
                    out.push_str(&dt.second().to_string());
                } else {
                    out.push_str(&format!("{:02}", dt.second()));
                }
                i += n;
                after_hour = false;
            }
            'm' | 'M' => {
                let n = run_length(&head, i);
                let minutes = after_hour || seconds_follow(&head, i + n);
                let value = if minutes { dt.minute() } else { dt.month() };
                if n == 1 {
                    out.push_str(&value.to_string());
                } else {
                    out.push_str(&format!("{:02}", value));
                }
                i += n;
                after_hour = false;
            }
            other => {
                out.push(other);
                // Separators do not end the hour-then-minutes pairing: "h:mm"
                // has a colon between them.
                if !matches!(other, ':' | ' ' | '.') {
                    after_hour = false;
                }
                i += 1;
            }
        }
    }

    out
}

/// How many of the same character start at `i`.
fn run_length(chars: &[char], i: usize) -> usize {
    let ch = chars[i];
    let mut n = 0;
    while i + n < chars.len() && chars[i + n] == ch {
        n += 1;
    }
    n
}

/// Does `needle` start at `i`? Returns its length so the caller can skip it.
fn contains_at(chars: &[char], i: usize, needle: &str) -> Option<usize> {
    let want: Vec<char> = needle.chars().collect();
    if i + want.len() > chars.len() {
        return None;
    }
    if chars[i..i + want.len()] == want[..] {
        Some(want.len())
    } else {
        None
    }
}

/// Is a seconds field the next thing after the separator at `i`?
fn seconds_follow(chars: &[char], i: usize) -> bool {
    let mut j = i;
    while j < chars.len() && matches!(chars[j], ':' | '.' | ' ') {
        j += 1;
    }
    j < chars.len() && matches!(chars[j], 's' | 'S')
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
    fn a_print_area_is_read_off_the_defined_name_that_holds_it() {
        let xml = r#"<?xml version="1.0"?>
<workbook xmlns:r="r">
<sheets><sheet name="One" r:id="rId1"/><sheet name="Two" r:id="rId2"/></sheets>
<definedNames>
<definedName name="_xlnm.Print_Area" localSheetId="0">One!$A$1:$J$26</definedName>
<definedName name="_xlnm.Print_Area" localSheetId="1">'Two Three'!$B$2:$D$4</definedName>
<definedName name="Something_else" localSheetId="0">One!$A$1:$B$2</definedName>
</definedNames>
</workbook>"#;

        let areas = read_print_areas(xml);
        assert_eq!(areas.get(&0), Some(&(1, 1, 26, 10)));
        // A quoted sheet name is dropped along with the rest of the prefix.
        assert_eq!(areas.get(&1), Some(&(2, 2, 4, 4)));
        // Only the print area; a workbook is full of other defined names.
        assert_eq!(areas.len(), 2);
    }

    #[test]
    fn an_area_reference_loses_its_sheet_and_gains_its_bounds() {
        assert_eq!(parse_area_ref("Sheet1!$A$1:$H$40"), Some((1, 1, 40, 8)));
        // Several ranges print as several pages; one preview is one page, so
        // they are taken together as the rectangle holding them all.
        assert_eq!(parse_area_ref("S!$A$1:$B$2,S!$D$4:$E$9"), Some((1, 1, 9, 5)));
        // A deleted range leaves #REF! behind, which is not a rectangle.
        assert_eq!(parse_area_ref("#REF!"), None);
        assert_eq!(parse_area_ref(""), None);
        // A single cell is still an area.
        assert_eq!(parse_area_ref("S!$C$3"), Some((3, 3, 3, 3)));
    }

    #[test]
    fn a_sheet_says_whether_it_wants_the_background_grid() {
        let off = read_sheet_geometry(
            r#"<worksheet><sheetViews><sheetView showGridLines="0" tabSelected="1"/></sheetViews>
<sheetData/></worksheet>"#,
        )
        .expect("a sheet that turns the grid off has said something");
        assert!(!off.gridlines);

        // Absent means on, which is Excel's default and most sheets.
        let on = read_sheet_geometry(
            r#"<worksheet><dimension ref="A1:B2"/><sheetViews><sheetView tabSelected="1"/></sheetViews>
<sheetData/></worksheet>"#,
        )
        .expect("the dimension is something");
        assert!(on.gridlines);
    }

    #[test]
    fn the_declared_dimension_is_part_of_how_far_the_sheet_goes() {
        let xml = r#"<worksheet><dimension ref="A1:S45"/><sheetData/></worksheet>"#;
        let raw = read_sheet_geometry(xml).expect("dimension");
        assert_eq!(raw.dimension, Some((1, 1, 45, 19)));
    }

    #[test]
    fn a_date_is_written_the_way_the_sheet_writes_it() {
        use calamine::{ExcelDateTime, ExcelDateTimeType};
        // 2026-02-20 09:05.
        let d = ExcelDateTime::new(46073.378472222, ExcelDateTimeType::DateTime, false);

        // The format this very workbook uses. Rendering it as yyyy-mm-dd was
        // both not what the author chose and a character wider than the column
        // they sized for it.
        assert_eq!(format_excel_date(&d, "yyyy/m/d;@"), "2026/2/20");
        assert_eq!(format_excel_date(&d, "yyyy/mm/dd"), "2026/02/20");
        assert_eq!(format_excel_date(&d, "yy/m/d"), "26/2/20");

        // Quoted literals: a Japanese sheet writes the units into the format.
        assert_eq!(format_excel_date(&d, r#"yyyy"年"m"月"d"日""#), "2026年2月20日");

        // The same letter is months and minutes. After an hour, or before
        // seconds, it is minutes; everywhere else it is the month.
        assert_eq!(format_excel_date(&d, "h:mm"), "9:05");
        assert_eq!(format_excel_date(&d, "yyyy/m/d h:mm"), "2026/2/20 9:05");
        assert_eq!(format_excel_date(&d, "mm:ss"), "05:00");

        // A locale or an elapsed-time marker is not output.
        assert_eq!(format_excel_date(&d, "[$-411]yyyy/m/d"), "2026/2/20");
    }

    #[test]
    fn only_a_date_format_counts_as_a_date_format() {
        let custom: HashMap<usize, String> = [
            (176usize, "yyyy/m/d;@".to_string()),
            (177, "#,##0".to_string()),
            (178, r#"0"日""#.to_string()),
        ]
        .into_iter()
        .collect();

        assert_eq!(date_format_code(176, &custom).as_deref(), Some("yyyy/m/d;@"));
        // Numbers are left alone. Implementing Excel's number formats by
        // halves would be wrong more often than right, and a number reads
        // fine as a number.
        assert_eq!(date_format_code(177, &custom), None);
        // The 'd' here is inside quotes: it is the character, not the day.
        assert_eq!(date_format_code(178, &custom), None);
        // Built-in 14 is the short date, whatever the workbook says.
        assert_eq!(date_format_code(14, &custom).as_deref(), Some("yyyy/m/d"));
        assert_eq!(date_format_code(0, &custom), None);
    }

    #[test]
    fn the_style_table_gives_up_borders_alignment_and_wrapping() {
        let xml = r#"<?xml version="1.0"?>
<styleSheet>
<numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy/m/d;@"/></numFmts>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"/><right style="hair"/><top style="double"/><bottom style="medium"/></border>
<border><left style="dashDot"/><right/><top/><bottom style="dotted"/></border>
</borders>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="6" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="176" fontId="6" borderId="2" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="6" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
</cellXfs>
</styleSheet>"#;

        let book = read_style_book(xml);
        assert_eq!(book.xfs.len(), 4);

        // Index 0 is the plain one, which is what a cell saying nothing means.
        assert!(book.xfs[0].is_plain());

        let boxed = &book.xfs[1];
        // hair and thin are both a hairline; medium and thick are both heavy.
        assert_eq!((boxed.left.as_str(), boxed.right.as_str()), ("thin", "thin"));
        assert_eq!((boxed.top.as_str(), boxed.bottom.as_str()), ("double", "thick"));
        assert!(boxed.wrap);
        assert_eq!((boxed.halign.as_str(), boxed.valign.as_str()), ("center", "center"));

        // Every other broken line reads as "dashed" at preview scale.
        assert_eq!(book.xfs[2].left, "dashed");
        assert_eq!(book.xfs[2].bottom, "dotted");
        // The date format is attached to the entry that asked for it.
        assert_eq!(book.date_formats.get(&2).map(String::as_str), Some("yyyy/m/d;@"));
        assert_eq!(book.date_formats.get(&1), None);

        // A self-closing <xf/> has no alignment, and must not inherit the one
        // belonging to the entry before it.
        assert_eq!(book.xfs[3].halign, "right");
        assert_eq!(book.xfs[3].valign, "top");
        assert!(!book.xfs[3].wrap);
        assert!(book.xfs[2].halign.is_empty(), "a self-closing xf has no alignment");
    }

    #[test]
    fn the_style_grid_carries_only_the_formats_the_sheet_uses() {
        let mut styles = StyleBook::default();
        styles.xfs = vec![
            CellStyle::default(),
            CellStyle { bottom: "thin".into(), ..Default::default() },
            CellStyle { top: "thick".into(), ..Default::default() },
        ];
        let raw = RawLayout {
            // A1 and B2 share a format; C1 uses another; the rest are plain.
            cell_xf: [((1usize, 1usize), 1usize), ((2, 2), 1), ((1, 3), 2)]
                .into_iter()
                .collect(),
            styles,
            ..Default::default()
        };

        let l = clip_layout(&raw, 2, 3, (1, 1));
        // A workbook's cellXfs runs to hundreds of entries; a sheet touches a
        // handful, and the grid should carry a handful.
        assert_eq!(l.styles.len(), 3, "plain, plus the two in use");
        assert_eq!(l.style_ids[0][0], l.style_ids[1][1], "one format, one id");
        assert_ne!(l.style_ids[0][0], l.style_ids[0][2]);
        assert_eq!(l.style_ids[0][1], 0, "a plain cell says 0");

        // A sheet where nothing is formatted sends no grid at all, rather than
        // a second copy of the sheet made of zeroes.
        let plain = RawLayout { default_col_px: Some(23.0), ..Default::default() };
        let l = clip_layout(&plain, 2, 2, (1, 1));
        assert!(l.styles.is_empty());
        assert!(l.style_ids.is_empty());
    }

    #[test]
    fn the_geometry_is_placed_against_the_used_range_it_came_from() {
        // calamine hands back the USED range: a sheet whose data starts at B2
        // has its own (2, 2) sitting at (0, 0) here, and the XML is in sheet
        // coordinates. Getting this wrong shifts every width by a column.
        let raw = RawLayout {
            cols: vec![(2, 2, 100.0), (3, 3, 50.0)],
            rows: [(2usize, 40.0)].into_iter().collect(),
            default_row_px: Some(20.0),
            merges: vec![(2, 2, 3, 3)],
            ..Default::default()
        };

        let l = clip_layout(&raw, 2, 2, (2, 2));
        assert_eq!(l.col_widths, vec![100.0, 50.0]);
        assert_eq!(l.row_heights, vec![40.0, 20.0]);
        assert_eq!((l.merges[0].row, l.merges[0].col), (0, 0));
    }

    #[test]
    fn a_cell_reference_reads_as_a_row_and_a_column() {
        assert_eq!(parse_cell_ref("A1"), Some((1, 1)));
        assert_eq!(parse_cell_ref("Z9"), Some((9, 26)));
        // Base-26 with no zero: AA is 27, not 0 followed by 1.
        assert_eq!(parse_cell_ref("AA1"), Some((1, 27)));
        assert_eq!(parse_cell_ref("AB12"), Some((12, 28)));
        // Absolute references are the same cell.
        assert_eq!(parse_cell_ref("$B$3"), Some((3, 2)));
        assert_eq!(parse_cell_ref("1A"), None);
        assert_eq!(parse_cell_ref("A"), None);
        assert_eq!(parse_cell_ref(""), None);
    }

    #[test]
    fn a_merge_range_comes_back_smallest_corner_first() {
        assert_eq!(parse_ref("B3:D7"), Some((3, 2, 7, 4)));
        // Written the other way round it is the same rectangle.
        assert_eq!(parse_ref("D7:B3"), Some((3, 2, 7, 4)));
        assert_eq!(parse_ref("A1"), None);
    }

    #[test]
    fn a_column_width_converts_to_the_pixels_excel_draws() {
        // 2.5 characters is the grid-paper column these sheets are built on.
        assert_eq!(col_width_px(2.5), 23.0);
        assert_eq!(col_width_px(8.0), 61.0);
        // Zero is a hidden column, not a column five pixels wide.
        assert_eq!(col_width_px(0.0), 0.0);
    }

    #[test]
    fn the_geometry_is_cut_down_to_what_is_being_drawn() {
        let raw = RawLayout {
            default_col_px: Some(23.0),
            // A sheet that sets one width for everything writes max="16384".
            // Looping to that would allocate sixteen thousand columns for a
            // sheet showing four.
            cols: vec![(1, 16384, 23.0), (2, 2, 100.0), (3, 3, 0.0)],
            default_row_px: Some(20.0),
            rows: [(2usize, 42.0)].into_iter().collect(),
            merges: vec![
                (1, 1, 2, 2),      // inside
                (1, 1, 99, 99),    // runs off the end — kept, clipped
                (9, 1, 9, 2),      // starts past the last row — dropped
                (4, 4, 4, 4),      // one cell: a range, but nothing to draw
            ],
            ..Default::default()
        };

        let l = clip_layout(&raw, 3, 4, (1, 1));
        assert_eq!(l.col_widths, vec![23.0, 100.0, 0.0, 23.0]);
        // Only the row that set its own height differs from the default.
        assert_eq!(l.row_heights, vec![20.0, 42.0, 20.0]);

        assert_eq!(l.merges.len(), 2);
        // Zero-based, and counted in cells rather than as an end coordinate.
        assert_eq!((l.merges[0].row, l.merges[0].col), (0, 0));
        assert_eq!((l.merges[0].rows, l.merges[0].cols), (2, 2));
        // Clipped to the kept range rather than dropped: it still covers what
        // IS on screen.
        assert_eq!((l.merges[1].rows, l.merges[1].cols), (3, 4));
    }

    #[test]
    fn a_sheet_that_declares_no_geometry_declares_none() {
        // Better than a layout of zeroes, which the view would draw.
        assert!(read_sheet_geometry("<worksheet><sheetData/></worksheet>").is_none());

        let all_default = RawLayout { default_col_px: Some(0.0), ..Default::default() };
        let l = clip_layout(&all_default, 2, 2, (1, 1));
        assert!(l.col_widths.is_empty(), "nothing useful to say about widths");
        assert!(l.row_heights.is_empty());
    }

    #[test]
    fn a_worksheet_part_gives_up_its_widths_heights_and_merges() {
        let xml = r#"<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetFormatPr defaultColWidth="2.5" defaultRowHeight="15"/>
<cols>
<col min="1" max="1" width="4.125" customWidth="1"/>
<col min="2" max="3" width="17.375" customWidth="1"/>
<col min="4" max="4" width="9" hidden="1" customWidth="1"/>
</cols>
<sheetData>
<row r="1" ht="28.5" customHeight="1"/>
<row r="2"/>
<row r="3" hidden="1"/>
</sheetData>
<mergeCells count="2">
<mergeCell ref="A1:C1"/><mergeCell ref="B2:B3"/>
</mergeCells>
</worksheet>"#;

        let raw = read_sheet_geometry(xml).expect("geometry");
        assert_eq!(raw.default_col_px, Some(23.0));
        assert_eq!(raw.cols.len(), 3);
        assert_eq!(raw.cols[1], (2, 3, col_width_px(17.375)));
        // A hidden column is zero wide whatever width it records.
        assert_eq!(raw.cols[2], (4, 4, 0.0));

        // Points, not pixels: 28.5pt is 38px at 96dpi.
        assert_eq!(raw.rows.get(&1), Some(&38.0));
        // A row that says nothing takes the default, so it is not stored.
        assert_eq!(raw.rows.get(&2), None);
        assert_eq!(raw.rows.get(&3), Some(&0.0));

        assert_eq!(raw.merges, vec![(1, 1, 1, 3), (2, 2, 3, 2)]);
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
