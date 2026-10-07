import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* A 100 MB log opens in the ordinary editor (the large-file viewer starts at
   500 MB by default). Anything that walks the whole text on every keystroke,
   cursor move or tab switch makes such a file unusable, so those paths are
   pinned here. */

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn(), watch: vi.fn(async () => () => {}) }));

const { bufferByteSize, utf8ByteLength, addViewUsageHint } = await import('../src/modules/core/Editor.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('utf8ByteLength', () => {
    const cases = ['', 'ascii', 'あいう', 'é ñ ß', '😀 emoji', 'mixed あ 😀 é', '\ud800 lone surrogate', 'end\udbff'];
    for (const text of cases) {
        it(`matches TextEncoder for ${JSON.stringify(text)}`, () => {
            expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
        });
    }
});

describe('bufferByteSize', () => {
    it('is remembered for the same text, and recomputed when it changes', () => {
        const file = { content: 'a\nb', eol: '\r\n' };
        expect(bufferByteSize(file)).toBe(4);
        expect(file._byteSize.content).toBe(file.content);

        const spy = vi.spyOn(String.prototype, 'charCodeAt');
        try {
            expect(bufferByteSize(file)).toBe(4);
            expect(spy).not.toHaveBeenCalled(); // cursor moves do not re-count
        } finally {
            spy.mockRestore();
        }

        file.content = 'a\nb\nc';
        expect(bufferByteSize(file)).toBe(7);
        file.eol = '\n';
        expect(bufferByteSize(file)).toBe(5);
    });
});

describe('usage hints in the text editor', () => {
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

    it('shows no Structure View hints on a plain text file', () => {
        addViewUsageHint(container, { path: 'C:/logs/big.log', name: 'big.log' }, { isTextEditor: true });
        expect(container.querySelector('.view-usage-hint')).toBeNull();
    });

    it('still shows the vi palette when vi mode is on', () => {
        localStorage.setItem('settings_editorVim', 'true');
        addViewUsageHint(container, { path: 'C:/logs/big.log', name: 'big.log' }, { isTextEditor: true });
        expect(container.querySelector('.view-usage-hint').textContent).toContain('Vim');
    });

    it('still shows Structure View hints in the structure view', () => {
        addViewUsageHint(container, { path: 'C:/data/a.xml', name: 'a.xml', viewMode: 'structure' });
        expect(container.querySelector('.view-usage-hint').textContent).toContain('Structure View');
    });
});

/* Structural: CodeMirrorView needs a real editor and the whole app around it. */
describe('CodeMirrorView on large documents', () => {
    const cm = read('src/modules/views/CodeMirrorView.js');

    it('keeps the editor state as objects across tab switches, never as JSON', () => {
        // Code only: the comment explaining why JSON was dropped names it.
        const code = cm.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
        expect(code).not.toMatch(/state\.toJSON\(/);
        expect(code).not.toMatch(/EditorState\.fromJSON\(/);
        expect(cm).toContain('doc: this.editorView.state.doc,');
        expect(cm).toContain('historyField.init(() => saved.history)');
    });

    // Poking scrollTop before CodeMirror measured left a big file blank except
    // for one line until the next click.
    it('returns to the reading position through a scroll snapshot', () => {
        expect(cm).toContain('scrollSnapshot: this.editorView.scrollSnapshot(),');
        expect(cm).toContain('if (reusedSaved && saved.scrollSnapshot) {');
        expect(cm).toContain('this.editorView.dispatch({ effects: saved.scrollSnapshot });');
        // The pixel fallback re-measures instead of trusting estimated heights.
        const i = cm.indexOf('this.editorView.scrollDOM.scrollTop = savedScrollTop;');
        expect(cm.slice(i, i + 120)).toContain('this.editorView.requestMeasure();');
    });

    it('draws only the search hits on screen', () => {
        expect(cm).toContain('for (const { from, to } of view.visibleRanges)');
        const i = cm.indexOf('    renderSearchHighlights(matches, index) {');
        const body = cm.slice(i, cm.indexOf('\n    }', i));
        expect(body).not.toContain('Decoration.');
    });

    it('caps a search only for very short terms', () => {
        expect(cm).toContain('const MAX_MATCHES = searchMatchLimit(query);');
        expect(cm).not.toContain('const MAX_MATCHES = 20000;');
    });
});

describe('a new search starts from the cursor', () => {
    it('uses the next match after the cursor, not the first in the file', () => {
        const search = read('src/modules/ui/Search.js');
        expect(search).toContain('State.currentMatchIndex = _matchIndexFromCursor(step);');
        const cmThen = search.slice(search.indexOf('_cmView.performSearch('), search.indexOf('.catch(', search.indexOf('_cmView.performSearch(')));
        expect(cmThen).not.toContain('State.currentMatchIndex = 0;');
    });
});
