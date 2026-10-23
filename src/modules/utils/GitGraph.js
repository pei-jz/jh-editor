/**
 * GitGraph.js — the commit graph beside the Git panel's history.
 *
 * The graph used to be one thin, faint line per lane plus a dot, all in the
 * primary colour, with no line at all where a branch forked off or merged
 * back. Which commit belonged to which branch had to be guessed.
 *
 * Here every lane keeps a colour of its own, every row says which lines cross
 * it, and the forks and merges are drawn as curves into the lane they join.
 * The layout is pure (entries in, rows out) so it can be tested without a
 * repository; `graphRowSvg` turns one row into the markup drawn beside it.
 */

/** How many lane colours the stylesheet defines (`--git-lane-0` …). */
export const LANE_COLORS = 8;

export const LANE_WIDTH = 12;
export const ROW_HEIGHT = 26;
/** Lanes beyond this are still laid out, but the column stops growing. */
export const MAX_DRAWN_LANES = 12;

/**
 * Lay the graph out.
 *
 * Each row describes the two halves of its own height:
 *   top    lines from the row above into this one (`from` lane at the top
 *          edge, `to` lane at the middle) — a lane converging on this commit
 *          bends into it, every other lane passes straight down
 *   bottom lines from the middle down to the next row — the commit's own lane
 *          towards its first parent, a curve out to each further parent of a
 *          merge, and the lanes passing by
 *
 * @param {Array<{hash: string, parents?: string[]}>} entries  newest first
 * @returns {{rows: Array<{lane: number, color: number, merge: boolean,
 *           top: Array<{from: number, to: number, color: number}>,
 *           bottom: Array<{from: number, to: number, color: number}>}>,
 *           width: number}}
 */
export function layoutGraph(entries) {
    const lanes = [];   // { hash, color } — the commit each lane is waiting for
    let nextColor = 0;
    const alloc = (hash) => {
        let i = lanes.findIndex((l) => l === null);
        if (i === -1) i = lanes.length;
        lanes[i] = { hash, color: nextColor++ % LANE_COLORS };
        return i;
    };

    const rows = [];
    let width = 0;

    for (const entry of entries || []) {
        const parents = (entry && entry.parents) || [];
        const incoming = [];
        lanes.forEach((l, k) => { if (l && l.hash === entry.hash) incoming.push(k); });
        const lane = incoming.length ? incoming[0] : alloc(entry.hash);
        const color = lanes[lane].color;

        // Top half. A lane that was just opened for this commit (a branch tip)
        // has nothing above it.
        const top = [];
        const passing = new Set();
        lanes.forEach((l, k) => {
            if (!l) return;
            if (l.hash === entry.hash) {
                if (incoming.includes(k)) top.push({ from: k, to: lane, color: l.color });
            } else {
                top.push({ from: k, to: k, color: l.color });
                passing.add(k);
            }
        });

        // Every other lane that was waiting for this commit ends here.
        for (const k of incoming.slice(1)) lanes[k] = null;
        lanes[lane] = parents.length ? { hash: parents[0], color } : null;

        const bottom = [];
        const opened = new Set();
        for (const p of parents.slice(1)) {
            let k = lanes.findIndex((l) => l && l.hash === p);
            if (k === -1) {
                k = alloc(p);
                opened.add(k);
            }
            bottom.push({ from: lane, to: k, color: lanes[k].color });
        }
        lanes.forEach((l, k) => {
            if (!l) return;
            if (k === lane) bottom.push({ from: k, to: k, color: l.color });
            // A lane opened for a merge parent starts with the curve above.
            else if (passing.has(k) && !opened.has(k)) bottom.push({ from: k, to: k, color: l.color });
        });

        while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

        const reach = Math.max(lane, ...top.map((s) => Math.max(s.from, s.to)),
            ...bottom.map((s) => Math.max(s.from, s.to)));
        width = Math.max(width, reach + 1);
        rows.push({ lane, color, merge: parents.length > 1, top, bottom });
    }

    return { rows, width };
}

/** Horizontal centre of a lane, in pixels. */
export function laneX(lane) {
    return 6 + lane * LANE_WIDTH;
}

/** Pixel width of the graph column for `lanes` lanes. */
export function graphWidth(lanes) {
    return laneX(Math.max(1, Math.min(lanes, MAX_DRAWN_LANES)) - 1) + 8;
}

function segmentPath(x1, y1, x2, y2) {
    if (x1 === x2) return `M${x1} ${y1}V${y2}`;
    const mid = (y1 + y2) / 2;
    return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

/**
 * The SVG for one row of the graph.
 *
 * @param {object} row       one of `layoutGraph(...).rows`
 * @param {number} width     the column width, the same for every row
 * @param {object} [opts]
 * @param {boolean} [opts.head]  the checked-out commit: drawn larger
 */
export function graphRowSvg(row, width, { head = false } = {}) {
    const h = ROW_HEIGHT;
    const mid = h / 2;
    const paths = [];
    const line = (seg, y1, y2) => {
        paths.push(`<path d="${segmentPath(laneX(seg.from), y1, laneX(seg.to), y2)}" `
            + `stroke="var(--git-lane-${seg.color})"/>`);
    };
    // Lines first, so the dot sits on top of them.
    for (const seg of row.top) line(seg, 0, mid);
    for (const seg of row.bottom) line(seg, mid, h);

    const cx = laneX(row.lane);
    const colour = `var(--git-lane-${row.color})`;
    const r = head ? 5 : 4;
    // A merge is a ring, an ordinary commit a filled dot.
    const dot = row.merge
        ? `<circle cx="${cx}" cy="${mid}" r="${r}" fill="var(--sidebar-bg, var(--bg-color))" stroke="${colour}" stroke-width="2.5"/>`
        : `<circle cx="${cx}" cy="${mid}" r="${r}" fill="${colour}" stroke="var(--sidebar-bg, var(--bg-color))" stroke-width="1.5"/>`;
    const halo = head ? `<circle cx="${cx}" cy="${mid}" r="${r + 3}" fill="none" stroke="${colour}" stroke-width="1.5" opacity="0.45"/>` : '';

    return `<svg class="git-graph-svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" aria-hidden="true">`
        + `<g fill="none" stroke-width="2" stroke-linecap="round">${paths.join('')}</g>${halo}${dot}</svg>`;
}
