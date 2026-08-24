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
