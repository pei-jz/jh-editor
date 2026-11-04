import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { undo } from '@codemirror/commands';
import { foldEffect, foldedRanges } from '@codemirror/language';

// A results tab is text the user can edit. Where a line leads is read from the
// text, so the edits cannot break it, and the search keeps adding to it.

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

// CodeMirror measures its text in the next frame; jsdom lays nothing out.
Range.prototype.getClientRects = () => [];
Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

const { SearchResultsView } = await import('../src/modules/views/SearchResultsView.js');
const { foldersBetween, formatRow, hitsUnderFolder, isFolderLine, isPathLine, locateHit, planAppend, treePlace } = await import('../src/modules/utils/SearchResultsText.js');

const A = 'C:\\ws\\a.txt';
const B = 'C:\\ws\\b.txt';
const hit = (path, line, text = 'needle') => ({ path, line, text });

/** What planAppend asks for, done to a string. */
function apply(text, changes) {
    return [...changes]
        .map((c, i) => ({ ...c, i }))
        .sort((x, y) => y.from - x.from || y.i - x.i)
        .reduce((out, c) => out.slice(0, c.from) + c.insert + out.slice(c.from), text);
}

describe('the text of the results', () => {
    const lines = (text) => text.split('\n');
    const at = (text) => (n) => lines(text)[n - 1];

    it('keeps a file\'s hits together however they arrive', () => {
        const groups = new Map();
        let text = '';
        for (const batch of [
            [hit(A, 1), hit(B, 5)],
            [hit(A, 2), hit(B, 6), hit('C:\\ws\\c.txt', 9)],
            [hit(A, 3)],
        ]) {
            text = apply(text, planAppend(batch, groups, text.length));
        }
        expect(lines(text)).toEqual([
            A, formatRow(1, 'needle'), formatRow(2, 'needle'), formatRow(3, 'needle'), '',
            B, formatRow(5, 'needle'), formatRow(6, 'needle'), '',
            'C:\\ws\\c.txt', formatRow(9, 'needle'),
        ]);
        expect(groups.get(A)).toBe(text.indexOf('\n\n'));
        expect(groups.get('C:\\ws\\c.txt')).toBe(text.length);
    });

    it('keeps a stray carriage return from splitting a row', () => {
        expect(formatRow(3, 'a\rb')).toBe('     3: a b');
    });

    it('leads from a row to its line in the file above it', () => {
        const text = [A, formatRow(12, 'x'), '', B, formatRow(7, 'y'), formatRow(40, 'z')].join('\n');
        expect(locateHit(at(text), 2)).toEqual({ path: A, line: 12 });
        expect(locateHit(at(text), 6)).toEqual({ path: B, line: 40 });
        expect(locateHit(at(text), 4)).toEqual({ path: B, line: null });
    });

    it('still leads there with notes typed between the rows', () => {
        const text = [A, 'check this one', formatRow(12, 'edited'), '   99: typed by hand'].join('\n');
        expect(locateHit(at(text), 3)).toEqual({ path: A, line: 12 });
        expect(locateHit(at(text), 4)).toEqual({ path: A, line: 99 });
        expect(locateHit(at(text), 2)).toBeNull();
    });

    it('leads nowhere from a row whose file was deleted', () => {
        expect(locateHit(at(formatRow(12, 'x')), 1)).toBeNull();
    });

    describe('in a folder search', () => {
        const ROOT = 'C:\\ws';
        const F = 'C:\\ws\\src\\';
        const G = 'C:\\ws\\src\\lib\\';
        const plan = (batches) => {
            const groups = new Map();
            let text = '';
            for (const batch of batches) {
                text = apply(text, planAppend(batch, groups, text.length, ROOT));
            }
            return { text, groups };
        };
        const row = (n) => formatRow(n, 'needle');
        const whole = [
            F,
            `${G}`,
            `${G}c.js`, row(3), '',
            `${F}a.js`, row(1), row(2), '',
            `${F}b.js`, row(4), '',
            'C:\\ws\\z.txt', row(5),
        ];

        it('puts a file under its folders wherever it falls in the arrival order', () => {
            const a = hit(`${F}a.js`, 1);
            const a2 = hit(`${F}a.js`, 2);
            const b = hit(`${F}b.js`, 4);
            const c = hit(`${G}c.js`, 3);
            const z = hit('C:\\ws\\z.txt', 5);
            for (const batches of [
                [[a, a2, b, c, z]],
                [[z], [b], [a, a2], [c]],
                [[c], [z, a], [a2, b]],
                [[b], [c], [z], [a], [a2]],
            ]) {
                const { text } = plan(batches);
                expect(lines(text)).toEqual(whole);
            }
        });

        it('knows where every group ends after each batch', () => {
            const { text, groups } = plan([
                [hit('C:\\ws\\z.txt', 5)], [hit(`${F}b.js`, 4)], [hit(`${G}c.js`, 3)],
                [hit(`${F}a.js`, 1)], [hit(`${F}a.js`, 2), hit('C:\\ws\\z.txt', 6)],
            ]);
            for (const [path, end] of groups) {
                const at = text.indexOf(`${path}\n`);
                const rest = text.slice(at);
                const stop = isFolderLine(path) ? rest.indexOf('\n') : (rest.indexOf('\n\n') + 1 || rest.length + 1) - 1;
                expect(end, path).toBe(at + stop);
            }
        });

        it('has no folder for what lies directly in the searched folder, or outside it', () => {
            expect(foldersBetween(ROOT, 'C:\\ws\\a.txt')).toEqual([]);
            expect(foldersBetween(ROOT, 'D:\\other\\a.txt')).toEqual([]);
            expect(foldersBetween(null, 'C:\\ws\\x\\a.txt')).toEqual([]);
        });

        it('walks a path in mixed separators and case', () => {
            expect(foldersBetween('c:/WS/', 'C:/ws\\src\\lib\\c.js')).toEqual(['C:/ws\\src\\', 'C:/ws\\src\\lib\\']);
        });

        it('leads nowhere from a folder, or from a row left directly under one', () => {
            const text = [F, formatRow(1, 'x')].join('\n');
            expect(locateHit(at(text), 1)).toBeNull();
            expect(locateHit(at(text), 2)).toBeNull();
        });
    });

    it('accepts a file reported by name as a file', () => {
        expect(isPathLine('untitled')).toBe(false);
        expect(isPathLine('untitled', (p) => p === 'untitled')).toBe(true);
        // Reads like a row first: a line number and a colon.
        expect(isPathLine('  12: C:\\ws\\a.txt')).toBe(false);
        expect(isPathLine('/home/me/a.txt')).toBe(true);
    });
});

