import { describe, it, expect } from 'vitest';
import { parseColor, toHex, mix, buildThemeVariables, mermaidConfig, hasOwnTheme } from '../src/modules/utils/MermaidTheme.js';

/** WCAG の相対輝度とコントラスト比。 */
const lum = (hex) => {
    const c = parseColor(hex);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

describe('parseColor', () => {
    it('reads the forms the themes are written in', () => {
        expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
        expect(parseColor('#14181d')).toEqual({ r: 20, g: 24, b: 29, a: 1 });
        expect(parseColor('rgba(255, 255, 255, 0.10)')).toEqual({ r: 255, g: 255, b: 255, a: 0.1 });
        expect(parseColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    });

    it('returns null for what it cannot read', () => {
        expect(parseColor('color-mix(in srgb, red, blue)')).toBeNull();
        expect(parseColor('')).toBeNull();
    });
});

describe('mix / toHex', () => {
    it('blends between the two ends', () => {
        const black = parseColor('#000000');
        const white = parseColor('#ffffff');
        expect(toHex(mix(black, white, 0))).toBe('#000000');
        expect(toHex(mix(black, white, 1))).toBe('#ffffff');
        expect(toHex(mix(black, white, 0.5))).toBe('#808080');
    });
});

describe('buildThemeVariables', () => {
    // 実際のテーマの値。Paper は中間の明るさの地で、反転色では読めない例。
    const palettes = {
        dark: [{ bg: '#14181d', text: '#d7dde5', primary: '#6ea8fe', border: 'rgba(255, 255, 255, 0.10)' }, true],
        paper: [{ bg: '#f3e9d0', text: '#243049', primary: '#b23a48', border: '#cbb98d' }, false],
        light: [{ bg: '#ffffff', text: '#24292f', primary: '#0969da', border: '#d0d7de' }, false],
    };

    it.each(Object.keys(palettes))('keeps node text readable on %s', (name) => {
        const [p, dark] = palettes[name];
        const v = buildThemeVariables(p, dark);
        expect(contrast(v.primaryTextColor, v.primaryColor)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v.lineColor, v.background)).toBeGreaterThanOrEqual(3);
        expect(v.darkMode).toBe(dark);
    });

    it('hands mermaid plain hex, which its colour maths can read', () => {
        const v = buildThemeVariables(palettes.dark[0], true);
        for (const [k, val] of Object.entries(v)) {
            if (k === 'darkMode') continue;
            expect(val, k).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it('falls back to a light palette when a variable is unreadable', () => {
        const v = buildThemeVariables({ bg: '', text: 'nonsense', primary: '', border: '' }, false);
        expect(v.background).toBe('#ffffff');
        expect(contrast(v.primaryTextColor, v.primaryColor)).toBeGreaterThanOrEqual(4.5);
    });
});

describe('mermaidConfig', () => {
    it('asks for ELK only when it was registered', () => {
        expect(mermaidConfig({ elk: true }).layout).toBe('elk');
        expect(mermaidConfig({ elk: false }).layout).toBe('dagre');
    });

    it('stays in strict mode', () => {
        expect(mermaidConfig().securityLevel).toBe('strict');
    });
});

describe('hasOwnTheme', () => {
    it('sees a theme named in an init directive', () => {
        expect(hasOwnTheme('%%{init: {"theme":"forest"}}%%\nflowchart LR\n A-->B')).toBe(true);
        expect(hasOwnTheme("%%{init: {'theme': 'dark'}}%%\ngraph TD\n A-->B")).toBe(true);
    });

    it('sees a theme in front matter', () => {
        expect(hasOwnTheme('---\nconfig:\n  theme: neutral\n---\nflowchart LR\n A-->B')).toBe(true);
    });

    it('leaves plain diagrams and other directives to the app palette', () => {
        expect(hasOwnTheme('flowchart LR\n A-->B')).toBe(false);
        expect(hasOwnTheme('%%{init: {"flowchart":{"curve":"basis"}}}%%\nflowchart LR\n A-->B')).toBe(false);
        expect(hasOwnTheme('---\ntitle: themes\n---\nflowchart LR\n A-->B')).toBe(false);
    });
});

describe('mermaidConfig themed=false', () => {
    it('passes a named theme and no palette, so the diagram\'s own choice wins', () => {
        const cfg = mermaidConfig({ themed: false });
        expect(cfg.theme).toBe('default');
        expect(cfg.themeVariables).toBeUndefined();
        expect(cfg.securityLevel).toBe('strict');
    });
});
