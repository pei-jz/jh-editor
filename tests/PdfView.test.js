import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* A PDF used to be handed to the OS: one click, a second application, and the
   editor out of sight. It now opens in a tab, drawn by pdf.js. What could go
   wrong without a failing build:

   - the file still routed elsewhere. Four lists decide where a .pdf goes (the
     explorer's, the backend's "may open" lists, quick-open's binary list) and
     each has to agree.
   - the view holding on to the bytes it was given. pdf.js detaches the buffer
     it is handed, so a view that passed the tab's own array would find it
     empty the next time the tab is shown.
   - Ctrl+F finding nothing. The search panel drives the view through the same
     protocol as the Office preview; a page's matches have to come back and be
     reachable. */

const getDocument = vi.fn();
class FakeTextLayer {
    constructor({ textContentSource, container }) {
        this.source = textContentSource;
        this.container = container;
        this.textDivs = [];
    }
    async render() {
        for (const item of this.source.items) {
            if (item.str === undefined) continue;
            const span = document.createElement('span');
            span.textContent = item.str;
            this.container.appendChild(span);
            this.textDivs.push(span);
        }
    }
    cancel() {}
}

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('pdfjs-dist', () => ({
    GlobalWorkerOptions: {},
    getDocument: (...args) => getDocument(...args),
    TextLayer: FakeTextLayer,
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.js' }));

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8').replace(/\r\n/g, '\n');

const PAGE_TEXT = [
    [{ str: 'Chapter 1' }, { type: 'beginMarkedContent' }, { str: 'The quick fox' }, { type: 'endMarkedContent' }],
    [{ str: 'nothing here' }],
    [{ str: 'Another fox' }, { str: 'and a dog' }],
];

function fakeDoc() {
    return {
        numPages: PAGE_TEXT.length,
        destroy: vi.fn(),
        getPage: vi.fn(async (n) => ({
            getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, scale }),
            getTextContent: async () => ({ items: PAGE_TEXT[n - 1] }),
            render: () => ({ promise: Promise.resolve(), cancel() {} }),
        })),
    };
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('which files get the PDF preview', () => {
    it('is decided by the extension', async () => {
        const { isPdfFile } = await import('../src/modules/utils/Pdf.js');
        expect(isPdfFile('C:/docs/spec.pdf')).toBe(true);
        expect(isPdfFile('C:\\docs\\SPEC.PDF')).toBe(true);
        expect(isPdfFile('C:/docs/spec.pdf.txt')).toBe(false);
        expect(isPdfFile('C:/docs/pdf')).toBe(false);
    });

    it('opens in the editor, and may still be handed to the default app', async () => {
        const { externalKind, opensWithDefaultApp } = await import('../src/modules/utils/ExternalFiles.js');
        expect(externalKind('a.pdf')).toBe(null);
        expect(opensWithDefaultApp('a.pdf')).toBe(true);
        const app = read('src-tauri/src/commands/app.rs');
        const docs = app.slice(app.indexOf('const DOCUMENT_EXTENSIONS'), app.indexOf('];', app.indexOf('const DOCUMENT_EXTENSIONS')));
        expect(docs).toContain('"pdf"');
    });

    it('is findable by name in quick-open', () => {
        const src = read('src-tauri/src/commands/search.rs');
        const list = src.slice(src.indexOf('let binary_exts'), src.indexOf('.into_iter().collect()'));
        expect(list).not.toContain('"pdf"');
    });

    it('has a backend command that reads only .pdf, registered off the main thread', () => {
        const rs = read('src-tauri/src/commands/pdf.rs');
        expect(rs).toMatch(/#\[command\]\npub async fn read_pdf_bytes/);
        expect(rs).toContain('if !is_pdf_path(&path)');
        expect(read('src-tauri/src/lib.rs')).toContain('commands::pdf::read_pdf_bytes');
        expect(read('src-tauri/src/commands/mod.rs')).toContain('pub mod pdf;');
    });

    it('is opened, restored and kept unsaveable by the editor', () => {
        const editor = read('src/modules/core/Editor.js');
        expect(editor).toContain("invoke('read_pdf_bytes', { path })");
        expect(editor).toContain("if (file.type === 'pdf') {");
        expect(editor).toContain("if (file.type === 'office' || file.type === 'pdf') {\n        if (window.showToast) window.showToast(t('Preview only");
        expect(editor.match(/isPdfFile\(entry\.path\)/g)).toHaveLength(2);
        expect(read('src/modules/core/Session.js')).toContain("f.type !== 'pdf'");
    });
});

describe('pdf.js data files', () => {
    it('publishes the CMaps, standard fonts and the decoders\u2019 JS fallbacks', async () => {
        const { pdfjsAssetFiles } = await import('../scripts/pdfjs-assets.js');
        const files = pdfjsAssetFiles(repo).map(([p]) => p);
        if (!existsSync(join(repo, 'node_modules', 'pdfjs-dist'))) return;
        expect(files.some((p) => p.startsWith('cmaps/') && p.endsWith('.bcmap'))).toBe(true);
        expect(files).toContain('cmaps/UniJIS-UTF16-H.bcmap');
        expect(files.some((p) => p.startsWith('standard_fonts/'))).toBe(true);
        expect(files).toContain('wasm/openjpeg_nowasm_fallback.js');
        // The .wasm builds would need 'wasm-unsafe-eval' in the CSP.
        expect(files.some((p) => p.endsWith('.wasm'))).toBe(false);
    });

    it('keeps the CSP as it was', () => {
        const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
        expect(conf.app.security.csp['script-src']).not.toContain('wasm-unsafe-eval');
        expect(conf.app.security.csp['script-src']).not.toContain("'unsafe-eval'");
    });
});

describe('the zoom and page helpers', () => {
    let nextZoom, clampScale, pageAt;
    beforeAll(async () => {
        ({ nextZoom, clampScale, pageAt } = await import('../src/modules/views/PdfView.js'));
    });

    it('walks the zoom steps from wherever fit-width left it', () => {
        expect(nextZoom(1, 1)).toBe(1.1);
        expect(nextZoom(1, -1)).toBe(0.9);
        expect(nextZoom(1.03, 1)).toBe(1.1);
        expect(nextZoom(1.03, -1)).toBe(1);
        expect(nextZoom(5, 1)).toBe(5);
        expect(nextZoom(0.25, -1)).toBe(0.25);
    });

    it('clamps a scale to what can be drawn', () => {
        expect(clampScale(100)).toBe(5);
        expect(clampScale(0)).toBe(0.25);
        expect(clampScale(NaN)).toBe(1);
    });

    it('finds the page at a scroll position', () => {
        const tops = [0, 1000, 2000, 3000];
        expect(pageAt(tops, 0)).toBe(0);
        expect(pageAt(tops, 999)).toBe(0);
        expect(pageAt(tops, 1000)).toBe(1);
        expect(pageAt(tops, 99999)).toBe(3);
        expect(pageAt([], 10)).toBe(0);
    });
});

describe('the view', () => {
    let PdfView;
    let observed;

    beforeAll(async () => {
        ({ PdfView } = await import('../src/modules/views/PdfView.js'));
    });

    beforeEach(() => {
        observed = [];
        getDocument.mockReset();
        globalThis.IntersectionObserver = class {
            constructor(cb) { this.cb = cb; }
            observe(el) {
                observed.push(el);
                // Everything is "on screen" in jsdom.
                this.cb([{ target: el, isIntersecting: true }]);
            }
            disconnect() {}
        };
        HTMLCanvasElement.prototype.getContext = () => ({});
    });

    afterEach(() => {
        delete globalThis.IntersectionObserver;
        document.body.innerHTML = '';
    });

    function open(file) {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const updateStatusBar = vi.fn();
        const view = new PdfView(container, { updateStatusBar });
        view.render('', file);
        return { view, container, updateStatusBar };
    }

    it('draws a placeholder per page and passes pdf.js a copy of the bytes', async () => {
        const doc = fakeDoc();
        getDocument.mockReturnValue({ promise: Promise.resolve(doc), destroy: vi.fn().mockResolvedValue() });
        const bytes = new Uint8Array([37, 80, 68, 70]);
        const file = { path: 'C:/docs/spec.pdf', pdf: bytes };
        const { view, container } = open(file);
        await flush();

        expect(container.querySelectorAll('.pdf-page')).toHaveLength(3);
        const params = getDocument.mock.calls[0][0];
        expect(params.data).not.toBe(bytes);
        expect([...params.data]).toEqual([...bytes]);
        expect(params.useWasm).toBe(false);
        expect(params.isEvalSupported).toBe(false);
        expect(params.cMapUrl).toMatch(/\/pdfjs\/cmaps\/$/);
        expect(view.getSelectionSummary()).toContain('1');
        expect(container.querySelector('.pdf-page-count').textContent).toBe('/ 3');
        view.destroy();
    });

    it('finds text on every page and marks it on the drawn ones', async () => {
        getDocument.mockReturnValue({ promise: Promise.resolve(fakeDoc()), destroy: vi.fn().mockResolvedValue() });
        const { view, container } = open({ path: 'C:/docs/spec.pdf', pdf: new Uint8Array([1]) });
        await flush();

        expect(view.isCellGrid()).toBe(true);
        // As the search panel calls it: a predicate, and the regex behind it.
        const re = /fox/gi;
        const hits = view.collectCellMatches((s) => { re.lastIndex = 0; return re.test(s); }, re);
        // Marked-content markers are not text items: "The quick fox" is item 1.
        // Each hit says where in the item the word is.
        expect(hits).toEqual([{ r: 0, c: 1, s: 10, e: 13 }, { r: 2, c: 0, s: 8, e: 11 }]);
        // One box per hit, over the word rather than the line: the last three
        // of thirteen characters, all of one width with no table to go by.
        const marks = container.querySelectorAll('mark.pdf-hit');
        expect(marks).toHaveLength(2);
        expect(marks[0].parentElement.textContent).toBe('The quick fox');
        expect(parseFloat(marks[0].style.left)).toBeCloseTo(1000 / 13, 2);
        expect(parseFloat(marks[0].style.width)).toBeCloseTo(300 / 13, 2);

        view.gotoCellMatch(hits[1]);
        const active = container.querySelectorAll('.pdf-hit-active');
        expect(active).toHaveLength(1);
        expect(active[0].parentElement.textContent).toBe('Another fox');
        // The header follows the jump even when nothing scrolled.
        expect(view.getSelectionSummary()).toBe('Page 3 / 3');
        expect(container.querySelector('.pdf-page-input').value).toBe('3');

        view.renderSearchHighlights([]);
        expect(container.querySelectorAll('.pdf-hit, .pdf-hit-active')).toHaveLength(0);
        // The text pdf.js drew was never touched: selection and copy read it.
        const line = [...container.querySelectorAll('.textLayer span')].find((s) => s.textContent === 'The quick fox');
        expect(line.childNodes).toHaveLength(1);
        view.destroy();
    });

    it('counts every occurrence in a line, and steps over empty matches', async () => {
        const { occurrences } = await import('../src/modules/views/PdfView.js');
        expect(occurrences(/o/g, 'foo boo')).toEqual([[1, 2], [2, 3], [5, 6], [6, 7]]);
        expect(occurrences(/x*/g, 'axa')).toEqual([[1, 2]]);

        getDocument.mockReturnValue({ promise: Promise.resolve(fakeDoc()), destroy: vi.fn().mockResolvedValue() });
        const { view, container } = open({ path: 'C:/docs/spec.pdf', pdf: new Uint8Array([1]) });
        await flush();
        const re = /o/gi;
        const hits = view.collectCellMatches((s) => { re.lastIndex = 0; return re.test(s); }, re);
        // "nothing here" has one, "Another fox" two, "and a dog" one, "The quick fox" one.
        expect(hits).toHaveLength(5);
        view.gotoCellMatch(hits.find((h) => h.r === 2 && h.s === 9));
        const active = container.querySelector('.pdf-hit-active');
        // The second o of "Another fox", not the first.
        const boxes = [...active.parentElement.querySelectorAll('mark')];
        expect(boxes).toHaveLength(2);
        expect(boxes.indexOf(active)).toBe(1);
        expect(parseFloat(active.style.left)).toBeCloseTo(900 / 11, 2);

        // A new search that misses page 2 clears the marks left there.
        const dog = /dog/gi;
        view.collectCellMatches((s) => { dog.lastIndex = 0; return dog.test(s); }, dog);
        const left = [...container.querySelectorAll('mark.pdf-hit')];
        expect(left.map((m) => m.parentElement.textContent)).toEqual(['and a dog']);
        view.destroy();
    });

    it('places a hit by the PDF\u2019s own glyph widths, not the browser font\u2019s', async () => {
        const { runOffsets, glyphWidthsFrom } = await import('../src/modules/views/PdfView.js');
        const OPS = { setFont: 1, showText: 2 };
        const g = (unicode, width) => ({ unicode, width });
        const widths = glyphWidthsFrom({
            fnArray: [1, 2],
            argsArray: [['F1', 10], [[g('i', 1000), 5, g('f', 500), g('o', 500), g('x', 500)]]],
        }, OPS);
        expect([...widths.get('F1')]).toEqual([['i', 1], ['f', 0.5], ['o', 0.5], ['x', 0.5]]);

        // "iiiifox" at size 10: the four i's take 40 of the item's 55, so the
        // word starts at 40/55 — not at 4/7, where even character widths put it.
        const item = { transform: [10, 0, 0, 10, 0, 0], width: 55, fontName: 'F1' };
        const at = runOffsets('iiiifox', item, widths.get('F1'));
        expect(at[4]).toBeCloseTo(40 / 55, 6);
        expect(at[7]).toBe(1);

        // Width the glyphs do not account for is character spacing: shared
        // evenly, one share per character.
        const spaced = runOffsets('iiiifox', { ...item, width: 55 + 7 * 2 }, widths.get('F1'));
        expect(spaced[4]).toBeCloseTo((40 + 4 * 2) / 69, 6);

        // No table: CJK takes a full em, the rest half, and a character outside
        // the basic plane counts once.
        const fallback = runOffsets('ホテル(A)\u{20B9F}', null, null);
        expect(fallback[3]).toBeCloseTo(3 / 5.5, 6);
        expect(fallback[6]).toBeCloseTo(4.5 / 5.5, 6);
        expect(fallback[7]).toBeCloseTo(fallback[6] + 1 / 5.5, 6);
        expect(fallback[8]).toBe(1);
    });

    it('takes the keyboard from the explorer when a PDF is opened from it', async () => {
        vi.useFakeTimers();
        try {
            getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy: vi.fn().mockResolvedValue() });
            const tree = document.createElement('div');
            tree.id = 'file-list';
            tree.tabIndex = 0;
            document.body.appendChild(tree);
            tree.focus();

            const file = { path: 'C:/docs/spec.pdf', pdf: new Uint8Array([1]) };
            const { view, container } = open(file);
            const body = container.querySelector('.pdf-body');
            expect(document.activeElement).toBe(body);

            // The explorer takes its focus back 50 ms after the click; the view
            // asks again after that.
            tree.focus();
            vi.advanceTimersByTime(100);
            expect(document.activeElement).toBe(body);
            view.destroy();

            // Shown again (a tab switch, a reload from disk): the keyboard
            // stays wherever it is.
            tree.focus();
            const again = open(file);
            vi.advanceTimersByTime(100);
            expect(document.activeElement).toBe(tree);
            again.view.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves the keyboard alone when something else is being typed in', () => {
        vi.useFakeTimers();
        try {
            getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy: vi.fn().mockResolvedValue() });
            const input = document.createElement('input');
            document.body.appendChild(input);
            input.focus();
            const { view } = open({ path: 'C:/docs/spec.pdf', pdf: new Uint8Array([1]) });
            vi.advanceTimersByTime(100);
            expect(document.activeElement).toBe(input);

            // Ctrl+2 still reaches it.
            view.focus();
            expect(document.activeElement.className).toBe('pdf-body');
            view.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps zoom and position on the tab across a rebuild', async () => {
        getDocument.mockReturnValue({ promise: Promise.resolve(fakeDoc()), destroy: vi.fn().mockResolvedValue() });
        const file = { path: 'C:/docs/spec.pdf', pdf: new Uint8Array([1]) };
        const first = open(file);
        await flush();
        first.view.setScale(2);
        expect(file._pdfView.scale).toBe(2);
        expect(file._pdfView.fit).toBe(false);
        first.view.destroy();

        const second = open(file);
        await flush();
        expect(second.container.querySelector('.pdf-zoom-label').textContent).toBe('200%');
        second.view.destroy();
    });

    it('says so when the PDF is password-protected', async () => {
        const task = { destroy: vi.fn().mockResolvedValue() };
        task.promise = new Promise((_, reject) => {
            setTimeout(() => {
                task.onPassword();
                const err = new Error('password'); err.name = 'PasswordException';
                reject(err);
            }, 0);
        });
        getDocument.mockReturnValue(task);
        const { container, view } = open({ path: 'C:/docs/locked.pdf', pdf: new Uint8Array([1]) });
        await flush();
        expect(container.querySelector('.pdf-empty').textContent).toMatch(/password/i);
        view.destroy();
    });

    it('says so when the file cannot be parsed', async () => {
        getDocument.mockReturnValue({ promise: Promise.reject(new Error('Invalid PDF structure')), destroy: vi.fn().mockResolvedValue() });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { container, view } = open({ path: 'C:/docs/bad.pdf', pdf: new Uint8Array([1]) });
        await flush();
        expect(container.querySelector('.pdf-empty').textContent).toMatch(/damaged/);
        warn.mockRestore();
        view.destroy();
    });
});
