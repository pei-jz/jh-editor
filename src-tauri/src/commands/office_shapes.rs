//! The drawing layer of a sheet: pictures, shapes, connectors and groups.
//!
//! A 設計書's flowchart is not cells. It lives in the sheet's drawing part as
//! DrawingML — preset shapes, connector lines with arrowheads, text boxes,
//! groups of all three — anchored to the grid the same way a pasted picture
//! is. This reads that part into something the view can draw as SVG.
//!
//! "Something the view can draw" is the whole ambition. A shape keeps its
//! geometry name, its colours resolved to "#rrggbb", its line and arrowheads,
//! its rotation and flips, and its text with the first run's look. It does not
//! keep shadows, glow, 3-D, gradients past their first stop, per-run fonts, or
//! the text inset of each geometry. That is enough to read a flowchart, and a
//! flowchart is what this is for.
//!
//! The part is small (kilobytes), so it is read into a tree first and walked
//! afterwards; groups nest, and a streaming reader would have to carry the
//! nesting by hand.

use std::collections::HashMap;

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use serde::Serialize;

use super::office::DEFAULT_THEME;

const EMU_PER_PX: f64 = 9525.0;
/// Excel's default size for shape text: 11pt.
const DEFAULT_FONT_PX: f64 = 11.0 * 96.0 / 72.0;

// ---------------------------------------------------------------------------
// What the view receives
// ---------------------------------------------------------------------------

/// One shape or connector, as the view draws it. Sizes are px; colours are
/// "#rrggbb" or "" for none.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ShapeSpec {
    /// The preset geometry ("rect", "flowChartDecision", "bentConnector3", …),
    /// or "custom" with `path` set.
    pub geom: String,
    /// For "custom": the outline as an SVG path in fractions of the box
    /// (0..1 on each axis), so the view only has to scale it.
    pub path: String,
    /// The geometry's adjust values ("adj", "adj1", …) as fractions —
    /// 50000 in the file is 0.5 here.
    pub adj: HashMap<String, f64>,
    /// A line rather than an outline: drawn from corner to corner, never filled.
    pub connector: bool,
    pub fill: String,
    pub line: String,
    pub line_width: f64,
    /// "", "dash", "sysDash", "dot", "sysDot", "dashDot", "lgDash", …
    pub dash: String,
    /// Arrowheads at the start and the end: "", "triangle", "arrow",
    /// "stealth", "diamond" or "oval".
    pub head: String,
    pub tail: String,
    /// Degrees, clockwise.
    pub rot: f64,
    pub flip_h: bool,
    pub flip_v: bool,
    /// The text, one line per paragraph.
    pub text: String,
    pub text_color: String,
    pub font_size: f64,
    pub bold: bool,
    /// "left", "center" or "right".
    pub halign: String,
    /// "top", "center" or "bottom".
    pub valign: String,
}

/// One thing in the drawing, before it is placed on the grid shown.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct DrawingItem {
    /// (row, col, rowOff, colOff): 0-based cells, offsets in EMU.
    pub from: (usize, usize, i64, i64),
    pub to: Option<(usize, usize, i64, i64)>,
    /// The anchor's size in EMU, when the file gives one.
    pub ext: (i64, i64),
    /// A picture's relationship id.
    pub embed: Option<String>,
    /// A shape's look. None for a picture.
    pub shape: Option<ShapeSpec>,
    /// Where in the anchor's box this item sits, as fractions (x, y, w, h).
    /// (0, 0, 1, 1) for anything not inside a group.
    pub frac: [f64; 4],
}

// ---------------------------------------------------------------------------
// A small tree
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct XNode {
    /// Local name: "sp", not "xdr:sp". The prefixes are whatever the writer
    /// chose, and LibreOffice does not choose Excel's.
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<XNode>,
    text: String,
}

fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

