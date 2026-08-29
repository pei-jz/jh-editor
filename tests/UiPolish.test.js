import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    Snippets, DEFAULT_CATEGORY, normalizeCategory, snippetsFor,
} from '../src/modules/ui/Snippets.js';
import { _replacedMessage } from '../src/modules/ui/Search.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const luminance = (hex) => {
    const c = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
    const f = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/* The titlebar dimmed its text with `opacity`, which fades toward whatever is
   behind it. On the Hanging Scroll mount that left the path at about 2:1. */
describe('titlebar readability', () => {
    const css = read('src/styles/titlebar.css');
    const themes = read('src/styles/themes.css');

    it('colours the text instead of fading it', () => {
        expect(css).toContain('--titlebar-text');
        expect(css).toContain('--titlebar-text-dim');
        // The blanket 0.85 on the whole title block is what made the filename
        // dim too; only the directory keeps a slight step down.
        const i = css.indexOf('.titlebar-title {');
        const block = css.slice(i, css.indexOf('}', i));
        expect(block).not.toContain('opacity: 0.85');
        expect(css).not.toContain('opacity: 0.5;\n    font-weight: 400;');
    });

    it('lets a theme that repaints the bar set its own ink', () => {
        expect(themes).toContain('--titlebar-text: var(--mount-ink);');
    });

    // The first attempt derived the path colour with a 72% mix AND kept a 0.85
    // opacity on top. The two compounded, and a derived colour can never be
    // better than the pair it derives from: Solarized Light bottomed out at
    // 2.05:1. The path is now barely dimmed, and the hierarchy is weight.
    it('does not stack an opacity on top of the dimmed colour', () => {
        const i = css.lastIndexOf('#file-directory {');
        const block = css.slice(i, css.indexOf('}', i));
        expect(block).not.toContain('opacity');
        expect(read('src/styles/themes.css'))
            .toContain('color-mix(in srgb, var(--text-color) 88%, var(--header-bg))');
    });

    // Solarized's body text was never meant to sit on its own header tone:
    // #657b83 on #eee8d5 is 3.64:1 before any dimming at all.
    it('gives a theme with a weak base pair its own titlebar ink', () => {
        const i = themes.indexOf('body.theme-solarized-light {');
        const block = themes.slice(i, themes.indexOf('\n}', i));
        expect(block).toContain('--titlebar-text: #073642;');
        expect(contrast('#657b83', '#eee8d5')).toBeLessThan(4.5);   // the reason
        expect(contrast('#073642', '#eee8d5')).toBeGreaterThan(4.5);
    });

    it('clears 4.5:1 on every theme, filename and path alike', () => {
        // text/header per theme, plus the two themes that set their own ink.
        const pairs = [
            ['#343a40', '#f1f3f5'], ['#d4d4d4', '#252526'], ['#c5cbe0', '#1a1c25'],
            ['#4c4f69', '#e6e9ef'], ['#b0bec5', '#073642'], ['#073642', '#eee8d5'],
            ['#243049', '#e7dab9'], ['#e8e0cc', '#2f2518'], ['#1c1c1c', '#efece3'],
            ['#eceff4', '#343b49'], ['#eef1f6', '#3a4868'],
        ];
        const mix88 = (a, b) => '#' + [0, 2, 4].map((i) => Math.round(
            parseInt(a.slice(1 + i, 3 + i), 16) * 0.88
            + parseInt(b.slice(1 + i, 3 + i), 16) * 0.12,
        ).toString(16).padStart(2, '0')).join('');

        for (const [text, header] of pairs) {
            expect(contrast(text, header), `filename ${text} on ${header}`)
                .toBeGreaterThanOrEqual(4.5);
            expect(contrast(mix88(text, header), header), `path on ${header}`)
                .toBeGreaterThanOrEqual(4.5);
        }
    });
});

/* Every theme defines --bg-color-secondary; half the stylesheet asks for
   --bg-secondary. Those reads fell through to a hard-coded dark colour while
   the text followed the theme, which is dark-on-dark in any light theme. */
