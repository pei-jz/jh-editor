import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The 簡牘古文 (bamboo-ancient) palette ported from jh-ai-agent. These pin what
// is SPECIFIC to bamboo: the agreed hex values and the slip texture. The rules
// it shares with the other palette themes — contrast, registration, dark-theme
// detection — live in ThemePalettes.test.js.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const themes = read('src/styles/themes.css');

/** The custom-property block of `body.theme-<name>`. */
function themeBlock(name) {
    const start = themes.indexOf(`body.theme-${name} {`);
    expect(start).toBeGreaterThan(-1);
    const open = themes.indexOf('{', start);
    const close = themes.indexOf('}', open);
    return themes.slice(open + 1, close);
}

describe('bamboo-ancient theme — ported 簡牘古文 palette', () => {
    const block = themeBlock('bamboo-ancient');

    it('defines every token JHEditor themes are expected to carry', () => {
        const tokens = ['--bg-color', '--sidebar-bg', '--header-bg', '--border-color',
            '--text-color', '--primary-color', '--active-tab-bg', '--active-tab-border',
            '--hover-color', '--bg-color-secondary', '--bg-active', '--table-header-bg',
            '--hl-keyword', '--hl-control-flow', '--hl-built-in', '--hl-literal',
            '--hl-string', '--hl-comment', '--hl-function', '--hl-variable',
            '--hl-number', '--hl-operator',
            '--gutter-color', '--tab-inactive-color', '--tree-item-color',
            '--tree-item-active-bg', '--text-secondary',
            '--code-color', '--code-bg', '--code-border', '--blockquote-bg',
            '--selection-bg', '--selection-color', '--cm-selection-bg',
            '--git-modified-color', '--git-staged-color', '--git-untracked-color',
            '--shadow-sm', '--shadow-md', '--shadow-lg', '--grain', '--slip'];
        for (const t of tokens) expect(block).toContain(`${t}:`);
    });

    it('keeps the charred bamboo slip surfaces', () => {
        expect(block).toContain('--bg-color: #3a2e1e;');
        expect(block).toContain('--sidebar-bg: #2f2518;');
        expect(block).toContain('--bg-color-secondary: #463a26;');
    });

    it('writes in faint ivory ink', () => {
        expect(block).toContain('--text-color: #e8e0cc;');
        expect(block).toContain('--text-secondary: #a89d84;');
    });

    it('uses bronze-verdigris (銅青) as the accent', () => {
        expect(block).toContain('--primary-color: #7fc4b8;');
        expect(block).toContain('--active-tab-border: #7fc4b8;');
    });

    it('uses old darkened bamboo for the borders', () => {
        expect(block).toContain('--border-color: #6b5a3c;');
    });

    // A hanging scroll: bamboo at the rods, paper in between. The slats used
    // to run behind the whole app and through the file list, where a 4px
    // near-black line every 46px cut across the names.
    it('keeps the bamboo on the two bars', () => {
        expect(block).toContain("--grain: url(\"data:image/svg+xml,");
        expect(block).toContain('--slip: linear-gradient(180deg,');

        // The desk and the file list are paper now.
        expect(themes).toContain('background: var(--grain), var(--sidebar-bg);');

        const idx = themes.indexOf('body.theme-bamboo-ancient #explorer {');
        expect(idx).toBeGreaterThan(-1);
        const explorer = themes.slice(idx, themes.indexOf('}', idx));
        expect(explorer).toContain('var(--grain)');
        expect(explorer, 'the slats are what made the file names hard to read')
            .not.toContain('--slip');

        // The rods carry it instead, with a texture of their own: --slip draws
        // binding cords at 17% and 82% of the height, which on a 30px bar
        // turns the whole strip into stripes.
        expect(block).toContain('--slip-bar:');
        const bars = themes.indexOf('body.theme-bamboo-ancient #custom-titlebar,');
        expect(bars).toBeGreaterThan(-1);
        expect(themes.slice(bars, themes.indexOf('}', bars)))
            .toContain('var(--slip-bar)');
    });

    // The slats are 4px of near-black every 46px. Behind prose they would cut
    // straight through the text, so reading surfaces take the fibre grain only.
    it('keeps the slat lines off the reading surfaces', () => {
        const idx = themes.indexOf('body.theme-bamboo-ancient .md-body,');
        expect(idx).toBeGreaterThan(-1);
        const rule = themes.slice(idx, themes.indexOf('}', idx));
        expect(rule).toContain('background-image: var(--grain);');
        expect(rule).not.toContain('--slip');
    });

    it('leaves the other themes untouched', () => {
        expect(themeBlock('paper')).toContain('--bg-color: #f3e9d0;');
        expect(themeBlock('dark')).toContain('--bg-color: #1e1e1e;');
    });
});