impl XNode {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .or_else(|| self.attrs.iter().find(|(k, _)| local(k) == name))
            .map(|(_, v)| v.as_str())
    }
    fn num(&self, name: &str) -> Option<f64> {
        self.attr(name)?.trim().parse().ok()
    }
    fn flag(&self, name: &str) -> bool {
        matches!(self.attr(name), Some("1") | Some("true"))
    }
    fn child(&self, name: &str) -> Option<&XNode> {
        self.children.iter().find(|c| c.name == name)
    }
    fn kids<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a XNode> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }
    fn path(&self, names: &[&str]) -> Option<&XNode> {
        let mut n = self;
        for name in names {
            n = n.child(name)?;
        }
        Some(n)
    }
}

fn node_of(e: &BytesStart) -> XNode {
    let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
    let attrs = e
        .attributes()
        .flatten()
        .map(|a| {
            let key = String::from_utf8_lossy(a.key.as_ref()).to_string();
            let raw = String::from_utf8_lossy(a.value.as_ref()).to_string();
            let value = quick_xml::escape::unescape(&raw).map(|v| v.to_string()).unwrap_or(raw.clone());
            (key, value)
        })
        .collect();
    XNode { name: local(&name).to_string(), attrs, children: Vec::new(), text: String::new() }
}

fn parse_tree(xml: &str) -> Option<XNode> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(false);
    let mut stack = vec![XNode { name: "#root".into(), ..Default::default() }];
    loop {
        match reader.read_event() {
            Err(_) => return None,
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => stack.push(node_of(&e)),
            Ok(Event::Empty(e)) => {
                let node = node_of(&e);
                stack.last_mut()?.children.push(node);
            }
            Ok(Event::Text(t)) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(Event::End(_)) => {
                if stack.len() > 1 {
                    let node = stack.pop()?;
                    stack.last_mut()?.children.push(node);
                }
            }
            _ => {}
        }
    }
    while stack.len() > 1 {
        let node = stack.pop()?;
        stack.last_mut()?.children.push(node);
    }
    stack.pop()
}

// ---------------------------------------------------------------------------
// Reading the drawing
// ---------------------------------------------------------------------------

/// Everything drawn on a sheet, in drawing order (later is on top).
pub(crate) fn read_drawing(xml: &str, theme: &[String]) -> Vec<DrawingItem> {
    let Some(root) = parse_tree(xml) else { return Vec::new() };
    let mut out = Vec::new();
    for ws in &root.children {
        for anchor in &ws.children {
            read_anchor(anchor, theme, &mut out);
        }
    }
    out
}

fn read_anchor(anchor: &XNode, theme: &[String], out: &mut Vec<DrawingItem>) {
    match anchor.name.as_str() {
        "twoCellAnchor" | "oneCellAnchor" | "absoluteAnchor" => {}
        // Newer content wrapped with a fallback for older readers: take the
        // newer one, and the fallback only if that gave nothing.
        "AlternateContent" => {
            alternate(anchor, out, |n, out| read_anchor(n, theme, out));
            return;
        }
        _ => return,
    }

    let corner = |n: &XNode| {
        let get = |k: &str| n.child(k).and_then(|c| c.text.trim().parse::<i64>().ok()).unwrap_or(0);
        (get("row").max(0) as usize, get("col").max(0) as usize, get("rowOff"), get("colOff"))
    };
    let base = DrawingItem {
        from: anchor.child("from").map(corner).unwrap_or_default(),
        to: anchor.child("to").map(corner),
        ext: anchor
            .child("ext")
            .map(|e| (e.num("cx").unwrap_or(0.0) as i64, e.num("cy").unwrap_or(0.0) as i64))
            .unwrap_or((0, 0)),
        frac: [0.0, 0.0, 1.0, 1.0],
        ..Default::default()
    };
    for el in &anchor.children {
        walk(el, theme, &base, None, out);
    }
}

fn alternate(node: &XNode, out: &mut Vec<DrawingItem>, mut each: impl FnMut(&XNode, &mut Vec<DrawingItem>)) {
    let before = out.len();
    if let Some(choice) = node.child("Choice") {
        for n in &choice.children {
            each(n, out);
        }
    }
    if out.len() == before {
        if let Some(fallback) = node.child("Fallback") {
            for n in &fallback.children {
                each(n, out);
            }
        }
    }
}

