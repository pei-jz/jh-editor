//! The sheet geometry and cell formats of a .xls (Excel 97-2003).
//!
//! calamine reads the values out of these and nothing else, the same as with
//! an .xlsx (see read_sheet_layouts), so this reads the rest: the BIFF8 records
//! in the file's "Workbook" stream. It produces the RawLayout the .xlsx reader
//! does, and from there the two are one code path.
//!
//! Only BIFF8, which is what Excel has written since 97. An older file gets no
//! layout and keeps its measured-from-content columns, as does anything this
//! fails to make sense of. Pictures and shapes are not read.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use super::{date_format_code, CellStyle, RawLayout, StyleBook, MAX_MERGES, PT_TO_PX};

const BOF: u16 = 0x0809;
const EOF: u16 = 0x000A;
const BIFF8: u16 = 0x0600;
const SUBSTREAM_WORKSHEET: u16 = 0x0010;

// Workbook globals.
const FONT: u16 = 0x0031;
const FORMAT: u16 = 0x041E;
const XF: u16 = 0x00E0;
const PALETTE: u16 = 0x0092;
const BOUNDSHEET: u16 = 0x0085;
const DATEMODE: u16 = 0x0022;

// A worksheet.
const DEFCOLWIDTH: u16 = 0x0055;
const STANDARDWIDTH: u16 = 0x0099;
const COLINFO: u16 = 0x007D;
const DEFAULTROWHEIGHT: u16 = 0x0225;
const ROW: u16 = 0x0208;
const DIMENSIONS: u16 = 0x0200;
const WINDOW2: u16 = 0x023E;
const MERGEDCELLS: u16 = 0x00E5;
const MULBLANK: u16 = 0x00BE;
const MULRK: u16 = 0x00BD;
/// Cells that start with row, column, XF.
const SINGLE_CELLS: [u16; 7] = [0x00FD, 0x0203, 0x027E, 0x0201, 0x0205, 0x0006, 0x0204];

/// The 56 colours a workbook has until a PALETTE record says otherwise, for
/// indices 8 to 63. These are what a file from Excel 2003 means by "yellow".
const DEFAULT_PALETTE: [u32; 56] = [
    0x000000, 0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00, 0xFF00FF, 0x00FFFF,
    0x800000, 0x008000, 0x000080, 0x808000, 0x800080, 0x008080, 0xC0C0C0, 0x808080,
    0x9999FF, 0x993366, 0xFFFFCC, 0xCCFFFF, 0x660066, 0xFF8080, 0x0066CC, 0xCCCCFF,
    0x000080, 0xFF00FF, 0xFFFF00, 0x00FFFF, 0x800080, 0x800000, 0x008080, 0x0000FF,
    0x00CCFF, 0xCCFFFF, 0xCCFFCC, 0xFFFF99, 0x99CCFF, 0xFF99CC, 0xCC99FF, 0xFFCC99,
    0x3366FF, 0x33CCCC, 0x99CC00, 0xFFCC00, 0xFF9900, 0xFF6600, 0x666699, 0x969696,
    0x003366, 0x339966, 0x003300, 0x333300, 0x993300, 0x993366, 0x333399, 0x333333,
];

/// One layout per BOUNDSHEET, in order — the order calamine lists the names in.
/// None for an entry that is not a worksheet (a chart sheet).
pub(super) fn read_layouts(bytes: &[u8]) -> Option<Vec<Option<RawLayout>>> {
    let mut file = cfb::CompoundFile::open(Cursor::new(bytes)).ok()?;
    let name = if file.exists("/Workbook") { "/Workbook" } else { "/Book" };
    let mut stream = file.open_stream(name).ok()?;
    let mut workbook = Vec::new();
    stream.read_to_end(&mut workbook).ok()?;
    read_workbook_stream(&workbook)
}