describe('the toast', () => {
    const toast = read('src/modules/ui/Toast.js');

    it('names the token the themes actually set', () => {
        expect(toast).toContain('var(--bg-color-secondary, #1e1e1e)');
        // An alias on :root looked like the tidy fix and was not one; see the
        // "derived defaults" suite below.
        expect(read('src/styles/themes.css')).not.toContain('--bg-secondary:');
    });

    // 3s is fine for "Saved" and far too short for a sentence with a number in
    // it that the reader is meant to act on.
    it('stays up longer, and longer still for longer messages', async () => {
        const { Toast } = await import('../src/modules/ui/Toast.js');
        const durationFor = Toast.constructor.durationFor;
        expect(durationFor('Saved')).toBeGreaterThanOrEqual(5000);
        expect(durationFor('a'.repeat(60))).toBeGreaterThan(durationFor('Saved'));
        // ...but nothing camps on screen.
        expect(durationFor('a'.repeat(5000))).toBeLessThanOrEqual(12000);
    });

    // Search had a second, private notification box on a 2-second timer — and
    // it was the one carrying the messages with numbers in them.
    it('is the only notification system left', () => {
        const search = read('src/modules/ui/Search.js');
        expect(search).toContain("import { Toast } from './Toast.js';");
        expect(search).not.toContain("toast.id = 'search-toast'");
        expect(search).not.toContain('}, 2000);');
    });
});

/* "Replaced all occurrences" said the same thing whether it replaced 900 or
   none at all — and the count was already sitting in `changes.length`. */
describe('replace feedback', () => {
    it('names the number and the query', () => {
        expect(_replacedMessage(3, 'foo')).toBe('Replaced 3 occurrences of "foo".');
        expect(_replacedMessage(1, 'foo')).toBe('Replaced 1 occurrence of "foo".');
    });

    // "Replaced 0" reads like a failure; the honest meaning is "nothing matched".
    it('says nothing matched rather than reporting zero', () => {
        expect(_replacedMessage(0, 'foo')).toContain('No matches');
        expect(_replacedMessage(0, 'foo')).not.toContain('Replaced 0');
    });

    it('trims a query too long to sit in a toast', () => {
        const msg = _replacedMessage(2, 'x'.repeat(80));
        expect(msg).toContain('…');
        expect(msg.length).toBeLessThan(80);
    });

    it('returns the count from the editor rather than discarding it', () => {
        const cm = read('src/modules/views/CodeMirrorView.js');
        const i = cm.indexOf('replaceAll(query, replaceWith,');
        const fn = cm.slice(i, cm.indexOf('\n    _showReferencesModal', i));
        expect(fn).toContain('return changes.length;');
        expect(fn).toContain('if (!this.editorView) return 0;');

        // The plain-text path has no such list, so it counts before replacing:
        // String.replace never reports how many it hit.
        const search = read('src/modules/ui/Search.js');
        expect(search).toContain('const replaced = (content.match(regex) || []).length;');
    });
});

