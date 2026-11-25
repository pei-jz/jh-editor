import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewSwitchTarget, currentViewLabel, hasStructureView } from '../src/modules/utils/ViewSwitch.js';

/* The view switch. Ctrl+Shift+E was the only way between a file's text and
   its other view, and the toolbar button that now offers it has to agree with
   the key about which files have one: a button on a .txt would do nothing, and
   a missing one on a .json hides the tree again. */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const tab = (path, viewMode, extra = {}) => ({ path, name: path.split('/').pop(), viewMode, ...extra });

describe('where the switch goes', () => {
    it('names the destination, not the action', () => {
        expect(viewSwitchTarget(tab('C:/a/notes.md', 'text'))).toEqual({ to: 'structure', label: 'Markdown View' });
        expect(viewSwitchTarget(tab('C:/a/data.csv', 'text'))).toEqual({ to: 'structure', label: 'Table View' });
        expect(viewSwitchTarget(tab('C:/a/conf.json', 'text'))).toEqual({ to: 'structure', label: 'Structure View' });
        expect(viewSwitchTarget(tab('C:/a/page.jsp', 'text'))).toEqual({ to: 'structure', label: 'Structure View' });
    });

    it('goes back to the text from every structure view', () => {
        for (const p of ['C:/a/notes.md', 'C:/a/data.csv', 'C:/a/schema.xsd', 'C:/a/index.html']) {
            expect(viewSwitchTarget(tab(p, 'structure'))).toEqual({ to: 'text', label: 'Text View' });
        }
    });

    it('offers nothing where there is no second view', () => {
        expect(viewSwitchTarget(tab('C:/a/readme.txt', 'text'))).toBeNull();
        expect(viewSwitchTarget(tab('C:/a/app.js', 'text'))).toBeNull();
        expect(viewSwitchTarget(tab('C:/a/book.xlsx', undefined, { type: 'office' }))).toBeNull();
        expect(viewSwitchTarget(tab('C:/a/spec.pdf', undefined, { type: 'pdf' }))).toBeNull();
        expect(viewSwitchTarget(null)).toBeNull();
    });

    it('sends a deck to its slides, and leaves Deck View to its own Source button', () => {
        expect(viewSwitchTarget(tab('C:/a/deck.html', 'text'), { isDeck: true })).toEqual({ to: 'deck', label: 'Deck View' });
        expect(viewSwitchTarget(tab('C:/a/deck.html', 'deck'), { isDeck: true })).toBeNull();
    });

    it('agrees with the key on which files have a structure view', () => {
        // Editor.js's Ctrl+Shift+E asks hasStructureView; the plugin that draws
        // the view must exist for every one of them.
        const plugins = read('src/modules/core/ViewPlugins.js');
        for (const ext of ['csv', 'xml', 'xsd', 'wsdl', 'html', 'htm', 'jsp', 'json', 'md']) {
            expect(hasStructureView(tab(`C:/a/f.${ext}`, 'text')), ext).toBe(true);
            expect(plugins).toContain(`'${ext}'`);
        }
        expect(read('src/modules/core/Editor.js')).toMatch(/if \(hasStructureView\(file\)\) \{/);
    });
});

describe('the status bar', () => {
    it('names the view on screen', () => {
        expect(currentViewLabel(tab('C:/a/notes.md', 'structure'))).toBe('Markdown View');
        expect(currentViewLabel(tab('C:/a/data.csv', 'structure'))).toBe('Table View');
        expect(currentViewLabel(tab('C:/a/conf.json', 'structure'))).toBe('Structure View');
        expect(currentViewLabel(tab('C:/a/notes.md', 'text'))).toBe('Text View');
        expect(currentViewLabel(tab('C:/a/deck.html', 'deck'))).toBe('Deck View');
    });
});

describe('the button is in every view that can switch', () => {
    it('is added by the text editor, the Markdown view, the table and the tree', () => {
        for (const f of ['CodeMirrorView', 'MarkdownView', 'CsvView', 'StructureView']) {
            expect(read(`src/modules/views/${f}.js`), f).toContain('addViewSwitchButton(');
        }
    });

    it('stays out of the source pane StructureView mounts inside itself', () => {
        // That editor gets a stand-in file with no viewMode; a switch there
        // would flip the whole tab from inside one node's source.
        expect(read('src/modules/views/CodeMirrorView.js')).toContain('if (file && file.viewMode) addViewSwitchButton(toolbar, file);');
    });
});
