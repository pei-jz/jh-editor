import { describe, it, expect } from 'vitest';

import {
    presetPath, connectorPath, scalePath, shapeSvg, shapeColors, isLineShape,
} from '../src/modules/views/OfficeShapes.js';

/* A flowchart in a 設計書 is DrawingML, not cells. Rust reads it into preset
   names and resolved colours; these functions turn that into SVG. The tests
   pin the shapes a flowchart is built from, and the rules that keep its text
   readable whichever theme the editor is in. */

describe('drawing Office shapes', () => {
    it('draws the flowchart presets as their own outlines', () => {
        expect(presetPath('flowChartDecision', 100, 50)).toBe('M50 0 L100 25 L50 50 L0 25 Z');
        expect(presetPath('flowChartProcess', 10, 10)).toBe('M0 0 L10 0 L10 10 L0 10 Z');
        // The terminator is a stadium: fully round ends.
        expect(presetPath('flowChartTerminator', 100, 40)).toContain('A20 20');
        // A data box leans; a manual operation narrows.
        expect(presetPath('flowChartInputOutput', 100, 50)).toBe('M20 0 L100 0 L80 50 L0 50 Z');
        // Adjust values move what they move.
        expect(presetPath('roundRect', 100, 50, { adj: 0.5 })).toContain('A25 25');
        for (const geom of ['flowChartDocument', 'flowChartMagneticDisk', 'flowChartPredefinedProcess',
            'flowChartPreparation', 'flowChartDelay', 'rightArrow', 'wedgeRectCallout', 'ellipse']) {
            expect(presetPath(geom, 100, 50), geom).toMatch(/^M/);
        }
    });

    it('leaves a preset it does not know to the caller, who draws a box', () => {
        expect(presetPath('star24', 10, 10)).toBe(null);
        const svg = shapeSvg({ geom: 'star24', fill: '#ff0000', line: '', adj: {} }, 10, 10, 'u', false);
        expect(svg).toContain('d="M0 0 L10 0 L10 10 L0 10 Z"');
    });

    it('routes a connector by its adjust values, even outside its box', () => {
        expect(connectorPath('straightConnector1', 30, 40)).toBe('M0 0 L30 40');
        expect(connectorPath('bentConnector3', 100, 40)).toBe('M0 0 L50 0 L50 40 L100 40');
        // A negative adjustment is a connector looping out to the left.
        expect(connectorPath('bentConnector3', 100, 40, { adj1: -0.2 })).toBe('M0 0 L-20 0 L-20 40 L100 40');
        expect(isLineShape({ geom: 'line' })).toBe(true);
        expect(isLineShape({ geom: 'rect', connector: false })).toBe(false);
    });

    it('scales a freeform outline from fractions, radii included', () => {
        expect(scalePath('M0 0 L1 0.5 Z', 200, 100)).toBe('M 0 0 L 200 50 Z');
        expect(scalePath('A0.5 0.5 0 1 1 1 0.5', 200, 100)).toBe('A 100 50 0 1 1 200 50');
    });

    it('puts arrowheads on the ends that have them, in the line colour', () => {
        const svg = shapeSvg({
            geom: 'straightConnector1', connector: true, line: '#ff0000', line_width: 2,
            head: '', tail: 'triangle', dash: 'dash', flip_v: true, adj: {},
        }, 0, 60, 'cx1', false);
        expect(svg).toContain('marker-end="url(#cx1-t)"');
        expect(svg).not.toContain('marker-start');
        expect(svg).toContain('stroke:#ff0000');
        expect(svg).toContain('stroke-dasharray:8 6');
        // A flip mirrors the route, so the arrow points the way it did in Excel.
        expect(svg).toContain('scale(1 -1)');
    });

    it('keeps the text readable whichever theme the editor is in', () => {
        const blue = { fill: '#4472c4', line: '#2f528f', text_color: '#ffffff' };
        // Light: the workbook's own colours, chosen together.
        expect(shapeColors(blue, false)).toEqual({ fill: '#4472c4', line: '#2f528f', text: '#ffffff' });
        // Dark: the fill sinks toward the surface and the text takes the
        // editor's colour; a dark line is lifted toward the text colour.
        const dark = shapeColors(blue, true);
        expect(dark.fill).toContain('color-mix');
        expect(dark.text).toBe('var(--text-color)');
        expect(dark.line).toContain('color-mix');
        // White text with nothing behind it would vanish on a light page.
        expect(shapeColors({ fill: '', line: '', text_color: '#ffffff' }, false).text).toBe('var(--text-color)');
    });

    it('never lets a colour that is not a colour into the markup', () => {
        const svg = shapeSvg({ geom: 'rect', fill: 'red;"><script>', line: '', adj: {} }, 10, 10, 'x', false);
        expect(svg).not.toContain('script');
        expect(svg).toContain('fill:none');
    });
});