describe('snippet categories', () => {
    beforeEach(() => { localStorage.clear(); });

    it('files an uncategorised snippet under the default', () => {
        const s = Snippets.add('One', 'o', 'body');
        expect(s.category).toBe(DEFAULT_CATEGORY);
        expect(normalizeCategory('   ')).toBe(DEFAULT_CATEGORY);
        expect(normalizeCategory('  Git  ')).toBe('Git');
    });

    // Snippets saved before categories existed have no field at all; reading
    // must not lose them, and must not rewrite storage to "fix" them.
    it('reads a pre-category snippet without migrating it', () => {
        localStorage.setItem('jh_snippets_v1', JSON.stringify([
            { id: 'old', name: 'Legacy', prefix: 'lg', body: 'x' },
        ]));
        expect(Snippets.getAll()[0].category).toBe(DEFAULT_CATEGORY);
        expect(JSON.parse(localStorage.getItem('jh_snippets_v1'))[0].category).toBeUndefined();
    });

    it('groups for display, dropping empty categories', () => {
        Snippets.add('A', 'a', 'x', 'Git');
        Snippets.add('B', 'b', 'x', 'Git');
        Snippets.add('C', 'c', 'x');
        const groups = Snippets.grouped();
        expect(groups.map((g) => g.category)).toEqual([DEFAULT_CATEGORY, 'Git']);
        expect(groups.find((g) => g.category === 'Git').items).toHaveLength(2);
    });

    // The default is the bucket everything starts in; burying it under "Api"
    // reads as a missing list.
    it('lists the default category first, then the rest alphabetically', () => {
        Snippets.add('A', '', 'x', 'Zsh');
        Snippets.add('B', '', 'x', 'Api');
        expect(Snippets.categories()).toEqual([DEFAULT_CATEGORY, 'Api', 'Zsh']);
    });

    it('moves a snippet between categories', () => {
        const s = Snippets.add('A', '', 'x', 'Git');
        expect(Snippets.setCategory(s.id, 'Shell')).toBe(true);
        expect(Snippets.getById(s.id).category).toBe('Shell');
        expect(Snippets.setCategory('nope', 'Shell')).toBe(false);
    });

    it('renders one collapsible section per category, remembering the state', () => {
        const src = read('src/modules/ui/SettingsModal.js');
        expect(src).toContain('Snippets.grouped()');
        expect(src).toContain("const COLLAPSE_KEY = 'settings_snippetCollapsed';");
        expect(src).toContain('writeCollapsed(now)');
        expect(read('src/styles/features.css')).toContain('.snippet-group-head');
    });

    // Adding three snippets to one category in a row is the normal case.
    it('keeps the category between adds', () => {
        const src = read('src/modules/ui/SettingsModal.js');
        const i = src.indexOf("container.querySelector('#snip-add-btn').onclick");
        const fn = src.slice(i, src.indexOf('} catch (err)', i));
        expect(fn).toContain('categoryInput ? categoryInput.value');
        expect(fn).not.toContain('categoryInput.value = \'\';');
    });
});

/* The heading and its explanation were 8px apart at 12px type, which reads as
   one block of text with a coloured first line. */
