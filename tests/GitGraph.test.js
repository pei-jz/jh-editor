import { describe, it, expect } from 'vitest';
import { layoutGraph, graphRowSvg, graphWidth, LANE_COLORS } from '../src/modules/utils/GitGraph.js';

/*
   The history graph was one faint line per lane and a dot, in one colour, with
   nothing drawn where a branch forked off or merged back. These pin down the
   layout that replaced it: lanes keep their colour, merges and forks are drawn
   as lines into the lane they join, and nothing dangles.
*/

const c = (hash, ...parents) => ({ hash, parents });

describe('layoutGraph', () => {
    it('keeps a straight history in one lane, joined row to row', () => {
        const { rows, width } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
        expect(width).toBe(1);
        expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
        // The tip has nothing above it, the root nothing below.
        expect(rows[0].top).toEqual([]);
        expect(rows[0].bottom).toEqual([{ from: 0, to: 0, color: rows[0].color }]);
        expect(rows[1].top).toEqual([{ from: 0, to: 0, color: rows[0].color }]);
        expect(rows[2].bottom).toEqual([]);
        // One branch, one colour all the way down.
        expect(new Set(rows.map((r) => r.color)).size).toBe(1);
    });

    it('draws a merge as a curve out to the merged branch, in that branch\'s colour', () => {
        //  m       merge of a2 into b1
        //  |\
        //  b1 a2
        //  |  a1
        //  base
        const { rows } = layoutGraph([
            c('m', 'b1', 'a2'),
            c('a2', 'a1'),
            c('b1', 'base'),
            c('a1', 'base'),
            c('base'),
        ]);
        const merge = rows[0];
        expect(merge.merge).toBe(true);
        const curve = merge.bottom.find((s) => s.from !== s.to);
        expect(curve).toMatchObject({ from: 0, to: 1 });
        // The merged branch has a colour of its own, and its commits wear it.
        expect(curve.color).not.toBe(merge.color);
        expect(rows[1]).toMatchObject({ lane: 1, color: curve.color });
    });

    it('brings two lanes waiting for the same parent together at it', () => {
        const { rows } = layoutGraph([
            c('m', 'b1', 'a1'),
            c('a1', 'base'),
            c('b1', 'base'),
            c('base'),
        ]);
        const base = rows[3];
        expect(base.lane).toBe(0);
        // One straight line from its own lane, one bend in from the other.
        expect(base.top).toEqual(expect.arrayContaining([
            expect.objectContaining({ from: 0, to: 0 }),
            expect.objectContaining({ from: 1, to: 0 }),
        ]));
        expect(base.bottom).toEqual([]);
    });

    it('opens a new lane for a branch tip and gives it nothing above', () => {
        // Two branches, both shown (git log --all): the second tip appears
        // further down with no child in the list.
        const { rows } = layoutGraph([
            c('x2', 'x1'),
            c('y1', 'base'),
            c('x1', 'base'),
            c('base'),
        ]);
        expect(rows[1].lane).toBe(1);
        expect(rows[1].top.some((s) => s.to === 1)).toBe(false);
        // Lane 0 passes straight by.
        expect(rows[1].top).toContainEqual(expect.objectContaining({ from: 0, to: 0 }));
    });

    it('reuses freed lanes rather than drifting right forever', () => {
        const entries = [];
        // Ten short side branches merged one after the other.
        for (let i = 9; i >= 0; i--) {
            entries.push(c(`m${i}`, i ? `m${i - 1}` : 'root', `s${i}`));
            entries.push(c(`s${i}`, i ? `m${i - 1}` : 'root'));
        }
        entries.push(c('root'));
        const { width } = layoutGraph(entries);
        expect(width).toBeLessThanOrEqual(3);
    });

    it('cycles through the palette', () => {
        const entries = [];
        for (let i = 0; i < LANE_COLORS + 2; i++) entries.push(c(`t${i}`));
        const { rows } = layoutGraph(entries);
        expect(Math.max(...rows.map((r) => r.color))).toBe(LANE_COLORS - 1);
    });

    it('survives an empty log and entries without parents', () => {
        expect(layoutGraph([])).toEqual({ rows: [], width: 0 });
        expect(layoutGraph([{ hash: 'a' }]).rows[0].lane).toBe(0);
    });
});

describe('graphRowSvg', () => {
    it('draws lines in the lane colours, with the dot on top', () => {
        const { rows, width } = layoutGraph([c('m', 'b', 'a'), c('a', 'b'), c('b')]);
        const svg = graphRowSvg(rows[0], graphWidth(width));
        expect(svg).toContain('stroke="var(--git-lane-0)"');
        expect(svg).toContain('stroke="var(--git-lane-1)"');
        // A curve, not only straight segments.
        expect(svg).toMatch(/d="M\d+ \d+C/);
        expect(svg.lastIndexOf('<circle')).toBeGreaterThan(svg.lastIndexOf('<path'));
    });

    it('draws a merge hollow and the checked-out commit larger', () => {
        const { rows } = layoutGraph([c('m', 'b', 'a'), c('a'), c('b')]);
        expect(graphRowSvg(rows[0], 30)).toMatch(/fill="var\(--sidebar-bg/);
        expect(graphRowSvg(rows[1], 30, { head: true })).toContain('r="5"');
    });

    it('keeps the column width bounded', () => {
        expect(graphWidth(1)).toBeLessThan(graphWidth(3));
        expect(graphWidth(500)).toBe(graphWidth(12));
    });
});