fn read_workbook_stream(stream: &[u8]) -> Option<Vec<Option<RawLayout>>> {
    let mut records = Records::at(stream, 0);
    let (id, bof) = records.next()?;
    if id != BOF || u16_at(bof, 0)? != BIFF8 {
        return None;
    }

    // The XFs are kept raw and resolved at the end: nothing obliges PALETTE to
    // come before the formats that index into it.
    let mut first_font: Option<(u16, u8)> = None;
    let mut codes: HashMap<usize, String> = HashMap::new();
    let mut xfs: Vec<&[u8]> = Vec::new();
    let mut palette = DEFAULT_PALETTE;
    let mut sheet_offsets: Vec<usize> = Vec::new();
    let mut date_1904 = false;

    for (id, data) in records {
        match id {
            EOF => break,
            FONT if first_font.is_none() => {
                first_font = Some((u16_at(data, 0)?, *data.get(12)?));
            }
            FORMAT => {
                if let (Some(id), Some(code)) = (u16_at(data, 0), unicode_string(data.get(2..)?)) {
                    codes.insert(id as usize, code);
                }
            }
            XF => xfs.push(data),
            PALETTE => {
                let entries = data.get(2..)?.chunks_exact(4);
                for (slot, c) in palette.iter_mut().zip(entries) {
                    *slot = (c[0] as u32) << 16 | (c[1] as u32) << 8 | c[2] as u32;
                }
            }
            BOUNDSHEET => sheet_offsets.push(u32_at(data, 0)? as usize),
            DATEMODE => date_1904 = u16_at(data, 0) == Some(1),
            _ => {}
        }
    }

    let mut book = StyleBook { date_1904, ..Default::default() };
    for (index, data) in xfs.iter().enumerate() {
        book.xfs.push(cell_style(data, &palette).unwrap_or_default());
        let fmt = u16_at(data, 2).unwrap_or(0) as usize;
        if let Some(code) = date_format_code(fmt, &codes) {
            book.date_formats.insert(index, code);
        }
    }

    let (height, charset) = first_font.unwrap_or((200, 0));
    let digit = digit_width_px(height, charset);
    Some(
        sheet_offsets
            .into_iter()
            .map(|offset| read_sheet(stream, offset, digit, &book))
            .collect(),
    )
}

/// How wide a '0' is in the workbook's default font, which is what a column
/// width counts in.
///
/// Only the font's size and character set are consulted, not its metrics: the
/// figures come out right for the defaults that matter. MS Pゴシック 11 is 8px,
/// which is why a Japanese workbook's standard column is 72px, and Arial 10 is
/// 7px, which is why an English one's is 64px.
fn digit_width_px(height_twips: u16, charset: u8) -> f64 {
    let em = height_twips as f64 / 20.0 * PT_TO_PX;
    // ShiftJIS, Hangul, GB2312, Big5: half-width digits, rounded up by hinting.
    let px = if matches!(charset, 128 | 129 | 134 | 136) {
        (em * 0.5).ceil()
    } else {
        (em * 0.54).round()
    };
    px.max(1.0)
}