describe('settings headings', () => {
    it('are a class with real spacing, not four inline styles', () => {
        const css = read('src/styles/features.css');
        const i = css.indexOf('.settings-section-title {');
        expect(i).toBeGreaterThan(-1);
        expect(css).toContain('.settings-section-title + .settings-description');

        const src = read('src/modules/ui/SettingsModal.js');
        expect(src).not.toMatch(/font-weight:bold; margin-bottom:8px;[^"]*--primary-color/);
        // Every section heading uses it.
        expect((src.match(/class="settings-section-title"/g) || []).length).toBeGreaterThanOrEqual(4);
    });
});

/* The titlebar fix did nothing at first, and the reason was not the colours.
   `#current-file` and `#file-directory` used to live in a toolbar, and their
   old rules were still in layout.css — identical specificity, loaded AFTER
   titlebar.css, so they won. The filename was painted `--text-color`: the
   PAGE's ink on the BAR's background, 1.48:1 on the Hanging Scroll mount. */
describe('nothing else paints the titlebar text', () => {
    const sheets = ['base', 'layout', 'editor', 'explorer', 'modals', 'features',
        'ai', 'outline', 'structure', 'diff', 'csv'];

    it('leaves those two ids to titlebar.css', () => {
        for (const name of sheets) {
            const css = read(`src/styles/${name}.css`);
            // A selector for either id, anywhere but in a comment.
            const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
            expect(stripped, `${name}.css`).not.toMatch(/#current-file\s*[,{]/);
            expect(stripped, `${name}.css`).not.toMatch(/#file-directory\s*[,{]/);
        }
    });

    it('truncates the directory rather than the filename', () => {
        const css = read('src/styles/titlebar.css');
        const dir = css.slice(css.indexOf('#file-directory {'));
        expect(dir.slice(0, dir.indexOf('}'))).toContain('flex: 0 1 auto');
        // lastIndexOf: the id also appears in the shared truncation block.
        const file = css.slice(css.lastIndexOf('#current-file {'));
        expect(file.slice(0, file.indexOf('}'))).toContain('flex: 0 0 auto');
    });
});

/* Themes are `body.theme-*` classes, so a custom property declared on `:root`
   that SUBSTITUTES another token is resolved against :root's own values — the
   light defaults — and no theme override ever reaches it. Aliasing
   `--bg-secondary: var(--bg-color-secondary)` on :root therefore handed every
   theme the light colour, which is how the settings modal ended up with white
   chrome around a dark body. */
describe('derived defaults are declared where the themes are', () => {
    const css = read('src/styles/themes.css');

    /** The text inside the first `:root { … }` block. */
    const rootBlock = () => {
        const i = css.indexOf(':root {');
        return css.slice(i, css.indexOf('\n}', i));
    };

    /** Tokens redefined by at least one `body.theme-*` rule. */
    const themed = () => {
        const names = new Set();
        const re = /body\.[a-z0-9-]+\s*\{([\s\S]*?)\n\}/g;
        let m;
        while ((m = re.exec(css))) {
            for (const d of m[1].matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(d[1]);
        }
        return names;
    };

    it('never resolves a themed token from :root', () => {
        const overridden = themed();
        const offenders = [];
        for (const m of rootBlock().matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
            const [, name, value] = m;
            for (const use of value.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
                // Safe when every theme that changes the source also sets this
                // token directly — then the :root value is only the default.
                const alwaysOverridden = overridden.has(name);
                if (overridden.has(use[1]) && !alwaysOverridden) {
                    offenders.push(`${name} reads ${use[1]}`);
                }
            }
        }
        expect(offenders, offenders.join('; ')).toEqual([]);
    });

    it('puts the titlebar defaults on body instead', () => {
        expect(css).toMatch(/\nbody \{[\s\S]*?--titlebar-text: var\(--text-color\);/);
        expect(rootBlock()).not.toContain('--titlebar-text');
    });
});

/* Ink Brush dresses the mount and leaves the paper alone, the way a hanging
   scroll does: 遠山 on the titlebar, a dry-brush sweep on the status bar, and
   nothing at all on the editor. */
describe('the Ink Brush mount bands', () => {
    const css = read('src/styles/themes.css');
    const theme = css.slice(css.indexOf('body.theme-sumi-e {'));

    /** Every fill/stroke opacity in one band's SVG. */
    const opacities = (token) => {
        // Sliced rather than matched: a regex for a data URI is mostly escapes,
        // and the value is delimited unambiguously by url(" and ");
        const start = css.indexOf(token + ': url("');
        expect(start, token).toBeGreaterThan(-1);
        const from = css.indexOf('svg+xml,', start) + 'svg+xml,'.length;
        const svg = decodeURIComponent(css.slice(from, css.indexOf('");', from)));
        return [...svg.matchAll(/opacity='([0-9.]+)'/g)].map((x) => parseFloat(x[1]));
    };

    it('paints the two full-width strips and nothing else', () => {
        expect(theme).toContain('body.theme-sumi-e #custom-titlebar {');
        expect(theme).toContain('body.theme-sumi-e #status-bar {');
        // The tab bar starts after the sidebar, so the same picture stretched
        // to a different width would read as a second, mismatched painting.
        expect(theme).not.toContain('body.theme-sumi-e #tab-bar {');
    });

    it('leaves the paper as it was', () => {
        const i = theme.indexOf('body.theme-sumi-e #explorer,');
        const paper = theme.slice(i, theme.indexOf('}', i));
        expect(paper).toContain('background-image: var(--grain);');
        expect(paper).not.toContain('sumi-mount');
    });

    // A landscape stretched across an ultrawide window stops being a landscape;
    // a single brush stroke stretched is just a longer stroke.
    it('keeps the mountains proportional and stretches only the sweep', () => {
        const top = theme.slice(theme.indexOf('#custom-titlebar {'));
        expect(top.slice(0, top.indexOf('}'))).toContain('background-size: auto 100%');
        expect(top.slice(0, top.indexOf('}'))).toContain('background-position: right bottom');

        const bottom = theme.slice(theme.indexOf('#status-bar {'));
        expect(bottom.slice(0, bottom.indexOf('}'))).toContain('background-size: 100% 100%');
    });

    it('stays under the agreed 18% ink ceiling', () => {
        for (const token of ['--sumi-mount-top', '--sumi-mount-bottom']) {
            const list = opacities(token);
            expect(list.length, token).toBeGreaterThan(0);
            expect(Math.max(...list), token).toBeLessThanOrEqual(0.18);
        }
    });

    // #706b5d was exactly 4.50:1 on the bare band — a floor with nothing behind
    // it, and both the tab labels and the status bar sat on it.
    it('lifts the ink that sits on a band', () => {
        expect(theme).toContain('--tab-inactive-color: #4f4a3e;');
        expect(theme).toContain('--text-secondary: #4f4a3e;');
    });

    it('keeps every band label readable over the darkest ink', () => {
        const band = '#efece3';
        const over = (a) => '#' + [0, 2, 4].map((i) => Math.round(
            parseInt(band.slice(1 + i, 3 + i), 16) * (1 - a) + 0x1c * a,
        ).toString(16).padStart(2, '0')).join('');

        const ceiling = over(0.18);   // worst case the cap allows
        expect(contrast('#1c1c1c', ceiling)).toBeGreaterThanOrEqual(4.5);  // filename
        expect(contrast('#353534', ceiling)).toBeGreaterThanOrEqual(4.5);  // path
        expect(contrast('#4f4a3e', ceiling)).toBeGreaterThanOrEqual(4.5);  // status
        // The colour it replaced would not have survived.
        expect(contrast('#706b5d', ceiling)).toBeLessThan(4.5);
    });
});

/* The popup opened on SPACE — the most frequently typed key there is. The
   source matched the text before the caret with `\S*`, which matches the empty
   string, and every prefix "starts with" nothing. */
describe('when a snippet popup may open', () => {
    const list = [
        { prefix: 'lg', name: 'Log statement', body: 'x' },
        { prefix: '#note', name: 'Note block', body: 'x' },
        { prefix: 'tbl', name: 'Markdown table', body: 'x' },
    ];

    it('offers nothing for nothing typed', () => {
        expect(snippetsFor(list, '')).toEqual([]);
        expect(snippetsFor(list, null)).toEqual([]);
        expect(snippetsFor(list, undefined)).toEqual([]);
    });

    it('opens on a registered keyword, punctuation included', () => {
        expect(snippetsFor(list, '#').map((s) => s.prefix)).toEqual(['#note']);
        expect(snippetsFor(list, 'lg').map((s) => s.prefix)).toEqual(['lg']);
        expect(snippetsFor(list, 'L').map((s) => s.prefix)).toEqual(['lg']);
    });

    // One character of a NAME matches almost everything, so a name fragment has
    // to be worth something before it counts.
    it('needs two characters before matching on the name', () => {
        expect(snippetsFor(list, 'm')).toEqual([]);
        expect(snippetsFor(list, 'ma').map((s) => s.prefix)).toEqual(['tbl']);
    });

    it('says nothing about text that matches no snippet', () => {
        expect(snippetsFor(list, ');')).toEqual([]);
        expect(snippetsFor(list, 'zzz')).toEqual([]);
    });

    // A regex that can match the empty string is the whole bug; pin the source.
    it('asks the editor for a non-empty run before the caret', () => {
        const src = read('src/modules/ui/Snippets.js');
        expect(src).toContain('context.matchBefore(/\\S+/)');
        expect(src).not.toContain('context.matchBefore(/\\S*/)');
    });
});

/* The status-bar control is the always-visible way in, because a shortcut
   cannot advertise itself. It opens the command PALETTE (which runs things),
   not the shortcut guide (which only lists the things that have a key). */
describe('the way in to the commands', () => {
    const html = read('index.html');
    const css = read('src/styles/features.css');

    it('is a control that is always visible, in space the editor was not using', () => {
        expect(html).toContain('id="status-commands"');
        const i = html.indexOf('id="status-commands"');
        const j = html.indexOf('</button>', i);
        const btn = html.slice(html.lastIndexOf('<button', i), j);
        // It names the key, so it only has to be clicked once.
        expect(btn).toContain('<kbd>Ctrl+Shift+P</kbd>');
        expect(btn).toContain('Commands');
        // It sits in the status bar's right group, not over the editor.
        expect(html.indexOf('id="status-selection"')).toBeLessThan(i);
    });

    it('opens the command palette, and the palette can run what it lists', () => {
        expect(read('src/modules/core/Constants.js'))
            .toContain("getElementById('status-commands')");
        const app = read('src/modules/core/App.js');
        expect(app).toContain('EL.statusCommandsBtn?.addEventListener');
        expect(app).toContain('CommandPalette.toggle()');
        // The palette dispatches through the same path a keystroke takes, so a
        // command cannot behave differently depending on how it was invoked.
        expect(app).toContain('initCommandPalette((cmd) => delegateToView(cmd)(null))');
        // The guide is still reachable — it is one row inside the palette.
        expect(app).toContain("'app:shortcut-guide': toggleShortcutGuide");
    });

    // The same compounding mistake as the titlebar path: a second dimming can
    // only make a marginal pair worse.
    it('does not fade its own text a second time', () => {
        const i = css.indexOf('.status-commands kbd {');
        expect(css.slice(i, css.indexOf('}', i))).not.toContain('opacity');
        const j = css.indexOf('.status-commands-icon {');
        expect(css.slice(j, css.indexOf('}', j))).not.toContain('opacity');
    });
});

/* Measuring the new button turned up the bar it sits on: --text-secondary
   against --header-bg is 2.18:1 to 4.37:1 in nine of the eleven themes, so the
   encoding, the line and column and the file size were all under the floor. */
describe('the status bar itself', () => {
    it('uses ink derived from the theme, not a fixed grey', () => {
        const layout = read('src/styles/layout.css');
        const i = layout.indexOf('#status-bar {');
        const block = layout.slice(i, layout.indexOf('}', i));
        expect(block).toContain('color: var(--titlebar-text-dim, var(--text-color));');
        expect(block).not.toContain('color: var(--text-secondary);');
    });

    it('clears 4.5:1 on every theme', () => {
        // text/header per theme, and the two that set their own chrome ink.
        const pairs = [
            ['#343a40', '#f1f3f5'], ['#d4d4d4', '#252526'], ['#c5cbe0', '#1a1c25'],
            ['#4c4f69', '#e6e9ef'], ['#b0bec5', '#073642'], ['#073642', '#eee8d5'],
            ['#243049', '#e7dab9'], ['#e8e0cc', '#2f2518'], ['#1c1c1c', '#efece3'],
            ['#eceff4', '#343b49'],
        ];
        const mix88 = (a, b) => '#' + [0, 2, 4].map((i) => Math.round(
            parseInt(a.slice(1 + i, 3 + i), 16) * 0.88
            + parseInt(b.slice(1 + i, 3 + i), 16) * 0.12,
        ).toString(16).padStart(2, '0')).join('');
        for (const [text, header] of pairs) {
            expect(contrast(mix88(text, header), header), `status bar on ${header}`)
                .toBeGreaterThanOrEqual(4.5);
        }
        // Hanging Scroll paints the bar with the mount and its own ink.
        expect(contrast('#c3cddf', '#3a4868')).toBeGreaterThanOrEqual(4.5);
        // The colour it replaced would not have passed.
        expect(contrast('#6c757d', '#f1f3f5')).toBeLessThan(4.5);
    });
});