describe('the results tab', () => {
    let container;

    const view = (over = {}) => new SearchResultsView(container, {
        name: 'needle', path: 'search://results-1', type: 'search-results',
        query: 'needle', searchId: 1, streaming: true, matches: [], options: {}, ...over,
    });
    const doc = (v) => v.editorView.state.doc.toString();
    const arrive = (v, ...matches) => { v.file.matches.push(...matches); v.appendMatches(); };
    const type = (v, from, insert) => v.editorView.dispatch({ changes: { from, insert } });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
        localStorage.removeItem('jh_wordWrap');
        localStorage.removeItem('search_results_tree');
    });

    it('shows a line whole, wrapped unless wrapping was turned off', () => {
        const long = `${'x'.repeat(5000)}needle`;
        const v = view({ matches: [hit(A, 1, long)] });
        expect(doc(v)).toContain(long);
        expect(v.editorView.contentDOM.classList.contains('cm-lineWrapping')).toBe(true);
    });

    it('stays unwrapped after coming back to the tab', () => {
        const first = view({ matches: [hit(A, 1)] });
        localStorage.setItem('jh_wordWrap', 'false');
        const { file } = first;
        first.destroy();
        const again = new SearchResultsView(container, file);
        expect(again.editorView.contentDOM.classList.contains('cm-lineWrapping')).toBe(false);
    });

    it('takes typing, and marks the tab as changed', () => {
        const v = view({ matches: [hit(A, 1)] });
        expect(v.file.isDirty).toBeFalsy();
        type(v, 0, 'note\n');
        expect(v.file.content.startsWith('note\n')).toBe(true);
        expect(v.file.isDirty).toBe(true);
    });

    it('is not changed by results arriving, and tells nobody it was', () => {
        const renderTabs = vi.fn();
        const v = new SearchResultsView(container, {
            query: 'needle', searchId: 1, streaming: true, matches: [], options: {},
        }, { renderTabs });
        arrive(v, hit(A, 1));
        expect(v.file.isDirty).toBeFalsy();
        expect(renderTabs).not.toHaveBeenCalled();
    });

    it('adds later hits to the right file around what the user typed', () => {
        const v = view({ matches: [hit(A, 1), hit(B, 5)] });
        type(v, doc(v).indexOf(`\n${B}`) - 1, ' + my note');
        type(v, 0, 'heading\n');
        arrive(v, hit(A, 2), hit(B, 6));
        expect(doc(v).split('\n')).toEqual([
            'heading', A, `${formatRow(1, 'needle')} + my note`, formatRow(2, 'needle'), '',
            B, formatRow(5, 'needle'), formatRow(6, 'needle'),
        ]);
    });

    it('undoes what the user typed, not the results', () => {
        const v = view({ matches: [hit(A, 1)] });
        type(v, 0, 'note\n');
        arrive(v, hit(A, 2));
        undo(v.editorView);
        expect(doc(v).startsWith('note')).toBe(false);
        expect(doc(v)).toContain(formatRow(2, 'needle'));
    });

    it('goes back to clean when an edit is undone', () => {
        const v = view({ matches: [hit(A, 1)] });
        type(v, 0, 'note\n');
        undo(v.editorView);
        expect(v.file.isDirty).toBe(false);
    });

    it('keeps the edits and picks up what arrived while another tab was in front', () => {
        const first = view({ matches: [hit(A, 1)] });
        type(first, 0, 'note\n');
        const { file } = first;
        first.destroy();

        file.matches.push(hit(A, 2));
        const again = new SearchResultsView(container, file);
        expect(doc(again).split('\n')).toEqual(['note', A, formatRow(1, 'needle'), formatRow(2, 'needle')]);
        expect(file.isDirty).toBe(true);
    });

    it('opens the file at the line on Ctrl+click, and only then', () => {
        const openFile = vi.fn();
        window.app = { openFile };
        const v = view({ matches: [hit(A, 12), hit(A, 40)] });
        const posOfRow = doc(v).indexOf(formatRow(40, 'needle'));

        v._handleModClick(posOfRow, v.editorView);
        expect(openFile).toHaveBeenLastCalledWith(A, false, 40, true);

        v._handleModClick(0, v.editorView);
        expect(openFile).toHaveBeenLastCalledWith(A, false, null, false);

        // A plain click is the editor's: no handler of ours opens anything.
        openFile.mockClear();
        v.editorView.contentDOM.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(openFile).not.toHaveBeenCalled();
    });

    it('marks hits in a row\'s text, and survives a pattern that can match nothing', () => {
        const v = view({ query: 'x*', options: { regex: true } });
        expect(v._hitRanges('axxb')).toEqual([[1, 3]]);
        expect(v._hitRanges('abc')).toEqual([]);
    });

    it('folds a file down to its path', () => {
        const v = view({ matches: [hit(A, 1), hit(A, 2), hit(B, 3)] });
        const { state } = v.editorView;
        const group = v._foldableGroup(state, 0);
        expect(state.doc.sliceString(group.from, group.to))
            .toBe(`\n${formatRow(1, 'needle')}\n${formatRow(2, 'needle')}`);
        expect(v._foldableGroup(state, state.doc.line(2).from)).toBeNull();
    });

    const close = (v, path) => {
        const { state } = v.editorView;
        const at = state.doc.toString().indexOf(path);
        v.editorView.dispatch({ effects: foldEffect.of(v._foldableGroup(state, at)) });
    };
    const closed = (v) => {
        const out = [];
        const { state } = v.editorView;
        foldedRanges(state).between(0, state.doc.length, (from, to) => { out.push(state.doc.sliceString(from, to)); });
        return out;
    };

    it('shows a marker that says whether a file is open', () => {
        const { markerDOM } = view()._foldGutterConfig();
        expect(markerDOM(true).querySelector('svg')).not.toBeNull();
        expect(markerDOM(true).innerHTML).not.toBe(markerDOM(false).innerHTML);
    });

    it('keeps a closed file closed when another tab has been in front', () => {
        const first = view({ matches: [hit(A, 1), hit(B, 2)] });
        close(first, A);
        const { file } = first;
        first.destroy();
        const again = new SearchResultsView(container, file);
        expect(closed(again)).toEqual([`\n${formatRow(1, 'needle')}`]);
    });

    it('keeps a closed file closed as more of its hits arrive', () => {
        const v = view({ matches: [hit(A, 1), hit(B, 2)] });
        close(v, A);
        arrive(v, hit(A, 3), hit(B, 4));
        expect(closed(v)).toEqual([`\n${formatRow(1, 'needle')}\n${formatRow(3, 'needle')}`]);
    });

    describe('hit counts', () => {
        const counts = (v) => [...v.editorView.contentDOM.querySelectorAll('.sr-count')].map((el) => el.textContent);

        it('says how many hits each file had, and the totals at the top', () => {
            const v = view({ matches: [hit(A, 1), hit(A, 2), hit(B, 3)] });
            expect(counts(v)).toEqual(['2 hits', '1 hits']);
            expect(v._summaryEl.textContent).toContain('2 files, 3 hits');
        });

        it('keeps the count out of the text', () => {
            const v = view({ matches: [hit(A, 1)] });
            expect(doc(v).split('\n')[0]).toBe(A);
        });

        it('grows as more hits arrive, and is still there after another tab', () => {
            const first = view({ matches: [hit(A, 1)] });
            arrive(first, hit(A, 2));
            expect(counts(first)).toEqual(['2 hits']);
            const { file } = first;
            first.destroy();
            expect(counts(new SearchResultsView(container, file))).toEqual(['2 hits']);
        });

        it('counts what the search found, not the rows left after an edit', () => {
            const v = view({ matches: [hit(A, 1), hit(A, 2)] });
            const row = v.editorView.state.doc.line(3);
            v.editorView.dispatch({ changes: { from: row.from - 1, to: row.to } });
            expect(counts(v)).toEqual(['2 hits']);
        });

        it('gives a folder no count of its own with the tree off', () => {
            localStorage.setItem('search_results_tree', 'false');
            const v = view({ root: 'C:\\ws', matches: [hit('C:\\ws\\src\\a.js', 1)] });
            expect(counts(v)).toEqual(['1 hits']);
        });
    });

    describe('paths are links', () => {
        const F = 'C:\\ws\\src\\';
        const links = (v) => [...v.editorView.contentDOM.querySelectorAll('.sr-link')];
        const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
        let openFile;
        let openDirectory;

        beforeEach(() => {
            openFile = vi.fn();
            openDirectory = vi.fn();
            window.app = { openFile, openDirectory };
        });

        const tree = () => view({ root: 'C:\\ws', matches: [hit(`${F}a.js`, 1)] });

        it('marks the paths, not the rows', () => {
            localStorage.setItem('search_results_tree', 'false');
            expect(links(tree()).map((el) => el.textContent)).toEqual([F, `${F}a.js`]);
        });

        it('closes and opens a file\'s hits on a plain click, without going to it', () => {
            const v = tree();
            click(links(v)[1]);
            expect(closed(v)).toEqual([`\n${formatRow(1, 'needle')}`]);
            click(links(v)[1]);
            expect(closed(v)).toEqual([]);
            expect(openFile).not.toHaveBeenCalled();
        });

        it('still goes to the file on Ctrl+click', () => {
            const v = tree();
            v._handleModClick(doc(v).indexOf(`${F}a.js`), v.editorView);
            expect(openFile).toHaveBeenCalledWith(`${F}a.js`, false, null, false);
        });

        it('closes one file of a folder, leaving the rest open', () => {
            const v = view({ root: 'C:\\ws', matches: [hit(`${F}a.js`, 1), hit(`${F}b.js`, 2)] });
            click(links(v)[1]);
            expect(closed(v)).toEqual([`\n${formatRow(1, 'needle')}`]);
        });

        it('closes and opens a folder on a plain click, without going to it', () => {
            const v = tree();
            click(links(v)[0]);
            expect(closed(v)).toEqual([`\n${F}a.js\n${formatRow(1, 'needle')}`]);
            click(links(v)[0]);
            expect(closed(v)).toEqual([]);
            expect(openDirectory).not.toHaveBeenCalled();
        });

        it('still shows a folder on Ctrl+click, without its last separator', () => {
            const v = tree();
            v._handleModClick(doc(v).indexOf(F), v.editorView);
            expect(openDirectory).toHaveBeenCalledWith('C:\\ws\\src');
        });

        it('leaves a drag across a path as a selection', () => {
            const v = tree();
            v.editorView.dispatch({ selection: { anchor: 0, head: 4 } });
            click(links(v)[1]);
            expect(closed(v)).toEqual([]);
        });
    });

    describe('folders', () => {
        const ROOT = 'C:\\ws';
        const F = 'C:\\ws\\src\\';
        const G = 'C:\\ws\\src\\lib\\';
        const tree = (over) => view({
            root: ROOT,
            matches: [hit(`${F}a.js`, 1), hit(`${G}c.js`, 3), hit('C:\\ws\\z.txt', 9)],
            ...over,
        });
        const groupOf = (v, path) => {
            const { state } = v.editorView;
            const found = v._foldableGroup(state, state.doc.toString().indexOf(`${path}\n`));
            return state.doc.sliceString(found.from, found.to);
        };

        it('folds a folder with everything under it, and no more', () => {
            const v = tree();
            const held = groupOf(v, F);
            expect(held).toContain(`${F}a.js`);
            expect(held).toContain(`${G}c.js`);
            expect(held).not.toContain('z.txt');
            expect(held.endsWith('\n')).toBe(false);
            const inner = groupOf(v, G);
            expect(inner).toContain(`${G}c.js`);
            expect(inner).not.toContain(`${F}a.js`);
        });

        it('counts files, not folders', () => {
            const v = tree();
            expect(v._summaryEl.textContent).toContain('3 files, 3 hits');
        });

        it('keeps a closed folder closed around files that arrive for it', () => {
            const v = tree();
            close(v, F);
            arrive(v, hit(`${F}0first.js`, 7), hit(`${F}zlast.js`, 8), hit('C:\\ws\\after.txt', 2));
            const [held] = closed(v);
            expect(held).toContain(`${F}0first.js`);
            expect(held).toContain(`${F}zlast.js`);
            expect(held).not.toContain('after.txt');
        });

        it('keeps a file closed inside a folder through closing and opening it', () => {
            const first = tree();
            close(first, `${G}c.js`);
            close(first, F);
            expect(closed(first)).toHaveLength(2);
            const { file } = first;
            first.destroy();
            const again = new SearchResultsView(container, file);
            expect(closed(again)).toHaveLength(2);
        });
    });

    it('takes in what arrived for a closed file while another tab was in front', () => {
        const first = view({ matches: [hit(A, 1)] });
        close(first, A);
        const { file } = first;
        first.destroy();
        file.matches.push(hit(A, 2));
        const again = new SearchResultsView(container, file);
        expect(closed(again)).toEqual([`\n${formatRow(1, 'needle')}\n${formatRow(2, 'needle')}`]);
    });

    describe('the tree', () => {
        const F = 'C:\\ws\\src\\';
        const results = () => view({
            root: 'C:\\ws',
            matches: [hit(`${F}a.js`, 1), hit(`${F}a.js`, 2), hit(`${F}lib\\b.js`, 3), hit('C:\\ws\\top.js', 4)],
        });
        const content = (v) => v.editorView.contentDOM;
        const names = (v) => [...content(v).querySelectorAll('.sr-link')].map((el) => el.textContent);
        const counts = (v) => [...content(v).querySelectorAll('.sr-count')].map((el) => el.textContent);
        const lineOf = (v, name) => [...content(v).querySelectorAll('.cm-line')].find((l) => l.textContent.includes(name));
        const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));

        it('draws names and depth, with the whole paths still in the text', () => {
            const v = results();
            expect(names(v)).toEqual(['src', 'lib', 'b.js', 'a.js', 'top.js']);
            expect(doc(v)).toContain(`${F}lib\\b.js`);
            const padding = (name) => parseInt(lineOf(v, name).style.paddingLeft, 10);
            expect(padding('src')).toBeLessThan(padding('lib'));
            expect(padding('lib')).toBeLessThan(padding('b.js'));
            expect(padding('top.js')).toBe(padding('src'));
        });

        it('adds up what is under a folder', () => {
            expect(counts(results())).toEqual(['3 hits', '1 hits', '1 hits', '2 hits', '1 hits']);
        });

        it('closes and opens on a click anywhere on the row, and the marker follows', () => {
            const v = results();
            const row = lineOf(v, 'lib');
            expect(row.querySelector('.sr-tree-marker').title).toBe('Collapse');
            click(row);
            expect(doc(v)).toContain('b.js');
            expect(content(v).textContent).not.toContain('b.js');
            const shut = lineOf(v, 'lib');
            expect(shut.querySelector('.sr-tree-marker').title).toBe('Expand');
            click(shut.querySelector('.sr-tree-marker'));
            expect(content(v).textContent).toContain('b.js');
        });

        it('Ctrl+click still goes to the whole path', () => {
            const openFile = vi.fn();
            window.app = { openFile };
            const v = results();
            v._handleModClick(doc(v).indexOf(`${F}a.js`), v.editorView);
            expect(openFile).toHaveBeenCalledWith(`${F}a.js`, false, null, false);
        });

        it('turns off from the header and stays off', () => {
            const v = results();
            const toggle = container.querySelector('.sr-tree-toggle');
            expect(toggle.getAttribute('aria-pressed')).toBe('true');
            toggle.click();
            expect(names(v)).toContain(`${F}a.js`);
            expect(content(v).querySelector('.sr-tree-marker')).toBeNull();
            expect(container.querySelector('.sr-editor').classList.contains('sr-tree')).toBe(false);
            expect(localStorage.getItem('search_results_tree')).toBe('false');
        });

        it('has nothing to offer for a search with no folder', () => {
            const v = view({ matches: [hit(A, 1)] });
            expect(container.querySelector('.sr-tree-toggle')).toBeNull();
            expect(names(v)).toEqual([A]);
        });

        it('keeps a path typed from elsewhere whole', () => {
            const v = results();
            type(v, 0, 'D:\\other\\x.js\n     9: note\n\n');
            expect(names(v)).toContain('D:\\other\\x.js');
        });
    });

    describe('where a path sits in the tree', () => {
        it('reads depth and name, for files and folders', () => {
            const text = 'C:\\ws\\src\\lib\\b.js';
            const place = treePlace(text, 'C:\\ws');
            expect(place.depth).toBe(2);
            expect(text.slice(place.nameFrom, place.nameTo)).toBe('b.js');
            const folder = 'C:\\ws\\src\\lib\\';
            const at = treePlace(folder, 'c:/WS/');
            expect(at).toMatchObject({ depth: 1, folder: true });
            expect(folder.slice(at.nameFrom, at.nameTo)).toBe('lib');
        });

        it('has no place for what is outside the folder, or the folder itself', () => {
            expect(treePlace('D:\\x.js', 'C:\\ws')).toBeNull();
            expect(treePlace('C:\\ws2\\x.js', 'C:\\ws')).toBeNull();
            expect(treePlace('C:\\ws\\', 'C:\\ws')).toBeNull();
            expect(treePlace('C:\\ws\\x.js', null)).toBeNull();
        });

        it('counts a folder\'s hits, not those of one with a similar name', () => {
            const counts = new Map([['C:\\ws\\src\\a.js', 2], ['C:\\ws\\srcish\\b.js', 5], ['C:\\ws\\src\\l\\c.js', 1]]);
            expect(hitsUnderFolder(counts, 'C:\\ws\\src\\')).toBe(3);
        });
    });
});
