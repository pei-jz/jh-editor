import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Themes that carry their own syntax palette (CodeMirrorView.PALETTE_THEMES).
// Two things have gone wrong with these before: a dark theme was handed the
// LIGHT highlight style (1.4:1 keywords), and palettes shipped with comment and
// gutter tones around 2.4-2.7:1. Both are contrast failures, so the rule is
// enforced here rather than re-pinned per hex value.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

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

    it('is offered in the settings selector', () => {
        expect(read('index.html')).toContain(`<option value="${name}"`);
    });

    it('is cleared when switching away', () => {
        expect(read('src/modules/ui/SettingsModal.js')).toContain(`'theme-${name}'`);
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
        expect(read('index.html')).toContain('<option value="paper"');
    });
});

describe('theme labels', () => {
    const options = read('index.html');

    it('names every theme in English', () => {
        for (const [value, label] of [
            ['bamboo-ancient', 'Bamboo Slip'],
            ['sumi-e', 'Ink Brush'],
            ['nord', 'Nord'],
            ['kakejiku', 'Hanging Scroll'],
        ]) {
            // The English label is the i18n fallback: the option carries it as
            // textContent and as the data-i18n key (translated in the UI).
            expect(options, value).toContain(`<option value="${value}" data-i18n="${label}">${label}</option>`);
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
        for (const t of ['theme-dark', 'theme-midnight', 'theme-solarized-dark',
            'theme-bamboo-ancient', 'theme-nord']) {
            expect(info, t).toContain(`'${t}'`);
        }
    });

    // Their editor surface is light, whatever the chrome around it does.
    it('excludes the light themes, Hanging Scroll included', () => {
        for (const t of ['theme-sumi-e', 'theme-kakejiku', 'theme-paper',
            'theme-latte', 'theme-solarized-light']) {
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
