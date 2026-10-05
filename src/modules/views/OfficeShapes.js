/**
 * OfficeShapes — DrawingML shapes, drawn as SVG.
 *
 * The reading is done in Rust (commands/office_shapes.rs): a shape arrives as
 * a preset name ("flowChartDecision"), colours already resolved to "#rrggbb",
 * a line, arrowheads, rotation and flips, and its text. This file turns that
 * into an outline at the size the grid gives it.
 *
 * The presets are Office's own, re-drawn by hand. Not all of them: the ones a
 * flowchart, a block diagram or a screen-transition diagram is made of. The
 * rest are drawn as their bounding box, which still puts their text in the
 * right place — a plain box where a star was is a smaller lie than nothing.
 *
 * Everything here is a pure function of its inputs, so it can be tested
 * without a grid.
 */

const LINE_GEOMS = new Set([
    'line', 'straightConnector1',
    'bentConnector2', 'bentConnector3', 'bentConnector4', 'bentConnector5',
    'curvedConnector2', 'curvedConnector3', 'curvedConnector4', 'curvedConnector5',
]);

const ARROWS = new Set(['triangle', 'arrow', 'stealth', 'diamond', 'oval']);

/** Two decimals is a hundredth of a pixel; more only bloats the markup. */
const n = (v) => {
    const r = Math.round(v * 100) / 100;
    return Object.is(r, -0) ? '0' : String(r);
};

const poly = (pts) => `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')} Z`;

function ellipsePath(x, y, w, h) {
    const rx = w / 2;
    const ry = h / 2;
    return `M${n(x)} ${n(y + ry)} A${n(rx)} ${n(ry)} 0 1 1 ${n(x + w)} ${n(y + ry)}`
        + ` A${n(rx)} ${n(ry)} 0 1 1 ${n(x)} ${n(y + ry)} Z`;
}

function roundRectPath(w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    if (!rr) return poly([[0, 0], [w, 0], [w, h], [0, h]]);
    return `M${n(rr)} 0 H${n(w - rr)} A${n(rr)} ${n(rr)} 0 0 1 ${n(w)} ${n(rr)}`
        + ` V${n(h - rr)} A${n(rr)} ${n(rr)} 0 0 1 ${n(w - rr)} ${n(h)}`
        + ` H${n(rr)} A${n(rr)} ${n(rr)} 0 0 1 0 ${n(h - rr)}`
        + ` V${n(rr)} A${n(rr)} ${n(rr)} 0 0 1 ${n(rr)} 0 Z`;
}

/** The flowchart "document": a box whose bottom edge is a wave. */
function documentPath(x, y, w, h) {
    return `M${n(x)} ${n(y)} H${n(x + w)} V${n(y + h * 0.83)}`
        + ` C${n(x + w * 0.7)} ${n(y + h * 0.6)} ${n(x + w * 0.35)} ${n(y + h * 1.05)} ${n(x)} ${n(y + h * 0.9)} Z`;
}

/**
 * The outline of a preset shape at w × h, as an SVG path — or null for a
 * preset not drawn here, which the caller draws as its box.
 *
 * `adj` holds the shape's adjust values as fractions (Office's 50000 is 0.5).
 * Where Office measures an adjustment against the shorter side, so does this.
 */
