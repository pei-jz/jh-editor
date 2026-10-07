import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const editor = read('src/styles/editor.css');
const themes = read('src/styles/themes.css');

/**
 * Rule blocks whose selector list is `selector`.
 *
 * Whitespace-normalised on both sides: a selector list is often wrapped across
 * lines, and how it happens to be wrapped is not what any of this is about.
 */
const norm = (s2) => s2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
const blocksFor = (css, selector) => {
    const want = norm(selector);
    const out = [];
    // No leading `}` in the pattern: consuming it would leave the next rule
    // without one, and every second rule in the file would be skipped.
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
        if (norm(m[1]) === want) out.push(m[2]);
    }
    return out;
};

/* Rendered Markdown inherited the CODE font in book mode and a sans in scroll
   mode, so the same document looked like two documents depending on how you
   were reading it. Headings stopped at h4, and the two that were styled used
   two different decorations for the same job. */

describe('prose is set in a reading font', () => {
    it('has a body font that is neither the chrome font nor the code font', () => {
        expect(themes).toMatch(/--font-body:/);
        const decl = themes.slice(themes.indexOf('--font-body:'));
        const value = decl.slice(0, decl.indexOf(';'));
        expect(value).not.toContain('--font-mono');
        expect(value).not.toContain('--font-main');
        // Latin first, Japanese after: the serifs below carry no kana, so the
        // Japanese runs fall through to the mincho on their own.
        expect(value).toMatch(/Mincho|明朝/);
    });

    it('uses it for the blocks, in both reading modes', () => {
        for (const sel of ['.md-block', '.md-body']) {
            const [body] = blocksFor(editor, sel);
            expect(body, sel).toMatch(/font-family:\s*var\(--font-body\)/);
        }
        // Book mode forced the editor font onto every page.
        const [page] = blocksFor(editor, '.stf__page');
        expect(page).toMatch(/font-family:\s*var\(--font-body\)/);
        expect(page).not.toMatch(/--editor-font-family/);
    });

    it('leaves code, and the plain-text book, in a fixed pitch', () => {
        for (const sel of ['.md-block pre,\n.md-body pre', '.md-block code,\n.md-body code']) {
            const [body] = blocksFor(editor, sel);
            expect(body, sel).toMatch(/font-family:\s*var\(--font-mono\)/);
        }
        // A .log is not prose, and the columns people line up in one only line
        // up in a fixed pitch.
        const [plain] = blocksFor(editor, '.stf__page.plain-text-page');
        expect(plain).toMatch(/font-family:\s*var\(--editor-font-family\)/);
    });
});

describe('the heading scale', () => {
    it('defines all six levels', () => {
        for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
            expect(editor, h).toMatch(new RegExp(`\\.md-block ${h},`));
            expect(editor, h).toMatch(new RegExp(`\\.md-body ${h}`));
        }
    });

    it('never makes a heading smaller than the body text', () => {
        // h5 and h6 used to fall through to the browser, where h6 is SMALLER
        // than body text — a level of the outline that read as a mistake.
        for (const h of ['h5', 'h6']) {
            const [body] = blocksFor(editor, `.md-block ${h},\n.md-body ${h}`);
            expect(body, h).toBeTruthy();
            const size = /font-size:\s*([\d.]+)em/.exec(body);
            expect(size, `${h} should set a size`).toBeTruthy();
            expect(Number(size[1]), h).toBeGreaterThanOrEqual(1);
        }
    });

    it('spaces them in their own size, not in pixels', () => {
        // `em` on a heading is measured in the heading's size, so the bigger
        // it is the more air it gets — without six fixed numbers that drift
        // apart the next time one of them is touched.
        const [shared] = blocksFor(editor,
            '.md-block h1, .md-block h2, .md-block h3,\n'
            + '.md-block h4, .md-block h5, .md-block h6,\n'
            + '.md-body h1, .md-body h2, .md-body h3,\n'
            + '.md-body h4, .md-body h5, .md-body h6');
        expect(shared).toBeTruthy();
        expect(shared).toMatch(/margin-top:\s*[\d.]+em/);
        expect(shared).toMatch(/margin-bottom:\s*[\d.]+em/);
    });

    it('marks headings for the eye in the view you scan', () => {
        // The scroll view is where you hunt for the block you want in a
        // document you are part way through, and a mark the eye catches at
        // speed earns its place there.
        const [after] = blocksFor(editor, '.md-block h1::after,\n.md-body h1::after');
        expect(after, 'h1 accent').toMatch(/background-color:\s*var\(--primary-color\)/);
        const [before] = blocksFor(editor, '.md-block h2::before,\n.md-body h2::before');
        expect(before, 'h2 bar').toMatch(/background-color:\s*var\(--primary-color\)/);
    });

    it('drops them in the view you read', () => {
        // Book mode shows no hover tools and no clickable blocks: nothing on
        // the page is being hunted for, so a mark in the margin is only
        // interrupting the line.
        expect(blocksFor(editor, '.stf__page h1::after')[0]).toMatch(/display:\s*none/);
        expect(blocksFor(editor, '.stf__page h2::before')[0]).toMatch(/display:\s*none/);
        // The hairline under a title separates it from its text. That is
        // structure rather than ornament, and it stays.
        expect(blocksFor(editor, '.stf__page h1')[0]).toMatch(/border-bottom-width:\s*1px/);
    });

    it('orders the two so the reading view actually wins', () => {
        // Same specificity either way, so the one written last is the one that
        // takes effect — which makes the order load-bearing.
        expect(editor.indexOf('.stf__page h1::after'))
            .toBeGreaterThan(editor.indexOf('.md-block h1::after'));
        expect(editor.indexOf('.stf__page h2::before'))
            .toBeGreaterThan(editor.indexOf('.md-block h2::before'));
    });
});

