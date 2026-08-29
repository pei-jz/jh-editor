import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { THEMES, themeClasses, darkThemeClasses, DEFAULT_THEME, isKnownTheme } from '../src/modules/utils/Themes.js';

// Themes that carry their own syntax palette (CodeMirrorView.PALETTE_THEMES).
// Two things have gone wrong with these before: a dark theme was handed the
// LIGHT highlight style (1.4:1 keywords), and palettes shipped with comment and
// gutter tones around 2.4-2.7:1. Both are contrast failures, so the rule is
// enforced here rather than re-pinned per hex value.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const themes = read('src/styles/themes.css');

/** WCAG relative-luminance contrast ratio between two #rrggbb colours. */
function contrast(a, b) {
    const lum = (hex) => {
        const v = [1, 3, 5].map((i) => {
            const c = parseInt(hex.substr(i, 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** The custom-property block of `body.theme-<name>`. */
function themeBlock(name) {
    const start = themes.indexOf(`body.theme-${name} {`);
    expect(start, name).toBeGreaterThan(-1);
    const open = themes.indexOf('{', start);
    return themes.slice(open + 1, themes.indexOf('}', open));
}

const token = (block, name) => {
    const m = block.match(new RegExp(name + ':\\s*(#[0-9a-f]{6})', 'i'));
    expect(m, name).toBeTruthy();
    return m[1];
};

// Foregrounds a reader actually has to make out.
const FOREGROUNDS = [
    '--text-color', '--text-secondary', '--gutter-color', '--tab-inactive-color',
    '--hl-keyword', '--hl-control-flow', '--hl-built-in', '--hl-literal',
    '--hl-string', '--hl-comment', '--hl-function', '--hl-variable',
    '--hl-number', '--hl-operator',
];

const PALETTE_THEMES = ['bamboo-ancient', 'sumi-e', 'nord', 'kakejiku'];

// Which surface a foreground actually sits on. Hanging Scroll is a hybrid — a
// light sheet inside dark indigo mounting — so its tab ink is pale ON PURPOSE
// and must be judged against the mount, not the sheet.
const SURFACE = {
    kakejiku: { '--tab-inactive-color': '--mount-bg-2' },
};

describe.each(PALETTE_THEMES)('theme %s', (name) => {
    const block = themeBlock(name);
    const bg = token(block, '--bg-color');

    it('defines every token the editor reads', () => {
        for (const t of [...FOREGROUNDS, '--bg-color', '--sidebar-bg', '--header-bg',
            '--border-color', '--primary-color', '--bg-color-secondary', '--bg-active',
            '--hover-color', '--active-tab-bg', '--active-tab-border', '--table-header-bg',
            '--tree-item-color', '--tree-item-active-bg', '--code-color', '--code-bg',
            '--code-border', '--blockquote-bg', '--selection-bg', '--selection-color',
            '--cm-selection-bg', '--git-modified-color', '--git-staged-color',
            '--git-untracked-color', '--shadow-sm', '--shadow-md', '--shadow-lg']) {
            expect(block, t).toContain(`${t}:`);
        }
    });

    it('keeps every foreground readable on its own background', () => {
        for (const t of FOREGROUNDS) {
            const on = (SURFACE[name] || {})[t];
            const surface = on ? token(block, on) : bg;
            expect(contrast(token(block, t), surface),
                `${name} ${t} on ${on || '--bg-color'}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    // The picker and the class-removal list are DERIVED from utils/Themes.js
    // now, so what matters is that the theme is in that registry — being in
    // the CSS but not the registry is the failure these used to catch, and it
    // is checked once, for every theme, in the block at the foot of this file.
    it('is declared in the theme registry', () => {
        expect(THEMES.map((t) => t.id)).toContain(name);
    });

    it('paints a pre-hydration background so there is no light flash', () => {
        expect(read('index.html')).toContain(`theme === '${name}'`);
    });

    it('has a scrollbar thumb of its own', () => {
        expect(read('src/styles/base.css')).toContain(`body.theme-${name} {`);
    });

    // Without this the theme falls back to oneDark (which repaints the
    // background) or to CM's light default (unreadable on a dark theme).
    it('drives the editor from its own palette', () => {
        expect(read('src/modules/views/CodeMirrorView.js'))
            .toMatch(new RegExp(`PALETTE_THEMES = \\[[^\\]]*'theme-${name}'`));
    });
});

// The markdown table header used to read `var(--header-text, #2d3436)`, with
// --header-text defined only for an allowlist of themes. Every theme added after
// that allowlist fell through to the hardcoded near-black: 1.14:1 on bamboo's
// header, i.e. invisible. Any theme-specific styling that needs a per-theme
// allowlist will break the same way the next time a theme is added.
describe('markdown table header', () => {
    const editor = read('src/styles/editor.css');
    const rule = () => {
        const i = editor.indexOf('.md-block table:not(.visual-table-editor) th {');
        expect(i).toBeGreaterThan(-1);
        return editor.slice(i, editor.indexOf('}', i));
    };

    it('takes its colours from the theme tokens, not an allowlist', () => {
        expect(rule()).toContain('color: var(--text-color);');
        expect(rule()).toContain('background-color: var(--table-header-bg);');
    });

    it('no longer defines a per-theme header colour anywhere', () => {
        expect(editor).not.toMatch(/--header-text\s*:/);
    });

    it('reads on every palette theme', () => {
        for (const name of PALETTE_THEMES) {
            const block = themeBlock(name);
            expect(
                contrast(token(block, '--text-color'), token(block, '--table-header-bg')),
                name,
            ).toBeGreaterThanOrEqual(4.5);
        }
    });
});

// Paper (Subtle) was removed for being the same sheet as Ink Brush (6 RGB units
// apart). Anyone still carrying it in localStorage has to be moved across, or
// they boot into an unstyled default with a theme name that no longer exists.
describe('removed themes', () => {
    it('leaves no styling or class handling behind', () => {
        for (const f of ['src/styles/themes.css', 'src/styles/base.css',
            'src/modules/ui/SettingsModal.js', 'src/modules/ui/TerminalManager.js']) {
            expect(read(f), f).not.toContain('paper-subtle');
        }
    });

    // index.html and Layout.js still NAME it — that is the migration below, not
    // a leftover. What must be gone is the option and the theme class.
    it('is no longer offered in the selector', () => {
        const html = read('index.html');
        expect(html).not.toContain('<option value="paper-subtle"');
        expect(html).not.toContain('theme-paper-subtle');
    });

    it('migrates a saved paper-subtle to Ink Brush on both startup paths', () => {
        for (const f of ['index.html', 'src/modules/core/Layout.js']) {
            const src = read(f);
            expect(src, f).toContain("theme === 'paper-subtle'");
            expect(src, f).toContain("theme = 'sumi-e'");
        }
    });

    it('leaves the bold Paper theme in place', () => {
        expect(themeBlock('paper')).toContain('--bg-color: #f3e9d0;');
        expect(THEMES.map((t) => t.id)).toContain('paper');
    });
});

describe('theme labels', () => {
    const options = read('index.html');

    it('names every theme in English', () => {
        // The label lives in the registry and is both the visible text and the
        // i18n key; the <option> elements are built from it at startup.
        for (const [value, label] of [
            ['bamboo-ancient', 'Bamboo Slip'],
            ['sumi-e', 'Ink Brush'],
            ['nord', 'Nord'],
            ['kakejiku', 'Hanging Scroll'],
        ]) {
            const th = THEMES.find((t) => t.id === value);
            expect(th, value).toBeTruthy();
            expect(th.label).toBe(label);
        }
    });

    // The value is the CSS class and the localStorage key; renaming a LABEL
    // must never drag it along or every saved setting breaks. Localised labels
    // live in I18n.js keyed by the English fallback, not in the selector.
    it('carries no Japanese in the selector', () => {
        const i = options.indexOf('<select id="theme-selector">');
        const list = options.slice(i, options.indexOf('</select>', i));
        expect(list).not.toMatch(/[぀-ヿ一-鿿]/);
    });
});

// Four places used to decide "is this theme dark?" from their own hand-written
// allowlist — the Mermaid renderer, Shiki, the CodeMirror palette and the
// terminal — and every theme added since drifted out of one of them. The symptom
// is always a light palette on a dark surface at 1-2:1. There is now one list.
describe('dark-theme detection', () => {
    const info = read('src/modules/utils/ThemeInfo.js');

    it('names every dark theme in one place', () => {
        // ThemeInfo delegates to the registry now, so the list is asserted
        // against the registry rather than against the text of that module.
        for (const t of ['theme-dark', 'theme-midnight', 'theme-solarized-dark',
            'theme-bamboo-ancient', 'theme-nord']) {
            expect(darkThemeClasses(), t).toContain(t);
        }
    });

    // Their editor surface is light, whatever the chrome around it does.
    it('excludes the light themes, Hanging Scroll included', () => {
        for (const t of ['theme-sumi-e', 'theme-kakejiku', 'theme-paper',
            'theme-latte', 'theme-solarized-light']) {
            expect(darkThemeClasses(), t).not.toContain(t);
            expect(info, t).not.toContain(`'${t}'`);
        }
    });

    it('is the only list: no consumer keeps its own', () => {
        // ShikiHighlighter.js was on this list until shiki was removed; its
        // job now belongs to CMHighlighter, which needs no dark/light decision
        // at all — the tok-* classes take their colour from the theme.
        for (const f of ['src/modules/utils/Markdown.js',
            'src/modules/views/CodeMirrorView.js']) {
            const src = read(f);
            expect(src, f).toContain('ThemeInfo.js');
            // A second hand-rolled allowlist would look like this.
            expect(src, f).not.toContain("contains('theme-midnight')");
        }
    });
});

/* One registry, and everything else has to agree with it. Adding a theme used
   to mean editing five places, and forgetting any one of them failed quietly:
   a missing dark flag draws a light syntax palette on a dark sheet, a missing
   removal-list entry leaves two theme classes on <body> so the palette depends
   on stylesheet order, a missing boot colour flashes white on launch. None of
   them throw. These do. */
describe('the theme registry is the single source', () => {
    const themesCss = read('src/styles/themes.css');
    const html = read('index.html');

    // The default used to be written out at four call sites while
    // DEFAULT_THEME sat in the registry unused. Change one and the colour the
    // window opens with stops matching what the settings selector claims.
    it('decides the default theme once', () => {
        expect(isKnownTheme(DEFAULT_THEME)).toBe(true);

        // Everything that can import reads the registry.
        for (const rel of ['src/modules/core/Layout.js',
                           'src/modules/ui/SettingsModal.js']) {
            const src = read(rel);
            expect(src, `${rel} still hardcodes a default`)
                .not.toMatch(/getItem\('theme'\) \|\| '/);
            expect(src).toContain("getItem('theme') || DEFAULT_THEME");
        }
    });

    // index.html paints the background before any stylesheet loads, so it runs
    // too early to import and has to name the default itself. That is the one
    // copy, and it has to agree.
    it('agrees with index.html about what the default IS', () => {
        const m = html.match(/getItem\('theme'\) \|\| '([a-z-]+)'/);
        expect(m, 'index.html no longer picks a default theme').toBeTruthy();
        expect(m[1]).toBe(DEFAULT_THEME);
    });

    it('gives every theme a palette in themes.css', () => {
        const missing = THEMES
            .filter((t) => t.id !== 'light')                 // `light` is bare :root
            .filter((t) => !themesCss.includes(`body.theme-${t.id} {`))
            .map((t) => t.id);
        expect(missing, `no palette for: ${missing.join(', ')}`).toEqual([]);
    });

    it('gives every theme a pre-stylesheet background', () => {
        // index.html paints this before any CSS loads, to avoid a white flash
        // on a dark theme. That script runs before modules, so it cannot import
        // the registry — the duplication is checked instead of trusted.
        // `dark` is the default: its colour is baked straight into the
        // critical CSS rather than set by a branch, so it is checked there.
        expect(html).toContain('background-color: #1e1e22');

        const missing = THEMES
            .filter((t) => t.id !== 'light' && t.id !== 'dark')
            .filter((t) => !html.includes(`theme === '${t.id}'`))
            .map((t) => t.id);
        expect(missing, `no boot background for: ${missing.join(', ')}`).toEqual([]);
    });

    it('agrees with index.html about what that background IS', () => {
        const wrong = [];
        for (const t of THEMES) {
            if (t.id === 'light') continue;
            const m = html.match(new RegExp(`theme === '${t.id}'[^\\n]*background-color:\\s*(#[0-9a-fA-F]{6})`));
            if (!m) continue;                                 // covered above
            if (m[1].toLowerCase() !== t.bootBg.toLowerCase()) {
                wrong.push(`${t.id}: registry ${t.bootBg} vs html ${m[1]}`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it('declares the class-removal list from the registry, not by hand', () => {
        const settings = read('src/modules/ui/SettingsModal.js');
        expect(settings).toContain('document.body.classList.remove(...themeClasses())');
        // `light` has no class of its own — it is the bare :root palette.
        expect(themeClasses()).not.toContain('theme-light');
        expect(themeClasses()).toHaveLength(THEMES.length - 1);
    });

    it('builds the picker from the registry', () => {
        const settings = read('src/modules/ui/SettingsModal.js');
        expect(settings).toContain('for (const th of THEMES)');
        // The markup must NOT carry hand-written options any more, or the two
        // lists would drift apart again.
        expect(html).toContain('<select id="theme-selector"></select>');
    });

    it('says whether each theme is dark', () => {
        for (const t of THEMES) {
            expect(typeof t.dark, t.id).toBe('boolean');
        }
        // A sanity check on the flag itself: the registry and the CSS should
        // not disagree about Hanging Scroll, which is the one hybrid.
        expect(THEMES.find((t) => t.id === 'kakejiku').dark).toBe(false);
    });
});

/* The derived-token layer. A theme should only have to declare its palette;
   the surfaces, muted text and state colours are computed from it. */
describe('derived theme tokens', () => {
    const themesCss = read('src/styles/themes.css');

    it('declares them on body, not :root', () => {
        // Custom properties resolve where they are DECLARED. On :root they
        // would substitute the light palette and inherit that value down, so
        // every theme would silently get the light surfaces.
        const i = themesCss.indexOf('--surface-raised:');
        expect(i).toBeGreaterThan(-1);
        const before = themesCss.slice(0, i);
        const lastSelector = before.lastIndexOf('body {');
        const lastRoot = before.lastIndexOf(':root {');
        expect(lastSelector).toBeGreaterThan(lastRoot);
    });

    it('gives the dark family a contrast direction', () => {
        expect(themesCss).toContain('--theme-contrast: #fff;');
        expect(themesCss).toContain('--theme-contrast: #000;');
    });

    it('covers what the overlays need', () => {
        for (const token of [
            '--overlay-bg', '--overlay-border', '--overlay-shadow',
            '--surface-raised', '--surface-sunken', '--scrim',
            '--text-muted', '--text-faint', '--text-on-primary',
            '--primary-soft', '--primary-border',
            '--success-color', '--warning-color', '--danger-color',
            '--control-bg', '--control-border', '--divider-color',
        ]) {
            expect(themesCss, token).toContain(`${token}:`);
        }
    });
});

/* The components that were frozen to one palette. Each of these looked fine on
   the theme it was written against and wrong on the other ten. */
describe('overlays read the theme', () => {
    it('Inline AI is no longer a fixed dark panel', () => {
        const css = read('src/styles/ai.css');
        expect(css).not.toContain('background: rgba(30, 30, 35, 0.7)');
        expect(css).not.toContain('background: #6c5ce7');
        expect(css).toContain('var(--overlay-bg)');
        const js = read('src/modules/ui/InlineAI.js');
        // The default accent, frozen as a literal, on every theme.
        expect(js).not.toContain('rgba(10,108,255,0.14)');
        expect(js).not.toContain('rgba(10,108,255,0.15)');
    });

    it('the activity dock is no longer a fixed dark dock', () => {
        const js = read('src/modules/ai/JhAiActivityPanel.js');
        expect(js).not.toContain("'background:#1e1e1e'");
        expect(js).toContain('var(--overlay-bg)');
    });

    it('the toast uses semantic status colours', () => {
        const js = read('src/modules/ui/Toast.js');
        expect(js).toContain('var(--success-color');
        expect(js).toContain('var(--danger-color');
        expect(js).toContain('var(--warning-color');
    });
});

describe('the terminal palette', () => {
    const src = read('src/modules/ui/TerminalManager.js');

    /** Pull one of the ANSI tables out of the source. */
    const palette = (name) => {
        const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`).exec(src);
        expect(m, `${name} is not defined`).toBeTruthy();
        const out = {};
        for (const hit of m[1].matchAll(/(\w+):\s*'(#[0-9a-f]{6})'/gi)) {
            out[hit[1]] = hit[2];
        }
        return out;
    };

    // xterm falls back to its own defaults for any colour not handed to it,
    // and those defaults assume a dark background. Only six were being set,
    // so on a light theme most of the palette was too pale to read — and
    // `black` was being set to the BACKGROUND, which made black text vanish
    // entirely on light themes.
    it('sets all sixteen colours, not just a handful', () => {
        for (const name of ['ANSI_DARK', 'ANSI_LIGHT']) {
            const p = palette(name);
            for (const c of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
                expect(p[c], `${name}.${c} is missing`).toBeTruthy();
                const bright = 'bright' + c[0].toUpperCase() + c.slice(1);
                expect(p[bright], `${name}.${bright} is missing`).toBeTruthy();
            }
        }
    });

    // black and brightBlack are mixed from the actual background and
    // foreground rather than pinned. A fixed pair sinks into either a dark
    // theme with a light ground (Nord) or a light theme with a dark one.
    it('derives black from the theme instead of pinning it', () => {
        expect(src).toContain('mixHex(finalBg, finalFg');
        expect(src, 'black must not be the background colour again')
            .not.toMatch(/black:\s*finalBg/);
    });

    // Every colour has to clear a readable ratio on every ground it can land
    // on. Tying this to the registry means a new theme with an awkward
    // background fails here rather than in someone's terminal.
    it('stays readable on every theme background', () => {
        const check = (name, wantDark) => {
            const p = palette(name);
            const grounds = THEMES.filter((t) => t.dark === wantDark && t.bootBg);
            expect(grounds.length, `no ${wantDark ? 'dark' : 'light'} themes found`)
                .toBeGreaterThan(0);

            const bad = [];
            for (const [colour, hex] of Object.entries(p)) {
                for (const g of grounds) {
                    const ratio = contrast(hex, g.bootBg);
                    if (ratio < 4.0) {
                        bad.push(`${name}.${colour} ${hex} on ${g.id} = ${ratio.toFixed(2)}`);
                    }
                }
            }
            expect(bad, bad.join('\n')).toEqual([]);
        };

        check('ANSI_DARK', true);
        check('ANSI_LIGHT', false);
    });

    // The old code branched on theme class names, so every new theme needed a
    // line added here and the ones nobody remembered fell back to dark.
    it('asks the registry which theme it is', () => {
        expect(src).toContain("from '../utils/Themes.js'");
        expect(src, 'theme detection must not be a chain of class-name checks')
            .not.toMatch(/classList\.contains\('theme-\w+'\)/);
    });
});