export function presetPath(geom, w, h, adj = {}) {
    const a = (name, def) => (adj && Number.isFinite(adj[name]) ? adj[name] : def);
    const ss = Math.min(w, h);
    switch (geom) {
        case 'rect':
        case 'flowChartProcess':
            return poly([[0, 0], [w, 0], [w, h], [0, h]]);
        case 'roundRect':
        case 'flowChartAlternateProcess':
            return roundRectPath(w, h, ss * a('adj', 0.16667));
        case 'flowChartTerminator':
            return roundRectPath(w, h, Math.min(w, h) / 2);
        case 'ellipse':
        case 'flowChartConnector':
            return ellipsePath(0, 0, w, h);
        case 'diamond':
        case 'flowChartDecision':
            return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
        case 'parallelogram': {
            const o = Math.min(w, ss * a('adj', 0.25));
            return poly([[o, 0], [w, 0], [w - o, h], [0, h]]);
        }
        case 'flowChartInputOutput':
            return poly([[w * 0.2, 0], [w, 0], [w * 0.8, h], [0, h]]);
        case 'trapezoid': {
            const o = Math.min(w / 2, ss * a('adj', 0.25));
            return poly([[o, 0], [w - o, 0], [w, h], [0, h]]);
        }
        case 'flowChartManualOperation':
            return poly([[0, 0], [w, 0], [w * 0.8, h], [w * 0.2, h]]);
        case 'triangle': {
            const x = w * a('adj', 0.5);
            return poly([[x, 0], [w, h], [0, h]]);
        }
        case 'flowChartExtract':
            return poly([[w / 2, 0], [w, h], [0, h]]);
        case 'flowChartMerge':
            return poly([[0, 0], [w, 0], [w / 2, h]]);
        case 'rtTriangle':
            return poly([[0, 0], [w, h], [0, h]]);
        case 'hexagon': {
            const o = Math.min(w / 2, ss * a('adj', 0.25));
            return poly([[o, 0], [w - o, 0], [w, h / 2], [w - o, h], [o, h], [0, h / 2]]);
        }
        case 'flowChartPreparation':
            return poly([[w * 0.2, 0], [w * 0.8, 0], [w, h / 2], [w * 0.8, h], [w * 0.2, h], [0, h / 2]]);
        case 'octagon': {
            const o = Math.min(w / 2, h / 2, ss * a('adj', 0.29289));
            return poly([[o, 0], [w - o, 0], [w, o], [w, h - o], [w - o, h], [o, h], [0, h - o], [0, o]]);
        }
        case 'pentagon':
            return poly([[w / 2, 0], [w, h * 0.38], [w * 0.81, h], [w * 0.19, h], [0, h * 0.38]]);
        case 'homePlate': {
            const o = Math.min(w, ss * a('adj', 0.5));
            return poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h]]);
        }
        case 'chevron': {
            const o = Math.min(w / 2, ss * a('adj', 0.5));
            return poly([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h], [o, h / 2]]);
        }
        case 'plus':
        case 'flowChartOr': {
            if (geom === 'flowChartOr') {
                return `${ellipsePath(0, 0, w, h)} M${n(w / 2)} 0 V${n(h)} M0 ${n(h / 2)} H${n(w)}`;
            }
            const o = ss * a('adj', 0.25);
            return poly([[o, 0], [w - o, 0], [w - o, o], [w, o], [w, h - o], [w - o, h - o],
                [w - o, h], [o, h], [o, h - o], [0, h - o], [0, o], [o, o]]);
        }
        case 'flowChartSummingJunction': {
            const dx = (w / 2) * Math.SQRT1_2;
            const dy = (h / 2) * Math.SQRT1_2;
            return `${ellipsePath(0, 0, w, h)} M${n(w / 2 - dx)} ${n(h / 2 - dy)} L${n(w / 2 + dx)} ${n(h / 2 + dy)}`
                + ` M${n(w / 2 + dx)} ${n(h / 2 - dy)} L${n(w / 2 - dx)} ${n(h / 2 + dy)}`;
        }
        case 'flowChartPredefinedProcess':
            return `${poly([[0, 0], [w, 0], [w, h], [0, h]])} M${n(w / 8)} 0 V${n(h)} M${n(w * 7 / 8)} 0 V${n(h)}`;
        case 'flowChartInternalStorage':
            return `${poly([[0, 0], [w, 0], [w, h], [0, h]])} M${n(w / 8)} 0 V${n(h)} M0 ${n(h / 8)} H${n(w)}`;
        case 'flowChartDocument':
            return documentPath(0, 0, w, h);
        case 'flowChartMultidocument':
            return `${documentPath(0, h * 0.15, w * 0.85, h * 0.85)}`
                + ` M${n(w * 0.075)} ${n(h * 0.15)} V${n(h * 0.075)} H${n(w * 0.925)} V${n(h * 0.78)}`
                + ` M${n(w * 0.15)} ${n(h * 0.075)} V0 H${n(w)} V${n(h * 0.7)}`;
        case 'flowChartManualInput':
            return poly([[0, h * 0.2], [w, 0], [w, h], [0, h]]);
        case 'flowChartOffpageConnector':
            return poly([[0, 0], [w, 0], [w, h * 0.8], [w / 2, h], [0, h * 0.8]]);
        case 'flowChartPunchedCard':
            return poly([[w * 0.2, 0], [w, 0], [w, h], [0, h], [0, h * 0.2]]);
        case 'flowChartPunchedTape':
            return `M0 ${n(h * 0.1)} Q${n(w * 0.25)} ${n(h * 0.3)} ${n(w * 0.5)} ${n(h * 0.1)}`
                + ` Q${n(w * 0.75)} ${n(-h * 0.1)} ${n(w)} ${n(h * 0.1)} V${n(h * 0.9)}`
                + ` Q${n(w * 0.75)} ${n(h * 0.7)} ${n(w * 0.5)} ${n(h * 0.9)}`
                + ` Q${n(w * 0.25)} ${n(h * 1.1)} 0 ${n(h * 0.9)} Z`;
        case 'can':
        case 'flowChartMagneticDisk': {
            const ry = geom === 'can' ? Math.min(h / 2, ss * a('adj', 0.25) / 2) : h * 0.1;
            const rx = w / 2;
            return `M0 ${n(ry)} A${n(rx)} ${n(ry)} 0 0 1 ${n(w)} ${n(ry)} V${n(h - ry)}`
                + ` A${n(rx)} ${n(ry)} 0 0 1 0 ${n(h - ry)} Z`
                + ` M0 ${n(ry)} A${n(rx)} ${n(ry)} 0 0 0 ${n(w)} ${n(ry)}`;
        }
        case 'flowChartMagneticDrum': {
            const rx = w * 0.1;
            const ry = h / 2;
            return `M${n(rx)} 0 H${n(w - rx)} A${n(rx)} ${n(ry)} 0 0 1 ${n(w - rx)} ${n(h)}`
                + ` H${n(rx)} A${n(rx)} ${n(ry)} 0 0 1 ${n(rx)} 0 Z`
                + ` M${n(w - rx)} 0 A${n(rx)} ${n(ry)} 0 0 0 ${n(w - rx)} ${n(h)}`;
        }
        case 'flowChartDisplay':
            return `M0 ${n(h / 2)} L${n(w / 6)} 0 H${n(w * 5 / 6)}`
                + ` A${n(w / 6)} ${n(h / 2)} 0 0 1 ${n(w * 5 / 6)} ${n(h)} H${n(w / 6)} Z`;
        case 'flowChartDelay':
            return `M0 0 H${n(w / 2)} A${n(w / 2)} ${n(h / 2)} 0 0 1 ${n(w / 2)} ${n(h)} H0 Z`;
        case 'flowChartOnlineStorage':
            return `M${n(w / 6)} 0 H${n(w)} A${n(w / 6)} ${n(h / 2)} 0 0 0 ${n(w)} ${n(h)}`
                + ` H${n(w / 6)} A${n(w / 6)} ${n(h / 2)} 0 0 1 ${n(w / 6)} 0 Z`;
        case 'flowChartSort':
            return `${poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])} M0 ${n(h / 2)} H${n(w)}`;
        case 'flowChartCollate':
            return `M0 0 H${n(w)} L0 ${n(h)} H${n(w)} Z`;
        case 'rightArrow':
        case 'leftArrow': {
            const th = h * a('adj1', 0.5);
            const hd = Math.min(w, ss * a('adj2', 0.5));
            const pts = [[0, (h - th) / 2], [w - hd, (h - th) / 2], [w - hd, 0], [w, h / 2],
                [w - hd, h], [w - hd, (h + th) / 2], [0, (h + th) / 2]];
            return poly(geom === 'leftArrow' ? pts.map(([x, y]) => [w - x, y]) : pts);
        }
        case 'downArrow':
        case 'upArrow': {
            const th = w * a('adj1', 0.5);
            const hd = Math.min(h, ss * a('adj2', 0.5));
            const pts = [[(w - th) / 2, 0], [(w + th) / 2, 0], [(w + th) / 2, h - hd], [w, h - hd],
                [w / 2, h], [0, h - hd], [(w - th) / 2, h - hd]];
            return poly(geom === 'upArrow' ? pts.map(([x, y]) => [x, h - y]) : pts);
        }
        case 'leftRightArrow': {
            const th = h * a('adj1', 0.5);
            const hd = Math.min(w / 2, ss * a('adj2', 0.5));
            return poly([[0, h / 2], [hd, 0], [hd, (h - th) / 2], [w - hd, (h - th) / 2], [w - hd, 0],
                [w, h / 2], [w - hd, h], [w - hd, (h + th) / 2], [hd, (h + th) / 2], [hd, h]]);
        }
        case 'upDownArrow': {
            const th = w * a('adj1', 0.5);
            const hd = Math.min(h / 2, ss * a('adj2', 0.5));
            return poly([[w / 2, 0], [w, hd], [(w + th) / 2, hd], [(w + th) / 2, h - hd], [w, h - hd],
                [w / 2, h], [0, h - hd], [(w - th) / 2, h - hd], [(w - th) / 2, hd], [0, hd]]);
        }
        case 'wedgeRectCallout':
        case 'wedgeRoundRectCallout': {
            // The tail's tip, measured from the centre as a share of the box.
            const tx = w / 2 + w * a('adj1', -0.20833);
            const ty = h / 2 + h * a('adj2', 0.625);
            if (ty > h) return poly([[0, 0], [w, 0], [w, h], [w * 0.58, h], [tx, ty], [w * 0.33, h], [0, h]]);
            if (ty < 0) return poly([[0, 0], [w * 0.33, 0], [tx, ty], [w * 0.58, 0], [w, 0], [w, h], [0, h]]);
            if (tx < 0) return poly([[0, 0], [w, 0], [w, h], [0, h], [0, h * 0.58], [tx, ty], [0, h * 0.33]]);
            if (tx > w) return poly([[0, 0], [w, 0], [w, h * 0.33], [tx, ty], [w, h * 0.58], [w, h], [0, h]]);
            return poly([[0, 0], [w, 0], [w, h], [0, h]]);
        }
        case 'wedgeEllipseCallout': {
            const tx = w / 2 + w * a('adj1', -0.20833);
            const ty = h / 2 + h * a('adj2', 0.625);
            return `${ellipsePath(0, 0, w, h)} M${n(w * 0.4)} ${n(h * 0.9)} L${n(tx)} ${n(ty)} L${n(w * 0.25)} ${n(h * 0.8)}`;
        }
        case 'frame': {
            const t = ss * a('adj1', 0.125);
            return `${poly([[0, 0], [w, 0], [w, h], [0, h]])} ${poly([[t, t], [t, h - t], [w - t, h - t], [w - t, t]])}`;
        }
        case 'leftBracket':
            return `M${n(w)} 0 Q0 0 0 ${n(h * 0.1)} V${n(h * 0.9)} Q0 ${n(h)} ${n(w)} ${n(h)}`;
        case 'rightBracket':
            return `M0 0 Q${n(w)} 0 ${n(w)} ${n(h * 0.1)} V${n(h * 0.9)} Q${n(w)} ${n(h)} 0 ${n(h)}`;
        case 'leftBrace':
            return `M${n(w)} 0 Q${n(w / 2)} 0 ${n(w / 2)} ${n(h * 0.1)} V${n(h * 0.4)} Q${n(w / 2)} ${n(h / 2)} 0 ${n(h / 2)}`
                + ` Q${n(w / 2)} ${n(h / 2)} ${n(w / 2)} ${n(h * 0.6)} V${n(h * 0.9)} Q${n(w / 2)} ${n(h)} ${n(w)} ${n(h)}`;
        case 'rightBrace':
            return `M0 0 Q${n(w / 2)} 0 ${n(w / 2)} ${n(h * 0.1)} V${n(h * 0.4)} Q${n(w / 2)} ${n(h / 2)} ${n(w)} ${n(h / 2)}`
                + ` Q${n(w / 2)} ${n(h / 2)} ${n(w / 2)} ${n(h * 0.6)} V${n(h * 0.9)} Q${n(w / 2)} ${n(h)} 0 ${n(h)}`;
        case 'cloud':
        case 'cloudCallout':
            return ellipsePath(0, 0, w, h);
        default:
            return null;
    }
}