fn read_sheet(stream: &[u8], offset: usize, digit: f64, book: &StyleBook) -> Option<RawLayout> {
    let mut records = Records::at(stream, offset);
    let (id, bof) = records.next()?;
    if id != BOF || u16_at(bof, 2)? != SUBSTREAM_WORKSHEET {
        return None;
    }

    let mut out = RawLayout { styles: book.clone(), ..Default::default() };
    let mut standard_width = None;
    let mut defcol_width = None;

    let keep = |out: &mut RawLayout, row: u16, col: u16, xf: u16| {
        let xf = xf as usize;
        let plain = book.xfs.get(xf).map_or(true, CellStyle::is_plain);
        if !plain || book.date_formats.contains_key(&xf) {
            out.cell_xf.insert((row as usize + 1, col as usize + 1), xf);
        }
    };

    // A chart embedded in the sheet is a substream of its own inside this one.
    // Its records are not the sheet's, and its EOF is not the sheet's end.
    let mut depth = 1;
    for (id, data) in records {
        if id == BOF {
            depth += 1;
            continue;
        }
        if id == EOF {
            depth -= 1;
            if depth == 0 {
                break;
            }
            continue;
        }
        if depth > 1 {
            continue;
        }

        match id {
            STANDARDWIDTH => standard_width = u16_at(data, 0),
            DEFCOLWIDTH => defcol_width = u16_at(data, 0),
            COLINFO => {
                let (Some(first), Some(last), Some(width), Some(flags)) =
                    (u16_at(data, 0), u16_at(data, 2), u16_at(data, 4), u16_at(data, 8))
                else {
                    continue;
                };
                // Unlike <col width> this already includes the padding. A
                // hidden column is zero wide, whatever width it records.
                let px = if flags & 1 != 0 { 0.0 } else { (width as f64 / 256.0 * digit).round() };
                out.cols.push((first as usize + 1, last as usize + 1, px));
            }
            DEFAULTROWHEIGHT => {
                if let Some(h) = u16_at(data, 2) {
                    out.default_row_px = Some(h as f64 / 20.0 * PT_TO_PX);
                }
            }
            ROW => {
                let (Some(row), Some(height), Some(flags)) =
                    (u16_at(data, 0), u16_at(data, 6), u16_at(data, 12))
                else {
                    continue;
                };
                let row = row as usize + 1;
                if flags & 0x20 != 0 {
                    out.rows.insert(row, 0.0);
                } else if height & 0x8000 == 0 {
                    out.rows.insert(row, height as f64 / 20.0 * PT_TO_PX);
                }
            }
            DIMENSIONS => {
                if let (Some(r1), Some(r2), Some(c1), Some(c2)) =
                    (u32_at(data, 0), u32_at(data, 4), u16_at(data, 8), u16_at(data, 10))
                {
                    // The far edge is one past the end, and an empty sheet
                    // writes zeroes.
                    if r2 > r1 && c2 > c1 {
                        out.dimension =
                            Some((r1 as usize + 1, c1 as usize + 1, r2 as usize, c2 as usize));
                    }
                }
            }
            WINDOW2 => {
                if let Some(flags) = u16_at(data, 0) {
                    out.gridlines = flags & 0x0002 != 0;
                }
            }
            MERGEDCELLS => {
                for m in data.get(2..).unwrap_or(&[]).chunks_exact(8) {
                    if out.merges.len() >= MAX_MERGES {
                        break;
                    }
                    let (Some(r1), Some(r2), Some(c1), Some(c2)) =
                        (u16_at(m, 0), u16_at(m, 2), u16_at(m, 4), u16_at(m, 6))
                    else {
                        continue;
                    };
                    out.merges.push((
                        r1 as usize + 1,
                        c1 as usize + 1,
                        r2 as usize + 1,
                        c2 as usize + 1,
                    ));
                }
            }
            // A bordered, empty cell is a BLANK; a run of them is a MULBLANK.
            // Those are the frame of a form, and most of what it looks like.
            MULBLANK | MULRK => {
                let (Some(row), Some(first)) = (u16_at(data, 0), u16_at(data, 2)) else {
                    continue;
                };
                // Ends in the last column's number, which is not a cell.
                let Some(cells) = data.get(4..data.len().saturating_sub(2)) else { continue };
                let size = if id == MULBLANK { 2 } else { 6 };
                for (i, cell) in cells.chunks_exact(size).enumerate() {
                    if let Some(xf) = u16_at(cell, 0) {
                        keep(&mut out, row, first.saturating_add(i as u16), xf);
                    }
                }
            }
            _ if SINGLE_CELLS.contains(&id) => {
                if let (Some(row), Some(col), Some(xf)) =
                    (u16_at(data, 0), u16_at(data, 2), u16_at(data, 4))
                {
                    keep(&mut out, row, col, xf);
                }
            }
            _ => {}
        }
    }

    // STANDARDWIDTH includes the padding, as COLINFO does. DEFCOLWIDTH counts
    // characters only, and Excel rounds what it comes to up to a multiple of 8:
    // eight characters of 8px are 72px wide, not 69. Either can be missing.
    out.default_col_px = Some(match standard_width {
        Some(width) => (width as f64 / 256.0 * digit).round(),
        None => {
            let px = defcol_width.unwrap_or(8) as f64 * digit + super::COL_PADDING_PX;
            (px / 8.0).ceil() * 8.0
        }
    });
    Some(out)
}