describe('the scroll view uses the width it is given', () => {
    const PAGE = blocksFor(editor,
        '#editor-content.markdown-mode,\n#editor-content-right.markdown-mode');

    it('keeps the left inset and gives the right one back', () => {
        /* 40px on every side meant 53px of empty page beside every line. The
           left stays exactly as it was — the text starts where the eye already
           expects it — and only the scrollbar still needs room on the right. */
        expect(PAGE, 'the markdown page should set its own inset').toHaveLength(1);
        const [top, right, bottom, left] = /padding:\s*([^;]+);/.exec(PAGE[0])[1]
            .trim().split(/\s+/).map((v) => parseInt(v, 10));
        expect(left, 'left').toBe(40);
        expect(top, 'top').toBe(40);
        expect(bottom, 'bottom').toBe(40);
        expect(right, 'right').toBeLessThan(40);
    });

    it('puts the margin on the view, not on the shell every view shares', () => {
        /* #editor-content is shared. Plain text and the CSV grid each cancelled
           the inset, but the diff, the compare, the agent panel, the folder
           comparison and the grep results all return before renderEditor
           normalises the mode class — so they inherited whichever class the
           PREVIOUS file left. A diff opened after a Markdown file was inset;
           the same diff after a .txt was not. */
        const [shell] = blocksFor(read('src/styles/layout.css'), '#editor-content');
        expect(shell).toMatch(/padding:\s*0/);
        // And with nothing to cancel, the two modes that cancelled it stop.
        expect(blocksFor(editor, '#editor-content.plain-mode')[0]).not.toMatch(/padding/);
        expect(blocksFor(read('src/styles/csv.css'), '#editor-content.csv-mode')[0])
            .not.toMatch(/padding/);
    });

    it('clears the mode class before any view can return without setting one', () => {
        /* Moving the margin onto .markdown-mode is only half of it: the class
           itself used to survive from the previous file, because the diff, the
           compare, the agent panel, the folder comparison and the grep results
           all return early. The reset has to happen before the first of them. */
        const render = read('src/modules/core/Editor.js');
        const reset = render.indexOf(
            "container.classList.remove('plain-mode', 'csv-mode', 'markdown-mode', 'deck-mode')");
        expect(reset, 'the mode class should be cleared somewhere').toBeGreaterThan(-1);

        for (const early of ["file.type === 'diff'", "file.type === 'compare'",
                             "file.type === 'agent'", "file.type === 'dir-diff'",
                             "file.type === 'search-results'"]) {
            const at = render.indexOf(early, render.indexOf('function renderEditor'));
            expect(at, early).toBeGreaterThan(-1);
            expect(reset, `${early} must come after the reset`).toBeLessThan(at);
        }

        // And only once: a second reset further down would read as though the
        // first one were not enough.
        expect(render.split(
            "classList.remove('plain-mode', 'csv-mode', 'markdown-mode', 'deck-mode')")
        ).toHaveLength(2);
    });

    it('beats the id rule it is overriding, in both panes', () => {
        // `.markdown-mode` alone loses to `#editor-content` on specificity, so
        // each pane's id has to be named or the rule does nothing at all.
        expect(editor).toContain('#editor-content.markdown-mode');
        expect(editor).toContain('#editor-content-right.markdown-mode');
    });

    it('leaves the toolbar floating, so widening cannot push text under it', () => {
        // What keeps the first line clear of the buttons is the TOP inset and
        // the fact that the toolbar is out of flow — not any reserved width.
        const [bar] = blocksFor(editor, '.cm-view-toolbar');
        expect(bar).toMatch(/position:\s*absolute/);
    });
});

describe('the stylesheets say each thing once', () => {
    // Not a matter of taste: a rule written twice means the first copy's
    // properties are dead, and the next person to edit it edits the dead one.
    it.each(['.mermaid', '.editor-toolbar button'])('%s is declared once', (sel) => {
        expect(blocksFor(editor, sel)).toHaveLength(1);
    });

    it.each(['--shadow-md', '--shadow-lg', '--text-secondary'])(
        '%s is set once in :root', (name) => {
            // Once PER THEME is the point of themes.css and stays. Twice in
            // :root is a copy-paste that the second line silently wins.
            const root = blocksFor(themes, ':root');
            const inRoot = root.join('\n')
                .split('\n')
                .filter((l) => new RegExp(`^\\s*${name}\\s*:`).test(l));
            expect(inRoot).toHaveLength(1);
        });

    it('still lets every theme set its own', () => {
        // The guard above must not be read as "delete the per-theme ones".
        const all = themes.split('\n').filter((l) => /^\s*--text-secondary\s*:/.test(l));
        expect(all.length).toBeGreaterThan(5);
    });
});