/**
 * Where a preset puts its text, as fractions of the box: [left, top, right,
 * bottom]. Office lays text out in each geometry's own text rectangle, not
 * the whole box — a diamond's is its middle half — and "anchored to the top"
 * means the top of that rectangle. Without it, a decision's label sits on the
 * diamond's upper point.
 */
export function textRect(geom) {
    switch (geom) {
        case 'diamond':
        case 'flowChartDecision':
        case 'flowChartSort':
            return [0.25, 0.25, 0.75, 0.75];
        case 'ellipse':
        case 'flowChartConnector':
        case 'flowChartOr':
        case 'flowChartSummingJunction':
        case 'wedgeEllipseCallout':
        case 'cloud':
        case 'cloudCallout':
            return [0.146, 0.146, 0.854, 0.854];
        case 'triangle':
        case 'flowChartExtract':
            return [0.25, 0.5, 0.75, 1];
        case 'flowChartMerge':
            return [0.25, 0, 0.75, 0.5];
        case 'hexagon':
        case 'flowChartPreparation':
        case 'parallelogram':
        case 'flowChartInputOutput':
        case 'trapezoid':
        case 'flowChartManualOperation':
            return [0.2, 0, 0.8, 1];
        case 'flowChartTerminator':
            return [0.1, 0.15, 0.9, 0.85];
        case 'roundRect':
        case 'flowChartAlternateProcess':
            return [0.05, 0.05, 0.95, 0.95];
        case 'flowChartDocument':
            return [0, 0, 1, 0.8];
        case 'flowChartMultidocument':
            return [0, 0.2, 0.85, 0.85];
        case 'flowChartPredefinedProcess':
            return [0.125, 0, 0.875, 1];
        case 'flowChartInternalStorage':
            return [0.125, 0.125, 1, 1];
        case 'can':
        case 'flowChartMagneticDisk':
            return [0, 0.2, 1, 0.9];
        case 'flowChartMagneticDrum':
            return [0.1, 0, 0.8, 1];
        case 'flowChartDelay':
            return [0, 0.15, 0.85, 0.85];
        case 'flowChartDisplay':
            return [0.17, 0, 0.83, 1];
        case 'flowChartOnlineStorage':
            return [0.17, 0, 0.83, 1];
        case 'flowChartManualInput':
            return [0, 0.2, 1, 1];
        case 'flowChartOffpageConnector':
            return [0, 0, 1, 0.8];
        case 'flowChartPunchedCard':
            return [0, 0.2, 1, 1];
        case 'flowChartPunchedTape':
            return [0, 0.2, 1, 0.8];
        case 'pentagon':
            return [0.19, 0.38, 0.81, 1];
        case 'homePlate':
        case 'chevron':
            return [0, 0, 0.8, 1];
        case 'octagon':
            return [0.15, 0.15, 0.85, 0.85];
        default:
            return [0, 0, 1, 1];
    }
}