/// A group's box in the anchor (fractions) and its child coordinate space.
#[derive(Clone, Copy)]
struct GroupMap {
    box_: [f64; 4],
    ch: [f64; 4],
}

#[derive(Default, Clone, Copy)]
struct Xfrm {
    off: (f64, f64),
    ext: (f64, f64),
    ch_off: (f64, f64),
    ch_ext: (f64, f64),
    rot: f64,
    flip_h: bool,
    flip_v: bool,
}

fn xfrm_of(n: Option<&XNode>) -> Xfrm {
    let Some(n) = n else { return Xfrm::default() };
    let pair = |name: &str, a: &str, b: &str| {
        n.child(name)
            .map(|c| (c.num(a).unwrap_or(0.0), c.num(b).unwrap_or(0.0)))
            .unwrap_or((0.0, 0.0))
    };
    Xfrm {
        off: pair("off", "x", "y"),
        ext: pair("ext", "cx", "cy"),
        ch_off: pair("chOff", "x", "y"),
        ch_ext: pair("chExt", "cx", "cy"),
        rot: n.num("rot").unwrap_or(0.0) / 60000.0,
        flip_h: n.flag("flipH"),
        flip_v: n.flag("flipV"),
    }
}

/// Where a box sits in the anchor, as fractions.
fn place(x: &Xfrm, map: Option<GroupMap>) -> [f64; 4] {
    let Some(m) = map else { return [0.0, 0.0, 1.0, 1.0] };
    let sx = if m.ch[2] > 0.0 { m.box_[2] / m.ch[2] } else { 0.0 };
    let sy = if m.ch[3] > 0.0 { m.box_[3] / m.ch[3] } else { 0.0 };
    [
        m.box_[0] + (x.off.0 - m.ch[0]) * sx,
        m.box_[1] + (x.off.1 - m.ch[1]) * sy,
        x.ext.0 * sx,
        x.ext.1 * sy,
    ]
}

fn walk(el: &XNode, theme: &[String], base: &DrawingItem, map: Option<GroupMap>, out: &mut Vec<DrawingItem>) {
    match el.name.as_str() {
        "sp" | "cxnSp" => {
            let nv = el.child("nvSpPr").or_else(|| el.child("nvCxnSpPr"));
            if nv.and_then(|n| n.child("cNvPr")).is_some_and(|c| c.flag("hidden")) {
                return;
            }
            let sp_pr = el.child("spPr");
            let x = xfrm_of(sp_pr.and_then(|s| s.child("xfrm")));
            let spec = shape_spec(el, sp_pr, &x, theme, el.name == "cxnSp");
            let mut item = DrawingItem { shape: Some(spec), frac: place(&x, map), ..base.clone() };
            if item.ext == (0, 0) {
                item.ext = (x.ext.0 as i64, x.ext.1 as i64);
            }
            out.push(item);
        }
        "pic" => {
            if el.path(&["nvPicPr", "cNvPr"]).is_some_and(|c| c.flag("hidden")) {
                return;
            }
            let Some(embed) = el.path(&["blipFill", "blip"]).and_then(|b| b.attr("r:embed")) else {
                return;
            };
            let x = xfrm_of(el.path(&["spPr", "xfrm"]));
            let mut item = DrawingItem {
                embed: Some(embed.to_string()),
                frac: place(&x, map),
                ..base.clone()
            };
            if item.ext == (0, 0) {
                item.ext = (x.ext.0 as i64, x.ext.1 as i64);
            }
            out.push(item);
        }
        "grpSp" => {
            let x = xfrm_of(el.path(&["grpSpPr", "xfrm"]));
            let inner = GroupMap {
                box_: place(&x, map),
                ch: [x.ch_off.0, x.ch_off.1, x.ch_ext.0, x.ch_ext.1],
            };
            for child in &el.children {
                walk(child, theme, base, Some(inner), out);
            }
        }
        "AlternateContent" => alternate(el, out, |n, out| walk(n, theme, base, map, out)),
        // Charts, form controls, ink: not drawn.
        _ => {}
    }
}