/// A BIFF8 XF record, read as CellStyle. None if it is too short to be one.
fn cell_style(xf: &[u8], palette: &[u32; 56]) -> Option<CellStyle> {
    let align = *xf.get(6)?;
    let lines = u16_at(xf, 10)?;
    let fill_word = u32_at(xf, 14)?;
    let fore = u16_at(xf, 18)? & 0x7F;

    let edge = |shift: u16| border_kind((lines >> shift) as u8 & 0x0F).to_string();
    Some(CellStyle {
        left: edge(0),
        right: edge(4),
        top: edge(8),
        bottom: edge(12),
        wrap: align & 0x08 != 0,
        halign: match align & 0x07 {
            1 | 5 | 7 => "left",
            2 | 6 => "center",
            3 => "right",
            _ => "",
        }
        .to_string(),
        // Bottom (2) is the default every cell writes, so it means what saying
        // nothing means in an .xlsx.
        valign: match (align >> 4) & 0x07 {
            0 => "top",
            1 | 3 | 4 => "center",
            _ => "",
        }
        .to_string(),
        // A pattern's foreground is the colour it is painted in, as in
        // read_style_book. Pattern 0 is no fill, whatever colour it records.
        fill: if (fill_word >> 26) & 0x3F == 0 { String::new() } else { color(fore, palette) },
    })
}

/// BIFF's border styles, reduced the way border_kind reduces OOXML's.
fn border_kind(style: u8) -> &'static str {
    match style {
        0 => "",
        1 | 7 => "thin",   // thin, hair
        2 | 5 => "thick",  // medium, thick
        6 => "double",
        4 => "dotted",
        _ => "dashed",
    }
}

/// An ICV palette index as "#rrggbb". Past the palette are the system colours
/// (64 is "the window background"): no colour of the file's own.
fn color(index: u16, palette: &[u32; 56]) -> String {
    let rgb = match index {
        0..=7 => palette[index as usize],
        8..=63 => palette[index as usize - 8],
        _ => return String::new(),
    };
    format!("#{:06x}", rgb)
}

/// An XLUnicodeString: length, flags, then the characters, one byte each when
/// the high bytes were all zero.
fn unicode_string(data: &[u8]) -> Option<String> {
    let len = u16_at(data, 0)? as usize;
    let flags = *data.get(2)?;
    let mut start = 3;
    if flags & 0x08 != 0 {
        start += 2; // rich text run count
    }
    if flags & 0x04 != 0 {
        start += 4; // phonetic block size
    }
    if flags & 0x01 != 0 {
        let raw = data.get(start..start + len * 2)?;
        let units: Vec<u16> = raw.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        Some(String::from_utf16_lossy(&units))
    } else {
        Some(data.get(start..start + len)?.iter().map(|&b| b as char).collect())
    }
}

fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    let b = data.get(at..at + 2)?;
    Some(u16::from_le_bytes([b[0], b[1]]))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    let b = data.get(at..at + 4)?;
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// The records from an offset on: a 2-byte id, a 2-byte length, the data. Ends
/// quietly at the end of the stream or at a record that overruns it.
struct Records<'a> {
    stream: &'a [u8],
    pos: usize,
}

impl<'a> Records<'a> {
    fn at(stream: &'a [u8], pos: usize) -> Self {
        Self { stream, pos }
    }
}

