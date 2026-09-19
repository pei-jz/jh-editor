import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addViewUsageHint } from '../src/modules/core/Editor.js';

describe('addViewUsageHint — vi mode hint panel', () => {
    let container;

    beforeEach(() => {
        localStorage.clear();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
        localStorage.clear();
    });

    const mdFile = { path: '/tmp/notes.md', name: 'notes.md', content: '# hi' };

    it('shows vi command hints for Markdown when settings_vimMode is on', () => {
        localStorage.setItem('settings_vimMode', 'true');
        addViewUsageHint(container, mdFile);
        const panel = container.querySelector('.view-usage-hint');
        expect(panel).toBeTruthy();
        const title = panel.querySelector('.view-usage-title');
        expect(title.textContent).toContain('Vim');
        const text = panel.textContent;
        expect(text).toContain('j / k');
        expect(text).toContain('Enter');
        expect(text).toContain('insert mode');
        expect(text).toContain('link hints');
    });

    it('shows the ordinary Markdown hint when vi mode is off', () => {
        localStorage.setItem('settings_vimMode', 'false');
        addViewUsageHint(container, mdFile);
        const panel = container.querySelector('.view-usage-hint');
        const text = panel.textContent;
        expect(text).toContain('Markdown View');
        expect(text).toContain('move between blocks');
        expect(text).not.toContain('j / k');
    });

    // The palette must follow the MOUNTED EDITOR, not the file name. A .md or
    // .csv opened in text mode (Ctrl+Shift+E) is a CodeMirror editor, and it
    // used to be handed the "Markdown View" / "Table View" block hints while vi
    // was actually running.
    describe('vi in the CodeMirror text editor', () => {
        const cases = [
            ['markdown in text mode', { path: '/tmp/notes.md', name: 'notes.md' }],
            ['csv in text mode', { path: '/tmp/rows.csv', name: 'rows.csv' }],
            ['an ordinary source file', { path: '/tmp/app.js', name: 'app.js' }],
        ];

        for (const [label, file] of cases) {
            it('shows the vi palette for ' + label, () => {
                localStorage.setItem('settings_editorVim', 'true');
                addViewUsageHint(container, file, { isTextEditor: true });
                const text = container.querySelector('.view-usage-hint').textContent;
                expect(text).toContain('Vim');
                expect(text).toContain('h / j / k / l');
                expect(text).toContain('yy / 3yy');
                expect(text).not.toContain('move between blocks');
                expect(text).not.toContain('move cell');
            });
        }

        // The palette has to cover more than movement: replacing, counted
        // copy/paste, word selection and "the next N of something" are the
        // operations people reach for and cannot guess from single letters.
        it('covers replace, counted yank/paste, word and N-char selection', () => {
            localStorage.setItem('settings_editorVim', 'true');
            addViewUsageHint(container, { path: '/tmp/app.js', name: 'app.js' },
                { isTextEditor: true });
            const text = container.querySelector('.view-usage-hint').textContent;
            for (const entry of [
                'r / R',            // replace a character
                ':%s/a/b/g',        // replace across the file
                ':s/a/b/g',         // replace in the line
                'ciw / cw',         // change a word
                'yy / 3yy',         // copy N lines
                'dd / 3dd',         // cut N lines
                'p / P',            // paste
                'viw',              // select a word
                'v3l / v3w',        // select the next N chars / words
                'V3j',              // select N lines
                'v / V / Ctrl+V',   // the visual modes themselves
            ]) {
                expect(text, entry).toContain(entry);
            }
        });

        it('leaves the block-view hints alone when the same file is NOT in the text editor', () => {
            localStorage.setItem('settings_editorVim', 'true');
            addViewUsageHint(container, { path: '/tmp/notes.md', name: 'notes.md' });
            const text = container.querySelector('.view-usage-hint').textContent;
            expect(text).toContain('Markdown View');
            expect(text).not.toContain('h / j / k / l');
        });
    });

    /* A draft has no path yet, and "no path" used to be read as "Markdown" —
       from when Ctrl+N could only make one kind of file. Pick Text in the
       new-file picker and the corner taught you the Markdown block keys for a
       plain .txt buffer. The name carries the answer; the missing path does
       not. */
    describe('an unsaved draft is judged by its name', () => {
        it('shows no panel at all for a .txt draft in the text editor', () => {
            addViewUsageHint(container, { path: null, name: 'Untitled.txt' },
                { isTextEditor: true });
            expect(container.querySelector('.view-usage-hint')).toBeNull();
        });

        it('does not call a .txt draft Markdown', () => {
            addViewUsageHint(container, { path: null, name: 'Untitled.txt' });
            const text = container.querySelector('.view-usage-hint').textContent;
            expect(text).not.toContain('Markdown View');
            expect(text).not.toContain('move between blocks');
        });

        it('still knows a .md draft IS Markdown', () => {
            addViewUsageHint(container, { path: null, name: 'Untitled.md' });
            const text = container.querySelector('.view-usage-hint').textContent;
            expect(text).toContain('Markdown View');
        });
    });

    /* The plain-text plugin's viewClass IS CodeMirrorView, so "a plugin
       resolved" never meant "a structured view" — every .txt, .log and .js went
       down the structured branch and sprouted a panel. renderEditor has to ask
       the view it actually built. */
    it('is told what the mounted view is, not whether a plugin resolved', async () => {
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const { dirname, join } = await import('node:path');
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(join(here, '..', 'src/modules/core/Editor.js'), 'utf8');
        expect(src).toContain('addViewUsageHint(container, file, { isTextEditor: view instanceof CodeMirrorView })');
        expect(src).not.toContain('if (plugin) addViewUsageHint(container, file);');
    });

    it('can be closed, and the close is not persisted', () => {
        addViewUsageHint(container, mdFile);
        const panel = container.querySelector('.view-usage-hint');
        panel.querySelector('.view-usage-close').click();
        expect(container.querySelector('.view-usage-hint')).toBeNull();

        // Re-rendering the view brings it back — closing must not strand the
        // hints the way a persisted dismissal would.
        addViewUsageHint(container, mdFile);
        expect(container.querySelector('.view-usage-hint')).toBeTruthy();
    });

    it('uses a separate minimised-state key for the vi hint', () => {
        localStorage.setItem('settings_vimMode', 'true');
        localStorage.setItem('view-usage-hint-min-vi', '1');
        addViewUsageHint(container, mdFile);
        const panel = container.querySelector('.view-usage-hint');
        expect(panel.classList.contains('minimized')).toBe(true);
    });
});
