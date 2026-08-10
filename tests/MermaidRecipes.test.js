import { describe, it, expect } from 'vitest';
import {
    MERMAID_RECIPES, getRecipe, searchRecipes, detectDiagramType, toMarkdownBlock,
} from '../src/modules/utils/MermaidRecipes.js';

describe('MermaidRecipes — catalogue', () => {
    it('covers the diagram types people actually reach for', () => {
        const ids = MERMAID_RECIPES.map(r => r.id);
        expect(ids).toEqual(expect.arrayContaining([
            'flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'pie',
        ]));
    });

    it('gives every recipe a title, subtitle, template and snippets', () => {
        for (const r of MERMAID_RECIPES) {
            expect(r.title, r.id).toBeTruthy();
            expect(r.subtitle, r.id).toBeTruthy();
            expect(r.template.trim().length, r.id).toBeGreaterThan(0);
            expect(r.snippets.length, r.id).toBeGreaterThan(0);
            for (const s of r.snippets) {
                expect(s.label, `${r.id}/${s.code}`).toBeTruthy();
                expect(s.code, `${r.id}/${s.label}`).toBeTruthy();
            }
        }
    });

    it('uses unique ids', () => {
        const ids = MERMAID_RECIPES.map(r => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('ships templates that are more than a bare header', () => {
        for (const r of MERMAID_RECIPES) {
            expect(r.template.split('\n').filter(Boolean).length, r.id).toBeGreaterThan(2);
        }
    });

    // The whole point of the helper: a template must be recognisable as its own
    // diagram type, otherwise the cheat sheet would switch away after insertion.
    it('every template is detected as its own type', () => {
        for (const r of MERMAID_RECIPES) {
            expect(detectDiagramType(r.template), r.id).toBe(r.id);
        }
    });
});

describe('MermaidRecipes — getRecipe', () => {
    it('finds a known id', () => {
        expect(getRecipe('sequence').title).toBe('Sequence Diagram');
    });

    it('returns null for an unknown id', () => {
        expect(getRecipe('nope')).toBeNull();
        expect(getRecipe(undefined)).toBeNull();
    });
});

describe('MermaidRecipes — searchRecipes', () => {
    it('returns everything for an empty query', () => {
        expect(searchRecipes('')).toHaveLength(MERMAID_RECIPES.length);
        expect(searchRecipes('   ')).toHaveLength(MERMAID_RECIPES.length);
        expect(searchRecipes(null)).toHaveLength(MERMAID_RECIPES.length);
    });

    it('matches on the id', () => {
        expect(searchRecipes('gantt').map(r => r.id)).toEqual(['gantt']);
    });

    it('matches on the title', () => {
        expect(searchRecipes('Sequence').map(r => r.id)).toEqual(['sequence']);
        expect(searchRecipes('sequence diagram').map(r => r.id)).toEqual(['sequence']);
    });

    it('matches on keywords', () => {
        expect(searchRecipes('table').map(r => r.id)).toEqual(['er']);
        expect(searchRecipes('branch').map(r => r.id)).toContain('flowchart');
    });

    it('is case-insensitive', () => {
        expect(searchRecipes('SEQUENCE').map(r => r.id)).toEqual(['sequence']);
    });

    it('returns nothing for an unmatched query', () => {
        expect(searchRecipes('zzzz')).toEqual([]);
    });
});

describe('MermaidRecipes — detectDiagramType', () => {
    it.each([
        ['flowchart TD\n A-->B', 'flowchart'],
        ['graph LR\n A-->B', 'flowchart'],
        ['sequenceDiagram\n A->>B: x', 'sequence'],
        ['classDiagram\n class A', 'class'],
        ['stateDiagram-v2\n [*] --> A', 'state'],
        ['erDiagram\n A ||--o{ B : x', 'er'],
        ['gantt\n title x', 'gantt'],
        ['pie showData', 'pie'],
        ['mindmap\n root((x))', 'mindmap'],
        ['journey\n title x', 'journey'],
    ])('detects %s', (code, expected) => {
        expect(detectDiagramType(code)).toBe(expected);
    });

    it('is case-insensitive', () => {
        expect(detectDiagramType('SEQUENCEDIAGRAM')).toBe('sequence');
    });

    it('skips leading blank lines and comments', () => {
        expect(detectDiagramType('\n\n%% my diagram\nflowchart TD\n A-->B')).toBe('flowchart');
    });

    it('returns null for empty or unrecognised source', () => {
        expect(detectDiagramType('')).toBeNull();
        expect(detectDiagramType('   \n  ')).toBeNull();
        expect(detectDiagramType(null)).toBeNull();
        expect(detectDiagramType('not a diagram')).toBeNull();
        expect(detectDiagramType('%% only a comment')).toBeNull();
    });
});

describe('MermaidRecipes — toMarkdownBlock', () => {
    it('wraps source in a mermaid fence', () => {
        expect(toMarkdownBlock('graph TD;\nA-->B;'))
            .toBe('```mermaid\ngraph TD;\nA-->B;\n```');
    });

    it('trims trailing whitespace so the fence is not pushed down', () => {
        expect(toMarkdownBlock('graph TD;\n\n  ')).toBe('```mermaid\ngraph TD;\n```');
    });

    it('handles empty input', () => {
        expect(toMarkdownBlock('')).toBe('```mermaid\n\n```');
        expect(toMarkdownBlock(null)).toBe('```mermaid\n\n```');
    });
});
