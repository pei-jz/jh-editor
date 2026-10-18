import { describe, it, expect } from 'vitest';
import { fitDiagram, heightCapScale, documentMaxHeight, READABLE_SCALE } from '../src/modules/utils/DiagramFit.js';

const svgOf = (w, h, attrs = {}) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    return svg;
};

describe('fitting a diagram to the screen', () => {
    it('never enlarges a small diagram past its own size', () => {
        // Types without mermaid's own max-width used to fill the whole column.
        const svg = svgOf(200, 100, { width: '100%', height: '100%' });
        fitDiagram(svg, 800);
        expect(svg.style.width).toBe('100%');
        expect(svg.style.maxWidth).toBe('200px');
        expect(svg.getAttribute('height')).toBeNull();
    });

    it('shrinks a tall diagram toward the available height', () => {
        const svg = svgOf(600, 1000);
        fitDiagram(svg, 800);
        expect(svg.style.maxWidth).toBe('480px'); // 0.8 of natural
    });

    it('stops shrinking at a readable scale; the rest scrolls', () => {
        const svg = svgOf(600, 4000);
        fitDiagram(svg, 800);
        expect(svg.style.maxWidth).toBe(`${600 * READABLE_SCALE}px`);
    });

    it('ignores height when there is no screen to fit (print)', () => {
        expect(heightCapScale({ w: 600, h: 4000 }, Infinity)).toBe(1);
    });

    it('reports a diagram it cannot size', () => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        expect(fitDiagram(svg, 800)).toBe(false);
    });

    it('uses most of the window for document diagrams, with a floor', () => {
        expect(documentMaxHeight({ innerHeight: 1000 })).toBe(700);
        expect(documentMaxHeight({ innerHeight: 300 })).toBe(360);
    });
});