/** Is this geometry a line rather than an outline? */
export function isLineShape(shape) {
    return !!(shape && (shape.connector || LINE_GEOMS.has(shape.geom)));
}

/**
 * A connector's route from its start (0, 0) to its end (w, h), before flips.
 * The elbow and curve positions follow the adjust values, which may fall
 * outside the box — that is how a connector loops round a shape.
 */
export function connectorPath(geom, w, h, adj = {}) {
    const a = (name, def) => (adj && Number.isFinite(adj[name]) ? adj[name] : def);
    switch (geom) {
        case 'bentConnector2':
            return `M0 0 L${n(w)} 0 L${n(w)} ${n(h)}`;
        case 'bentConnector3': {
            const x = w * a('adj1', 0.5);
            return `M0 0 L${n(x)} 0 L${n(x)} ${n(h)} L${n(w)} ${n(h)}`;
        }
        case 'bentConnector4': {
            const x = w * a('adj1', 0.5);
            const y = h * a('adj2', 0.5);
            return `M0 0 L${n(x)} 0 L${n(x)} ${n(y)} L${n(w)} ${n(y)} L${n(w)} ${n(h)}`;
        }
        case 'bentConnector5': {
            const x1 = w * a('adj1', 0.5);
            const y = h * a('adj2', 0.5);
            const x3 = w * a('adj3', 0.5);
            return `M0 0 L${n(x1)} 0 L${n(x1)} ${n(y)} L${n(x3)} ${n(y)} L${n(x3)} ${n(h)} L${n(w)} ${n(h)}`;
        }
        case 'curvedConnector2':
            return `M0 0 C${n(w / 2)} 0 ${n(w)} ${n(h / 2)} ${n(w)} ${n(h)}`;
        case 'curvedConnector3':
        case 'curvedConnector4':
        case 'curvedConnector5': {
            const x = w * a('adj1', 0.5);
            return `M0 0 C${n(x)} 0 ${n(x)} ${n(h)} ${n(w)} ${n(h)}`;
        }
        default:
            return `M0 0 L${n(w)} ${n(h)}`;
    }
}