const LINE_GEOMS: [&str; 10] = [
    "line",
    "straightConnector1",
    "bentConnector2",
    "bentConnector3",
    "bentConnector4",
    "bentConnector5",
    "curvedConnector2",
    "curvedConnector3",
    "curvedConnector4",
    "curvedConnector5",
];

fn shape_spec(el: &XNode, sp_pr: Option<&XNode>, x: &Xfrm, theme: &[String], is_cxn: bool) -> ShapeSpec {
    let style = el.child("style");
    let mut spec = ShapeSpec {
        rot: x.rot,
        flip_h: x.flip_h,
        flip_v: x.flip_v,
        font_size: DEFAULT_FONT_PX,
        halign: "left".into(),
        valign: "top".into(),
        ..Default::default()
    };

    // Geometry.
    if let Some(prst) = sp_pr.and_then(|s| s.child("prstGeom")) {
        spec.geom = prst.attr("prst").unwrap_or("rect").to_string();
        if let Some(av) = prst.child("avLst") {
            for gd in av.kids("gd") {
                let (Some(name), Some(fmla)) = (gd.attr("name"), gd.attr("fmla")) else { continue };
                if let Some(v) = fmla.strip_prefix("val ").and_then(|v| v.trim().parse::<f64>().ok()) {
                    spec.adj.insert(name.to_string(), v / 100000.0);
                }
            }
        }
    } else if let Some(cust) = sp_pr.and_then(|s| s.child("custGeom")) {
        match custom_path(cust, x.ext) {
            Some(d) if !d.is_empty() => {
                spec.geom = "custom".into();
                spec.path = d;
            }
            _ => spec.geom = "rect".into(),
        }
    } else {
        spec.geom = "rect".into();
    }
    spec.connector = is_cxn || LINE_GEOMS.contains(&spec.geom.as_str());

    // Fill: the shape's own, else its style's reference into the theme.
    let own_fill = sp_pr.and_then(|s| fill_of(s, theme));
    spec.fill = match own_fill {
        Some(f) => f,
        None => style
            .and_then(|s| s.child("fillRef"))
            .filter(|r| r.num("idx").unwrap_or(0.0) > 0.0)
            .and_then(|r| color_in(r, theme, None))
            .unwrap_or_default(),
    };
    if spec.connector {
        spec.fill.clear();
    }

    // Line.
    let ln = sp_pr.and_then(|s| s.child("ln"));
    let ln_ref = style.and_then(|s| s.child("lnRef"));
    let ref_idx = ln_ref.and_then(|r| r.num("idx")).unwrap_or(0.0) as usize;
    let none = ln.is_some_and(|l| l.child("noFill").is_some());
    if !none {
        let own = ln.and_then(|l| {
            l.child("solidFill")
                .and_then(|f| color_in(f, theme, None))
                .or_else(|| l.path(&["gradFill", "gsLst", "gs"]).and_then(|g| color_in(g, theme, None)))
        });
        spec.line = own
            .or_else(|| ln_ref.filter(|_| ref_idx > 0).and_then(|r| color_in(r, theme, None)))
            .unwrap_or_default();
    }
    let width_emu = ln
        .and_then(|l| l.num("w"))
        .or_else(|| [0.0, 6350.0, 12700.0, 19050.0].get(ref_idx).copied().filter(|w| *w > 0.0))
        .unwrap_or(9525.0);
    spec.line_width = width_emu / EMU_PER_PX;
    if let Some(l) = ln {
        spec.dash = l.child("prstDash").and_then(|d| d.attr("val")).unwrap_or("").to_string();
        if spec.dash == "solid" {
            spec.dash.clear();
        }
        let end = |name: &str| {
            l.child(name)
                .and_then(|e| e.attr("type"))
                .filter(|t| *t != "none")
                .map(|t| match t {
                    "triangle" | "arrow" | "stealth" | "diamond" | "oval" => t.to_string(),
                    _ => "triangle".to_string(),
                })
                .unwrap_or_default()
        };
        spec.head = end("headEnd");
        spec.tail = end("tailEnd");
    }

    // Text: one line per paragraph, the look of the first run.
    if let Some(body) = el.child("txBody") {
        if let Some(bp) = body.child("bodyPr") {
            spec.valign = match bp.attr("anchor") {
                Some("ctr") => "center",
                Some("b") => "bottom",
                _ => "top",
            }
            .into();
        }
        let mut lines = Vec::new();
        let mut first_run: Option<&XNode> = None;
        let mut first_align: Option<&str> = None;
        for p in body.kids("p") {
            if first_align.is_none() {
                first_align = p.child("pPr").and_then(|pp| pp.attr("algn"));
            }
            let mut line = String::new();
            for r in &p.children {
                match r.name.as_str() {
                    "r" | "fld" => {
                        if first_run.is_none() {
                            first_run = r.child("rPr");
                        }
                        if let Some(t) = r.child("t") {
                            line.push_str(&t.text);
                        }
                    }
                    "br" => line.push('\n'),
                    _ => {}
                }
            }
            lines.push(line);
        }
        while lines.last().is_some_and(|l| l.trim().is_empty()) {
            lines.pop();
        }
        spec.text = lines.join("\n");
        spec.halign = match first_align {
            Some("ctr") => "center",
            Some("r") => "right",
            _ => "left",
        }
        .into();
        if let Some(rpr) = first_run {
            if let Some(sz) = rpr.num("sz") {
                spec.font_size = sz / 100.0 * 96.0 / 72.0;
            }
            spec.bold = rpr.flag("b");
            spec.text_color = rpr.child("solidFill").and_then(|f| color_in(f, theme, None)).unwrap_or_default();
        }
        if spec.text_color.is_empty() {
            spec.text_color = style
                .and_then(|s| s.child("fontRef"))
                .and_then(|r| color_in(r, theme, None))
                .unwrap_or_default();
        }
    }
    spec
}