impl<'a> Iterator for Records<'a> {
    type Item = (u16, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        let id = u16_at(self.stream, self.pos)?;
        let len = u16_at(self.stream, self.pos + 2)? as usize;
        let start = self.pos + 4;
        let data = self.stream.get(start..start + len)?;
        self.pos = start + len;
        Some((id, data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: u16, data: &[u8]) -> Vec<u8> {
        let mut out = id.to_le_bytes().to_vec();
        out.extend((data.len() as u16).to_le_bytes());
        out.extend(data);
        out
    }

    fn bof(kind: u16) -> Vec<u8> {
        let mut d = BIFF8.to_le_bytes().to_vec();
        d.extend(kind.to_le_bytes());
        d.extend([0u8; 12]);
        rec(BOF, &d)
    }

    fn u16s(values: &[u16]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    fn font(height: u16, charset: u8) -> Vec<u8> {
        let mut d = height.to_le_bytes().to_vec();
        d.extend([0u8; 10]);
        d.push(charset);
        d.extend([0u8; 3]);
        rec(FONT, &d)
    }

    /// An XF: number format, alignment byte, border nibbles, pattern, colour.
    fn xf(fmt: u16, align: u8, borders: u16, pattern: u32, fore: u16) -> Vec<u8> {
        let mut d = vec![0u8; 20];
        d[2..4].copy_from_slice(&fmt.to_le_bytes());
        d[6] = align;
        d[10..12].copy_from_slice(&borders.to_le_bytes());
        d[14..18].copy_from_slice(&(pattern << 26).to_le_bytes());
        d[18..20].copy_from_slice(&fore.to_le_bytes());
        rec(XF, &d)
    }

    const DEFAULT_ALIGN: u8 = 0x20; // what a plain cell writes: bottom-aligned

    /// A workbook of one sheet whose records are `sheet`, with XFs:
    /// 0 plain, 1 boxed and centred, 2 yellow fill, 3 a date.
    fn workbook(sheet: Vec<u8>, extra_globals: Vec<u8>) -> Vec<u8> {
        let mut head = bof(0x0005);
        head.extend(font(220, 128));
        let mut code = 176u16.to_le_bytes().to_vec();
        code.extend(8u16.to_le_bytes());
        code.push(0);
        code.extend(b"yyyy/m/d");
        head.extend(rec(FORMAT, &code));
        head.extend(xf(0, DEFAULT_ALIGN, 0, 0, 64));
        head.extend(xf(0, 0x2A, 0x1111, 0, 64)); // centre + wrap, thin box
        head.extend(xf(0, DEFAULT_ALIGN, 0, 1, 13)); // palette 13 is yellow
        head.extend(xf(176, DEFAULT_ALIGN, 0, 0, 64));
        head.extend(extra_globals);

        // BOUNDSHEET's offset, known only once the globals' length is.
        let bound_len = 4 + 8;
        let eof_len = 4;
        let offset = (head.len() + bound_len + eof_len) as u32;
        let mut bound = offset.to_le_bytes().to_vec();
        bound.extend([0, 0, 1, 0]);
        head.extend(rec(BOUNDSHEET, &bound));
        head.extend(rec(EOF, &[]));

        head.extend(bof(SUBSTREAM_WORKSHEET));
        head.extend(sheet);
        head.extend(rec(EOF, &[]));
        head
    }

    fn only_sheet(sheet: Vec<u8>) -> RawLayout {
        let mut sheets = read_workbook_stream(&workbook(sheet, Vec::new())).unwrap();
        sheets.remove(0).unwrap()
    }

    /// The container and calamine included, which the tests below leave out:
    /// a form with a frame of empty cells, a width, and a formula's date.
    #[test]
    fn a_whole_file_reads_through_to_the_preview() {
        // FORMULA: row, col, xf, the cached number, flags, then the tokens.
        let mut formula = u16s(&[1, 0, 3]);
        formula.extend(46056.0f64.to_le_bytes());
        formula.extend([0u8; 6]);
        formula.extend(u16s(&[3]));
        formula.extend([0x1E, 1, 0]); // ptgInt 1
        let stream = workbook(
            [rec(COLINFO, &u16s(&[0, 0, 2304, 0, 0, 0])),
             rec(0x0201, &u16s(&[0, 0, 1])),
             rec(0x0006, &formula),
             rec(0x0201, &u16s(&[3, 0, 1]))].concat(),
            Vec::new(),
        );

        let mut file = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
        {
            use std::io::Write;
            let mut s = file.create_stream("/Workbook").unwrap();
            s.write_all(&stream).unwrap();
            // Past the mini-stream cut-off, as anything from Excel is.
            s.write_all(&rec(0x0FFF, &[0u8; 8192])).unwrap();
            drop(s);
            // And beside something small, as Excel's summary streams are:
            // calamine's own reader refuses an empty mini-stream.
            file.create_stream("/Summary").unwrap().write_all(b"x").unwrap();
            file.flush().unwrap();
        }
        let bytes = file.into_inner().into_inner();

        let preview = super::super::read_workbook(bytes, "xls").unwrap();
        let sheet = &preview.sheets[0];
        assert_eq!(sheet.rows[1][0], "2026/2/3", "a formula's date, not 46056");
        // Row 4 has nothing in it but a border, and is still part of the frame.
        assert_eq!(sheet.rows.len(), 4);
        let layout = sheet.layout.as_ref().unwrap();
        assert_eq!(layout.col_widths[0], 72.0);
        let boxed = layout.style_ids[3][0];
        assert_eq!(layout.styles[boxed].bottom, "thin");
    }

    #[test]
    fn columns_are_counted_in_the_default_fonts_digit() {
        // MS Pゴシック 11: the width Excel draws a Japanese workbook's standard
        // column at. 2304/256 = 9 characters, padding included, at 8px each.
        let s = only_sheet(
            [rec(STANDARDWIDTH, &u16s(&[2304])), rec(COLINFO, &u16s(&[1, 2, 1280, 0, 0, 0])),
             rec(COLINFO, &u16s(&[4, 4, 1280, 0, 1, 0]))].concat(),
        );
        assert_eq!(s.default_col_px, Some(72.0));
        assert_eq!(s.cols[0], (2, 3, 40.0), "0-based 1..2 at 5 characters");
        assert_eq!(s.cols[1], (5, 5, 0.0), "a hidden column is zero wide");
    }

    #[test]
    fn a_sheet_with_only_a_character_count_still_has_a_default_column() {
        let s = only_sheet(rec(DEFCOLWIDTH, &u16s(&[8])));
        assert_eq!(s.default_col_px, Some(72.0), "as Excel draws it, not 69");
    }

    #[test]
    fn the_digit_follows_the_font() {
        assert_eq!(digit_width_px(220, 128), 8.0); // MS Pゴシック 11
        assert_eq!(digit_width_px(200, 0), 7.0); // Arial 10
    }

    #[test]
    fn rows_keep_their_own_height_and_hidden_ones_collapse() {
        let s = only_sheet(
            [rec(DEFAULTROWHEIGHT, &u16s(&[0, 270])),
             rec(ROW, &u16s(&[0, 0, 3, 600, 0, 0, 0x40, 0])),
             rec(ROW, &u16s(&[1, 0, 3, 0x8000 | 270, 0, 0, 0, 0])),
             rec(ROW, &u16s(&[2, 0, 3, 600, 0, 0, 0x20, 0]))].concat(),
        );
        assert_eq!(s.default_row_px, Some(18.0));
        assert_eq!(s.rows[&1], 40.0);
        assert!(!s.rows.contains_key(&2), "bit 15 is 'the default height'");
        assert_eq!(s.rows[&3], 0.0);
    }

    #[test]
    fn formats_are_resolved_through_the_palette() {
        let s = only_sheet(Vec::new());
        assert!(s.styles.xfs[0].is_plain(), "a default cell draws nothing");
        let boxed = &s.styles.xfs[1];
        assert_eq!(
            (boxed.left.as_str(), boxed.right.as_str(), boxed.top.as_str(), boxed.bottom.as_str()),
            ("thin", "thin", "thin", "thin"),
        );
        assert_eq!(boxed.halign, "center");
        assert!(boxed.wrap);
        assert_eq!(s.styles.xfs[2].fill, "#ffff00");
        assert_eq!(s.styles.date_formats[&3], "yyyy/m/d");
    }

    #[test]
    fn a_japanese_built_in_format_with_no_code_in_the_file_is_still_a_date() {
        // yyyy"年"m"月"d"日" is saved by Excel as the bare number 31.
        let code = date_format_code(31, &HashMap::new()).unwrap();
        let date = calamine::ExcelDateTime::new(
            37986.0,
            calamine::ExcelDateTimeType::DateTime,
            false,
        );
        assert_eq!(super::super::format_excel_date(&date, &code), "2003年12月31日");
    }

    #[test]
    fn a_palette_record_overrides_the_default_colours_even_after_the_formats() {
        // Palette 13 is the sixth entry of the record.
        let mut colours = u16s(&[56]);
        for i in 0..56u8 {
            colours.extend(if i == 5 { [0x12, 0x34, 0x56, 0] } else { [0, 0, 0, 0] });
        }
        let stream = workbook(Vec::new(), rec(PALETTE, &colours));
        let s = read_workbook_stream(&stream).unwrap().remove(0).unwrap();
        assert_eq!(s.styles.xfs[2].fill, "#123456");
    }

    #[test]
    fn every_kind_of_cell_carries_its_format_and_plain_ones_are_left_out() {
        let s = only_sheet(
            [rec(0x0201, &u16s(&[0, 0, 1])),      // BLANK, boxed
             rec(0x0201, &u16s(&[0, 1, 0])),      // BLANK, plain
             rec(0x00FD, &[u16s(&[1, 0, 2]), vec![0; 4]].concat()), // LABELSST
             rec(MULBLANK, &u16s(&[2, 3, 1, 0, 2, 5])),             // columns 3-5
             rec(MULRK, &[u16s(&[3, 1, 3]), vec![0; 4], u16s(&[1]), vec![0; 4], u16s(&[2])].concat())]
            .concat(),
        );
        assert_eq!(s.cell_xf.get(&(1, 1)), Some(&1));
        assert_eq!(s.cell_xf.get(&(1, 2)), None);
        assert_eq!(s.cell_xf.get(&(2, 1)), Some(&2));
        assert_eq!(s.cell_xf.get(&(3, 4)), Some(&1));
        assert_eq!(s.cell_xf.get(&(3, 5)), None);
        assert_eq!(s.cell_xf.get(&(3, 6)), Some(&2));
        assert_eq!(s.cell_xf.get(&(4, 2)), Some(&3), "a date format counts");
        assert_eq!(s.cell_xf.get(&(4, 3)), Some(&1));
    }

    #[test]
    fn merges_dimension_and_gridlines() {
        let mut dims = 2u32.to_le_bytes().to_vec();
        dims.extend(9u32.to_le_bytes());
        dims.extend(u16s(&[1, 5, 0]));
        let s = only_sheet(
            [rec(DIMENSIONS, &dims), rec(WINDOW2, &u16s(&[0x06B4, 0, 0, 0, 0])),
             rec(MERGEDCELLS, &u16s(&[1, 2, 4, 1, 3]))].concat(),
        );
        assert_eq!(s.dimension, Some((3, 2, 9, 5)));
        assert!(!s.gridlines, "bit 1 of WINDOW2 is clear");
        assert_eq!(s.merges, vec![(3, 2, 5, 4)]);
    }

    #[test]
    fn an_embedded_chart_is_not_the_sheets_records() {
        let s = only_sheet(
            [rec(MERGEDCELLS, &u16s(&[1, 0, 0, 0, 1])),
             bof(0x0020),
             rec(MERGEDCELLS, &u16s(&[1, 7, 7, 7, 8])),
             rec(EOF, &[]),
             rec(0x0201, &u16s(&[5, 5, 1]))].concat(),
        );
        assert_eq!(s.merges.len(), 1, "the chart's records are its own");
        assert_eq!(s.cell_xf.get(&(6, 6)), Some(&1), "the sheet goes on after its EOF");
    }

    #[test]
    fn a_format_older_than_biff8_or_a_torn_stream_gives_no_layout() {
        let old = rec(BOF, &[0x00, 0x05, 0x05, 0x00]);
        assert!(read_workbook_stream(&old).is_none());
        assert!(read_workbook_stream(&[1, 2, 3]).is_none());

        // Cut mid-record: what came before the cut is still good.
        let mut stream = workbook(rec(0x0201, &u16s(&[0, 0, 1])), Vec::new());
        stream.extend(MERGEDCELLS.to_le_bytes());
        stream.extend(500u16.to_le_bytes());
        let s = read_workbook_stream(&stream).unwrap().remove(0).unwrap();
        assert_eq!(s.cell_xf.get(&(1, 1)), Some(&1));
    }

    #[test]
    fn a_chart_sheet_keeps_its_place_in_the_list() {
        let mut head = bof(0x0005);
        head.extend(font(200, 0));
        let offset = (head.len() + 2 * (4 + 8) + 4) as u32;
        let mut bound = offset.to_le_bytes().to_vec();
        bound.extend([0, 2, 1, 0]);
        head.extend(rec(BOUNDSHEET, &bound));
        let after = offset + bof(0x0020).len() as u32 + 4;
        let mut bound = after.to_le_bytes().to_vec();
        bound.extend([0, 0, 1, 0]);
        head.extend(rec(BOUNDSHEET, &bound));
        head.extend(rec(EOF, &[]));
        head.extend(bof(0x0020));
        head.extend(rec(EOF, &[]));
        head.extend(bof(SUBSTREAM_WORKSHEET));
        head.extend(rec(EOF, &[]));

        let sheets = read_workbook_stream(&head).unwrap();
        assert_eq!(sheets.len(), 2);
        assert!(sheets[0].is_none());
        assert!(sheets[1].is_some());
    }
}