/**
 * Scale a path given in fractions of the box (how a freeform outline arrives)
 * to w × h. Arcs scale their radii; the flags and rotation are left alone.
 */
export function scalePath(d, w, h) {
    const tokens = String(d).match(/[MLCQAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
    const out = [];
    let cmd = '';
    let argIndex = 0;
    for (const tok of tokens) {
        if (/^[MLCQAZ]$/i.test(tok)) {
            cmd = tok.toUpperCase();
            argIndex = 0;
            out.push(cmd);
            continue;
        }
        const v = Number(tok);
        let scaled = v;
        if (cmd === 'A') {
            // rx ry rotation large-arc sweep x y
            const k = argIndex % 7;
            if (k === 0 || k === 5) scaled = v * w;
            else if (k === 1 || k === 6) scaled = v * h;
        } else {
            scaled = argIndex % 2 === 0 ? v * w : v * h;
        }
        out.push(n(scaled));
        argIndex++;
    }
    return out.join(' ');
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Relative luminance of "#rrggbb", 0 (black) to 1 (white). */
function luminance(hex) {
    if (!HEX.test(hex)) return 1;
    const ch = (i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

/**
 * The colours a shape is drawn in, toned for the editor's theme.
 *
 * On a light theme, exactly the workbook's — the shape carries its own text
 * colour, and the two were chosen together. Two exceptions keep text from
 * vanishing: white text with nothing behind it, and (on a dark theme) dark
 * text or lines on the dark surface. On a dark theme a fill is sunk toward
 * the surface the way a shaded cell is, and its text takes the editor's
 * colour, because the workbook's dark text would be lost on it.
 */
export function shapeColors(shape, dark) {
    const fill = HEX.test(shape.fill || '') ? shape.fill : '';
    const line = HEX.test(shape.line || '') ? shape.line : '';
    const text = HEX.test(shape.text_color || '') ? shape.text_color : '';
    let fillCss = 'none';
    if (fill) {
        fillCss = dark
            ? `color-mix(in srgb, ${fill} ${luminance(fill) >= 0.18 ? 28 : 55}%, var(--bg-color))`
            : fill;
    }
    let lineCss = 'none';
    if (line) {
        lineCss = dark && luminance(line) < 0.18
            ? `color-mix(in srgb, ${line} 35%, var(--text-color))`
            : line;
    }
    let textCss = 'var(--text-color)';
    if (text) {
        const lum = luminance(text);
        if (dark) textCss = fill || lum < 0.18 ? 'var(--text-color)' : text;
        else textCss = !fill && lum > 0.8 ? 'var(--text-color)' : text;
    }
    return { fill: fillCss, line: lineCss, text: textCss };
}

/** stroke-dasharray for Office's preset dashes, in multiples of the width. */
function dashArray(dash, lw) {
    const k = Math.max(1, lw);
    const pattern = {
        dash: [4, 3], sysDash: [3, 1], lgDash: [8, 3],
        dot: [1, 3], sysDot: [1, 1], roundDot: [1, 2],
        dashDot: [4, 3, 1, 3], sysDashDot: [3, 1, 1, 1], lgDashDot: [8, 3, 1, 3],
        lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDashDotDot: [3, 1, 1, 1, 1, 1],
    }[dash];
    return pattern ? pattern.map((v) => n(v * k)).join(' ') : '';
}

function marker(id, type, color, size) {
    const s = n(size);
    const common = `id="${id}" viewBox="0 0 10 10" markerUnits="userSpaceOnUse" markerWidth="${s}" markerHeight="${s}" orient="auto-start-reverse"`;
    const style = `style="fill:${color};stroke:${color}"`;
    switch (type) {
        case 'arrow':
            return `<marker ${common} refX="9" refY="5"><path d="M0 0 L10 5 L0 10" style="fill:none;stroke:${color};stroke-width:1.5"/></marker>`;
        case 'stealth':
            return `<marker ${common} refX="10" refY="5"><path d="M0 0 L10 5 L0 10 L3 5 Z" ${style}/></marker>`;
        case 'diamond':
            return `<marker ${common} refX="5" refY="5"><path d="M0 5 L5 0 L10 5 L5 10 Z" ${style}/></marker>`;
        case 'oval':
            return `<marker ${common} refX="5" refY="5"><circle cx="5" cy="5" r="4.5" ${style}/></marker>`;
        default:
            return `<marker ${common} refX="10" refY="5"><path d="M0 0 L10 5 L0 10 Z" ${style}/></marker>`;
    }
}

/**
 * The SVG for one shape at w × h. Text is not in it: the caller lays text
 * out as HTML, which wraps, and which flips do not mirror.
 *
 * `uid` keeps marker ids apart — two previews can be open at once.
 */
export function shapeSvg(shape, w, h, uid, dark) {
    const colors = shapeColors(shape, dark);
    const lw = colors.line === 'none' ? 0 : Math.max(0.75, Number(shape.line_width) || 1);
    const dash = lw ? dashArray(shape.dash, lw) : '';
    const strokeStyle = lw
        ? `stroke:${colors.line};stroke-width:${n(lw)};${dash ? `stroke-dasharray:${dash};` : ''}stroke-linejoin:round`
        : 'stroke:none';

    const flip = shape.flip_h || shape.flip_v
        ? ` transform="translate(${shape.flip_h ? n(w) : 0} ${shape.flip_v ? n(h) : 0}) scale(${shape.flip_h ? -1 : 1} ${shape.flip_v ? -1 : 1})"`
        : '';

    let defs = '';
    let body;
    if (isLineShape(shape)) {
        const size = Math.max(6, lw * 3);
        let ends = '';
        if (lw && ARROWS.has(shape.head)) {
            defs += marker(`${uid}-h`, shape.head, colors.line, size);
            ends += ` marker-start="url(#${uid}-h)"`;
        }
        if (lw && ARROWS.has(shape.tail)) {
            defs += marker(`${uid}-t`, shape.tail, colors.line, size);
            ends += ` marker-end="url(#${uid}-t)"`;
        }
        const d = shape.geom === 'line' || shape.geom === 'straightConnector1' || !LINE_GEOMS.has(shape.geom)
            ? connectorPath('straightConnector1', w, h)
            : connectorPath(shape.geom, w, h, shape.adj);
        body = `<path d="${d}" style="fill:none;${strokeStyle}"${ends}/>`;
    } else {
        let d = shape.geom === 'custom' && shape.path ? scalePath(shape.path, w, h) : presetPath(shape.geom, w, h, shape.adj);
        if (!d) d = presetPath('rect', w, h);
        body = `<path d="${d}" style="fill:${colors.fill};${strokeStyle}" fill-rule="evenodd"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(Math.max(w, 1))}" height="${n(Math.max(h, 1))}"`
        + ` viewBox="0 0 ${n(Math.max(w, 1))} ${n(Math.max(h, 1))}" overflow="visible">`
        + `${defs ? `<defs>${defs}</defs>` : ''}<g${flip}>${body}</g></svg>`;
}