/// A shape's own fill: Some("") for an explicit "no fill", None when the
/// shape says nothing and its style decides.
fn fill_of(sp_pr: &XNode, theme: &[String]) -> Option<String> {
    for c in &sp_pr.children {
        match c.name.as_str() {
            "noFill" => return Some(String::new()),
            "solidFill" => return Some(color_in(c, theme, None).unwrap_or_default()),
            // The first stop stands for a gradient; a pattern for its foreground.
            "gradFill" => {
                return Some(
                    c.path(&["gsLst", "gs"]).and_then(|g| color_in(g, theme, None)).unwrap_or_default(),
                )
            }
            "pattFill" => {
                return Some(c.child("fgClr").and_then(|g| color_in(g, theme, None)).unwrap_or_default())
            }
            "blipFill" | "grpFill" => return Some(String::new()),
            _ => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

fn scheme_color(theme: &[String], name: &str) -> Option<String> {
    let i = match name {
        "lt1" | "bg1" => 0,
        "dk1" | "tx1" => 1,
        "lt2" | "bg2" => 2,
        "dk2" | "tx2" => 3,
        "accent1" => 4,
        "accent2" => 5,
        "accent3" => 6,
        "accent4" => 7,
        "accent5" => 8,
        "accent6" => 9,
        "hlink" => 10,
        "folHlink" => 11,
        _ => return None,
    };
    theme
        .get(i)
        .filter(|c| !c.is_empty())
        .cloned()
        .or_else(|| DEFAULT_THEME.get(i).map(|c| c.to_string()))
}

fn preset_color(name: &str) -> Option<String> {
    let hex = match name {
        "black" => "#000000",
        "white" => "#ffffff",
        "red" => "#ff0000",
        "green" => "#008000",
        "lime" => "#00ff00",
        "blue" => "#0000ff",
        "yellow" => "#ffff00",
        "orange" => "#ffa500",
        "gray" | "grey" => "#808080",
        "darkGray" | "dkGray" => "#a9a9a9",
        "lightGray" | "ltGray" => "#d3d3d3",
        "navy" => "#000080",
        "purple" => "#800080",
        _ => return None,
    };
    Some(hex.to_string())
}

fn valid_hex(hex: &str) -> bool {
    hex.len() == 7 && hex.starts_with('#') && hex[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// The colour a DrawingML colour holder (solidFill, fillRef, gs, …) names,
/// with its modifiers applied.
fn color_in(holder: &XNode, theme: &[String], placeholder: Option<&str>) -> Option<String> {
    for c in &holder.children {
        let base = match c.name.as_str() {
            "srgbClr" => c.attr("val").map(|v| format!("#{}", v.to_ascii_lowercase())),
            "sysClr" => c.attr("lastClr").map(|v| format!("#{}", v.to_ascii_lowercase())),
            "schemeClr" => match c.attr("val") {
                Some("phClr") => placeholder.map(str::to_string),
                Some(v) => scheme_color(theme, v),
                None => None,
            },
            "prstClr" => c.attr("val").and_then(preset_color),
            _ => continue,
        };
        let mut hex = base?;
        if !valid_hex(&hex) {
            return None;
        }
        for m in &c.children {
            let v = m.num("val").unwrap_or(100000.0) / 100000.0;
            hex = match m.name.as_str() {
                "lumMod" => with_lightness(&hex, |l| l * v),
                "lumOff" => with_lightness(&hex, |l| l + v),
                "shade" => map_rgb(&hex, |c| c * v),
                "tint" => map_rgb(&hex, |c| 1.0 - (1.0 - c) * v),
                _ => hex,
            };
        }
        return Some(hex);
    }
    None
}

fn rgb_of(hex: &str) -> (f64, f64, f64) {
    let ch = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0) as f64 / 255.0;
    (ch(1), ch(3), ch(5))
}

fn hex_of(r: f64, g: f64, b: f64) -> String {
    let byte = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
}

fn map_rgb(hex: &str, f: impl Fn(f64) -> f64) -> String {
    let (r, g, b) = rgb_of(hex);
    hex_of(f(r), f(g), f(b))
}

fn with_lightness(hex: &str, f: impl Fn(f64) -> f64) -> String {
    let (r, g, b) = rgb_of(hex);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    let (h, s) = if d == 0.0 {
        (0.0, 0.0)
    } else {
        let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
        let h = if max == r {
            ((g - b) / d).rem_euclid(6.0)
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        (h / 6.0, s)
    };
    let l = f(l).clamp(0.0, 1.0);
    if s == 0.0 {
        return hex_of(l, l, l);
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let hue = |t: f64| {
        let t = t.rem_euclid(1.0);
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    hex_of(hue(h + 1.0 / 3.0), hue(h), hue(h - 1.0 / 3.0))
}

// ---------------------------------------------------------------------------
// Freeform outlines
// ---------------------------------------------------------------------------

fn fmt(v: f64) -> String {
    let s = format!("{:.4}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" || s.is_empty() { "0".into() } else { s.to_string() }
}

/// A <a:custGeom> outline as an SVG path in fractions of the box. None when a
/// coordinate is a formula rather than a number — the guide language is not
/// evaluated here, and a half-drawn outline is worse than a plain box.
fn custom_path(cust: &XNode, shape_ext: (f64, f64)) -> Option<String> {
    let list = cust.child("pathLst")?;
    let mut d = String::new();
    for path in list.kids("path") {
        let w = path.num("w").filter(|v| *v > 0.0).unwrap_or(shape_ext.0.max(1.0));
        let h = path.num("h").filter(|v| *v > 0.0).unwrap_or(shape_ext.1.max(1.0));
        let pt = |n: &XNode| -> Option<(f64, f64)> { Some((n.num("x")?, n.num("y")?)) };
        let mut cur = (0.0, 0.0);
        for cmd in &path.children {
            match cmd.name.as_str() {
                "moveTo" | "lnTo" => {
                    let p = pt(cmd.child("pt")?)?;
                    let op = if cmd.name == "moveTo" { "M" } else { "L" };
                    d.push_str(&format!("{}{} {} ", op, fmt(p.0 / w), fmt(p.1 / h)));
                    cur = p;
                }
                "cubicBezTo" | "quadBezTo" => {
                    let pts: Option<Vec<(f64, f64)>> = cmd.kids("pt").map(pt).collect();
                    let pts = pts?;
                    let op = if cmd.name == "cubicBezTo" { "C" } else { "Q" };
                    if pts.len() != if op == "C" { 3 } else { 2 } {
                        return None;
                    }
                    d.push_str(op);
                    for p in &pts {
                        d.push_str(&format!("{} {} ", fmt(p.0 / w), fmt(p.1 / h)));
                    }
                    cur = *pts.last()?;
                }
                "arcTo" => {
                    let (wr, hr) = (cmd.num("wR")?, cmd.num("hR")?);
                    let st = cmd.num("stAng")? / 60000.0;
                    let sw = cmd.num("swAng")? / 60000.0;
                    let (a0, a1) = (st.to_radians(), (st + sw).to_radians());
                    let cx = cur.0 - wr * a0.cos();
                    let cy = cur.1 - hr * a0.sin();
                    let end = (cx + wr * a1.cos(), cy + hr * a1.sin());
                    d.push_str(&format!(
                        "A{} {} 0 {} {} {} {} ",
                        fmt(wr / w),
                        fmt(hr / h),
                        if sw.abs() > 180.0 { 1 } else { 0 },
                        if sw > 0.0 { 1 } else { 0 },
                        fmt(end.0 / w),
                        fmt(end.1 / h)
                    ));
                    cur = end;
                }
                "close" => d.push_str("Z "),
                _ => {}
            }
        }
    }
    Some(d.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn office_theme() -> Vec<String> {
        DEFAULT_THEME.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_flowchart_comes_back_as_shapes_connectors_and_a_picture() {
        let xml = r#"<xdr:wsDr xmlns:xdr="x" xmlns:a="a" xmlns:r="r">
<xdr:twoCellAnchor>
  <xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
  <xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
  <xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="判断"/><xdr:cNvSpPr/></xdr:nvSpPr>
    <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="flowChartDecision"><a:avLst/></a:prstGeom></xdr:spPr>
    <xdr:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef>
      <a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef>
      <a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></xdr:style>
    <xdr:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ja-JP" sz="1100" b="1"/><a:t>OK?</a:t></a:r></a:p></xdr:txBody>
  </xdr:sp><xdr:clientData/>
</xdr:twoCellAnchor>
<xdr:twoCellAnchor>
  <xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
  <xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
  <xdr:cxnSp><xdr:nvCxnSpPr><xdr:cNvPr id="3" name="c"/><xdr:cNvCxnSpPr/></xdr:nvCxnSpPr>
    <xdr:spPr><a:xfrm flipV="1"><a:off x="0" y="0"/><a:ext cx="0" cy="381000"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>
      <a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="dash"/><a:tailEnd type="triangle"/></a:ln></xdr:spPr>
  </xdr:cxnSp><xdr:clientData/>
</xdr:twoCellAnchor>
<xdr:twoCellAnchor>
  <xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
  <xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
  <xdr:grpSp><xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4000" cy="2000"/><a:chOff x="1000" y="1000"/><a:chExt cx="4000" cy="2000"/></a:xfrm></xdr:grpSpPr>
    <xdr:sp><xdr:spPr><a:xfrm><a:off x="1000" y="1000"/><a:ext cx="2000" cy="1000"/></a:xfrm><a:prstGeom prst="rect"/><a:noFill/><a:ln><a:noFill/></a:ln></xdr:spPr>
      <xdr:txBody><a:bodyPr/><a:p><a:r><a:t>line 1</a:t></a:r></a:p><a:p><a:r><a:t>line 2</a:t></a:r></a:p></xdr:txBody></xdr:sp>
    <xdr:pic><xdr:nvPicPr><xdr:cNvPr id="5" name="p"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill>
      <xdr:spPr><a:xfrm><a:off x="3000" y="2000"/><a:ext cx="2000" cy="1000"/></a:xfrm></xdr:spPr></xdr:pic>
    <xdr:sp><xdr:nvSpPr><xdr:cNvPr id="6" name="hidden" hidden="1"/></xdr:nvSpPr><xdr:spPr/></xdr:sp>
  </xdr:grpSp><xdr:clientData/>
</xdr:twoCellAnchor>
</xdr:wsDr>"#;
        let items = read_drawing(xml, &office_theme());
        assert_eq!(items.len(), 4);

        let decision = items[0].shape.as_ref().unwrap();
        assert_eq!(decision.geom, "flowChartDecision");
        // The style's references into the theme: accent1 fill, a darker
        // accent1 line, white text.
        assert_eq!(decision.fill, "#4472c4");
        assert_eq!(decision.line, "#223962");
        assert_eq!(decision.text, "OK?");
        assert_eq!(decision.text_color, "#ffffff");
        assert!(decision.bold);
        assert_eq!((decision.halign.as_str(), decision.valign.as_str()), ("center", "center"));
        assert_eq!(items[0].from, (2, 1, 0, 0));

        let arrow = items[1].shape.as_ref().unwrap();
        assert!(arrow.connector);
        assert!(arrow.fill.is_empty(), "a line is never filled");
        assert_eq!((arrow.line.as_str(), arrow.line_width), ("#ff0000", 2.0));
        assert_eq!((arrow.dash.as_str(), arrow.head.as_str(), arrow.tail.as_str()), ("dash", "", "triangle"));
        assert!(arrow.flip_v);

        // Inside the group: placed by fractions of the group's anchor box.
        let label = items[2].shape.as_ref().unwrap();
        assert_eq!(items[2].frac, [0.0, 0.0, 0.5, 0.5]);
        assert_eq!(label.text, "line 1\nline 2");
        assert!(label.fill.is_empty() && label.line.is_empty());
        assert_eq!(items[3].embed.as_deref(), Some("rId1"));
        assert_eq!(items[3].frac, [0.5, 0.5, 0.5, 0.5]);
        assert_eq!(items[3].from, (9, 0, 0, 0));
    }

    #[test]
    fn a_colour_modifier_moves_the_colour_the_way_office_does() {
        let theme = office_theme();
        let holder = parse_tree(
            r#"<a:solidFill xmlns:a="a"><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill>"#,
        )
        .unwrap();
        // "Black, Text 1, Lighter 35%" is #595959 in Excel's colour picker.
        assert_eq!(color_in(&holder.children[0], &theme, None).as_deref(), Some("#595959"));
    }

    #[test]
    fn a_freeform_outline_becomes_a_path_in_fractions_of_its_box() {
        let cust = parse_tree(
            r#"<a:custGeom xmlns:a="a"><a:pathLst><a:path w="200" h="100">
<a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="200" y="50"/></a:lnTo>
<a:cubicBezTo><a:pt x="100" y="100"/><a:pt x="50" y="100"/><a:pt x="0" y="100"/></a:cubicBezTo><a:close/>
</a:path></a:pathLst></a:custGeom>"#,
        )
        .unwrap();
        let d = custom_path(&cust.children[0], (0.0, 0.0)).unwrap();
        assert_eq!(d, "M0 0 L1 0.5 C0.5 1 0.25 1 0 1 Z");

        // A coordinate given as a guide name is not something this evaluates.
        let guided = parse_tree(
            r#"<a:custGeom xmlns:a="a"><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="l" y="t"/></a:moveTo></a:path></a:pathLst></a:custGeom>"#,
        )
        .unwrap();
        assert_eq!(custom_path(&guided.children[0], (0.0, 0.0)), None);
    }
}
