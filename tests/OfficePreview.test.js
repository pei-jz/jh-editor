import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extensionOf, isOfficeFile, officeKind } from '../src/modules/utils/Office.js';

/* Opening a spreadsheet to look at one column meant waiting for Excel. The
   preview exists to remove that wait, which puts two things at risk that a
   passing build would not show:

   - a file routed to the wrong reader. An .xlsx read as text is mojibake; a
     .doc routed to a preview that cannot read it is a dead click. The
     extension list is the whole of that decision, so it is tested first.
   - a grid that draws all of it. Five thousand rows by two hundred columns is
     a million cells, and building them is the freeze the feature promised to
     remove. The view windows both axes; these tests watch the window. */

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('which files get the Office preview', () => {
    it('reads the extension off a path, not off the folders above it', () => {
        expect(extensionOf('C:\\work\\2026.Q1\\report.xlsx')).toBe('xlsx');
        expect(extensionOf('/home/a/b.d/notes')).toBe('');
        // A dotfile's leading dot names the file; it is not an extension.
        expect(extensionOf('.gitignore')).toBe('');
        expect(extensionOf('Book.XLSX')).toBe('xlsx');
    });

    it('claims only the formats there is a reader for', () => {
        for (const p of ['a.xlsx', 'a.xlsm', 'a.xls', 'a.ods', 'a.docx', 'a.pptx']) {
            expect(isOfficeFile(p), p).toBe(true);
        }
        // The pre-2007 binary formats have no reader here. Claiming them would
        // route the file into a preview whose only possible outcome is an error.
        for (const p of ['a.doc', 'a.ppt', 'a.pdf', 'a.csv', 'a.md', 'xlsx']) {
            expect(isOfficeFile(p), p).toBe(false);
        }
    });

    it('names the shape the preview will take', () => {
        expect(officeKind('q1.xlsx')).toBe('sheets');
        expect(officeKind('deck.pptx')).toBe('slides');
        expect(officeKind('spec.docx')).toBe('document');
        expect(officeKind('readme.md')).toBe(null);
    });

    // The explorer hid every Office extension as "binary". With the preview in
    // place that hides the feature: the file cannot be clicked because it is
    // not drawn.
    it('is no longer filtered out of the explorer listing', () => {
        const src = read('src/modules/utils/FileSystem.js');
        const list = src.slice(src.indexOf('BINARY_EXTENSIONS'), src.indexOf('return entries.filter'));
        for (const ext of ['xlsx', 'xls', 'ods', 'docx', 'pptx']) {
            expect(list, `${ext} should not be hidden`).not.toContain(`'${ext}'`);
        }
        // …and the ones with no reader still are.
        for (const ext of ['doc', 'ppt', 'pdf']) {
            expect(list, `${ext} should stay hidden`).toContain(`'${ext}'`);
        }
    });

    // Quick-open (Ctrl+P) reads its own list, in Rust. A file that opens but
    // cannot be found by name is a feature nobody discovers.
    it('is findable by name in quick-open', () => {
        const src = read('src-tauri/src/commands/search.rs');
        const list = src.slice(src.indexOf('let binary_exts'), src.indexOf('.into_iter().collect()'));
        for (const ext of ['xlsx', 'docx', 'pptx']) {
            expect(list, `${ext} should be listed`).not.toContain(`"${ext}"`);
        }
        expect(list).toContain('"doc"');
        expect(list).toContain('"ppt"');
    });
});

describe('the grid helpers', () => {
    let columnName, isNumeric, measureColumns, oneLine, textWidth;

    beforeAll(async () => {
        ({ columnName, isNumeric, measureColumns, oneLine, textWidth } =
            await import('../src/modules/views/OfficeView.js'));
    });

    it('labels columns the way a spreadsheet does', () => {
        expect(columnName(0)).toBe('A');
        expect(columnName(25)).toBe('Z');
        // The carry is the part that is easy to get wrong: after Z comes AA,
        // not BA, and 51 is AZ rather than AA again.
        expect(columnName(26)).toBe('AA');
        expect(columnName(51)).toBe('AZ');
        expect(columnName(52)).toBe('BA');
        expect(columnName(701)).toBe('ZZ');
        expect(columnName(702)).toBe('AAA');
    });

    it('right-aligns numbers without right-aligning things that merely start with one', () => {
        expect(isNumeric('42')).toBe(true);
        expect(isNumeric('-3.5')).toBe(true);
        expect(isNumeric('1,204')).toBe(true);
        expect(isNumeric('12%')).toBe(true);
        // An order code and a date are text. Aligning them right makes a column
        // of identifiers look like a column of quantities.
        expect(isNumeric('2026-01-04')).toBe(false);
        expect(isNumeric('12 units')).toBe(false);
        expect(isNumeric('')).toBe(false);
    });

    it('folds a multi-line value onto the one line a row has room for', () => {
        // Rows are a fixed height so they can be virtualised. Left alone, the
        // second and third lines would be drawn below the cell and clipped —
        // data in the file, invisible on screen, with nothing to say so.
        expect(oneLine('one\ntwo\nthree')).toBe('one two three');
        expect(oneLine('a\r\n  b')).toBe('a b');
        expect(oneLine('plain')).toBe('plain');
        expect(oneLine('')).toBe('');
    });

    it('gives a Japanese column the width its characters actually take', () => {
        // Counting characters and multiplying cut every Japanese column short:
        // a kanji is nearly twice a Latin letter wide.
        expect(textWidth('MMMM')).toBeCloseTo(4 * 6.6, 1);
        expect(textWidth('六角')).toBeCloseTo(2 * 12, 1);
        // Half-width katakana is half-width — that is the whole point of it.
        expect(textWidth('ｱｲ')).toBeLessThan(textWidth('アイ'));

        const [latin, japanese] = measureColumns([['Bolt', '六角ボルト']]);
        expect(japanese).toBeGreaterThan(latin);

        // A column measured on the folded text, not on the raw value: the
        // line breaks are gone by the time it is drawn.
        const [folded] = measureColumns([['ab\ncd']]);
        expect(folded).toBe(measureColumns([['ab cd']])[0]);
    });

    it('sizes a column to its content, within limits', () => {
        const narrow = measureColumns([['a'], ['b']]);
        // An empty-ish column still has to be wide enough to hold a header.
        expect(narrow[0]).toBeGreaterThanOrEqual(64);

        const wide = measureColumns([['x'.repeat(400)]]);
        // One cell holding a paragraph must not push every other column off
        // the screen.
        expect(wide[0]).toBeLessThanOrEqual(320);

        const mixed = measureColumns([['short', 'a much longer value here']]);
        expect(mixed[1]).toBeGreaterThan(mixed[0]);

        // Rows past the sample are not measured — that is the point of the
        // sample — so a late long value does not re-size the column.
        const sampled = measureColumns([['ab'], ['x'.repeat(100)]], 1);
        expect(sampled[0]).toBe(64);
    });
});

describe('the preview view', () => {
    let OfficeView;
    let container;
    let originalResizeObserver;
    let originalRaf;

    beforeAll(async () => {
        originalResizeObserver = global.ResizeObserver;
        global.ResizeObserver = class {
            constructor() { this.observe = vi.fn(); this.unobserve = vi.fn(); this.disconnect = vi.fn(); }
        };
        // jsdom never paints, so the document's chunked build would stop after
        // the first frame. Run it straight through instead.
        originalRaf = global.requestAnimationFrame;
        global.requestAnimationFrame = (fn) => { fn(); return 1; };
        OfficeView = (await import('../src/modules/views/OfficeView.js')).OfficeView;
    });

    afterAll(() => {
        global.ResizeObserver = originalResizeObserver;
        global.requestAnimationFrame = originalRaf;
    });

    beforeEach(() => {
        document.body.innerHTML = '<div id="pane" style="height:400px"></div>';
        container = document.getElementById('pane');
    });

    const show = (office, path = 'C:/work/book.xlsx') => {
        const view = new OfficeView(container, {});
        const file = { path, content: '', type: 'office', office };
        view.render('', file);
        return { view, file };
    };

    const sheetsPreview = (overrides = {}) => ({
        kind: 'sheets',
        sheets: [
            {
                name: 'Orders',
                rows: [['Item', 'Qty'], ['Bolt', '12']],
                total_rows: 2, total_cols: 2, truncated: false,
            },
            {
                name: 'Notes',
                rows: [['read me']],
                total_rows: 1, total_cols: 1, truncated: false,
            },
        ],
        slides: [], blocks: [],
        ...overrides,
    });

    it('says it is read-only before it says anything else', () => {
        show(sheetsPreview());
        // The one thing a reader must not be wrong about. A grid that looks
        // like the CSV editor and silently drops edits would be worse than no
        // preview at all.
        expect(container.querySelector('.of-badge').textContent).toMatch(/read-only/i);
    });

    it('draws a sheet as a grid with spreadsheet coordinates', () => {
        show(sheetsPreview());
        const head = [...container.querySelectorAll('.of-grid-head .of-col')].map(e => e.textContent);
        expect(head).toEqual(['A', 'B']);

        const rows = [...container.querySelectorAll('.of-row')];
        expect(rows).toHaveLength(2);
        // The gutter carries the sheet's own 1-based row number, so a value
        // seen here can be found again in Excel.
        expect(rows[0].querySelector('.of-gutter').textContent).toBe('1');
        expect(rows[1].querySelector('.of-gutter').textContent).toBe('2');
        expect([...rows[1].querySelectorAll('.of-cell')].map(e => e.textContent))
            .toEqual(['Bolt', '12']);
        // "12" is a quantity; "Bolt" is not.
        expect(rows[1].querySelectorAll('.of-cell')[1].className).toContain('num');
    });

    it('offers every sheet and remembers which one was being read', () => {
        const { view, file } = show(sheetsPreview());
        const tabs = [...container.querySelectorAll('.of-tab')];
        expect(tabs.map(t => t.textContent)).toEqual(['Orders', 'Notes']);
        expect(tabs[0].className).toContain('active');

        tabs[1].click();
        expect(container.querySelector('.of-cell').textContent).toBe('read me');
        // Stored on the tab, not on the view: closing and reopening the pane
        // builds a new view, and landing back on sheet 1 loses the reader's
        // place every time they switch tabs.
        expect(file._officeSheet).toBe(1);
        view.destroy();
    });

    it('says what it is not showing when a sheet was cut short', () => {
        show(sheetsPreview({
            sheets: [{
                name: 'Big', rows: [['a']], total_rows: 90000, total_cols: 1, truncated: true,
            }],
        }));
        const note = container.querySelector('.of-note').textContent;
        expect(note).toContain('90000');
        expect(note).toContain('1');
    });

    it('keeps a slide title apart from its bullets, and its notes out of the way', () => {
        show({
            kind: 'slides',
            sheets: [],
            slides: [
                {
                    number: 1,
                    title: 'Quarter in review',
                    bullets: [{ level: 0, text: 'Revenue up' }, { level: 1, text: 'Mostly EMEA' }],
                    notes: 'Do not read this out.',
                },
                { number: 2, title: '', bullets: [], notes: '' },
            ],
            blocks: [],
        }, 'C:/work/deck.pptx');

        const slides = container.querySelectorAll('.of-slide');
        expect(slides).toHaveLength(2);
        expect(slides[0].querySelector('.of-slide-title').textContent).toBe('Quarter in review');
        const bullets = slides[0].querySelectorAll('.of-bullets li');
        expect([...bullets].map(b => b.textContent)).toEqual(['Revenue up', 'Mostly EMEA']);
        // The authored indent is what makes an outline readable as an outline.
        expect(bullets[1].style.marginLeft).toBe('18px');

        // Notes are collapsed: they are the speaker's, not the reader's.
        const notes = slides[0].querySelector('.of-notes');
        expect(notes.tagName).toBe('DETAILS');
        expect(notes.open).toBe(false);

        // A slide with no title placeholder is normal; an empty heading is not.
        expect(slides[1].querySelector('.of-slide-title').textContent).toMatch(/no title/i);
        expect(slides[1].querySelector('.of-notes')).toBe(null);
        // …and a slide that does have text is never labelled as having none.
        expect(slides[0].querySelector('.of-slide-none')).toBe(null);
        expect(container.querySelector('.of-banner')).toBe(null);
    });

    it('explains an all-image deck instead of showing a column of blank cards', () => {
        // Decks exported one-picture-per-slide are common, and they parse to
        // nothing at all. That is the file, not a failure — but silence reads
        // as a broken preview.
        show({
            kind: 'slides',
            sheets: [],
            slides: [
                { number: 1, title: '', bullets: [], notes: '', pictures: 1 },
                { number: 2, title: '', bullets: [], notes: '', pictures: 4 },
                { number: 3, title: '', bullets: [], notes: '', pictures: 0 },
            ],
            blocks: [],
        }, 'C:/work/scan.pptx');

        expect(container.querySelector('.of-banner').textContent).toMatch(/picture/i);
        const none = [...container.querySelectorAll('.of-slide-none')].map(e => e.textContent);
        // "1 images" is the kind of thing that makes a preview look unfinished.
        expect(none[0]).toBe('One image, no text');
        expect(none[1]).toBe('4 images, no text');
        expect(none[2]).toMatch(/no text/i);
    });

    it('rebuilds a document as headings, prose, lists and tables', () => {
        show({
            kind: 'document',
            sheets: [], slides: [],
            blocks: [
                { kind: 'heading', level: 2, text: 'Scope', rows: [] },
                { kind: 'paragraph', level: 0, text: 'The plan in one line.', rows: [] },
                { kind: 'list', level: 0, text: 'First', rows: [] },
                { kind: 'list', level: 1, text: 'Nested', rows: [] },
                { kind: 'paragraph', level: 0, text: 'After the list.', rows: [] },
                { kind: 'list', level: 0, text: 'A separate list', rows: [] },
                { kind: 'table', level: 0, text: '', rows: [['Name', 'Qty'], ['Bolt', '12']] },
            ],
        }, 'C:/work/spec.docx');

        const doc = container.querySelector('.of-doc');
        expect(doc.querySelector('h2').textContent).toBe('Scope');
        expect(doc.querySelectorAll('.of-doc-p')).toHaveLength(2);

        // Consecutive list blocks are one list; a paragraph between them ends
        // it. Folding them all into a single <ul> would reorder the document.
        const lists = doc.querySelectorAll('.of-doc-list');
        expect(lists).toHaveLength(2);
        expect(lists[0].querySelectorAll('li')).toHaveLength(2);
        expect(lists[1].querySelectorAll('li')).toHaveLength(1);

        // The first table row reads as the header row, which is what Word
        // documents almost always mean by it.
        const table = doc.querySelector('.of-doc-table');
        expect([...table.querySelectorAll('th')].map(e => e.textContent)).toEqual(['Name', 'Qty']);
        expect([...table.querySelectorAll('td')].map(e => e.textContent)).toEqual(['Bolt', '12']);
    });

    it('does not turn a one-row table into a header row', () => {
        // A single-row table is a note box, not a table with a heading. Bold
        // on a tinted background would say something the document does not.
        show({
            kind: 'document',
            sheets: [], slides: [],
            blocks: [{ kind: 'table', level: 0, text: '', rows: [['\u6ce8\u610f', 'Bump instead.']] }],
        }, 'C:/work/note.docx');

        const table = container.querySelector('.of-doc-table');
        expect(table.querySelectorAll('th')).toHaveLength(0);
        expect([...table.querySelectorAll('td')].map(e => e.textContent))
            .toEqual(['\u6ce8\u610f', 'Bump instead.']);
    });

    it('draws only the rows in view, however many the sheet has', () => {
        const rows = Array.from({ length: 4000 }, (_, i) => [`row ${i}`, String(i)]);
        show(sheetsPreview({
            sheets: [{ name: 'Big', rows, total_rows: 4000, total_cols: 2, truncated: false }],
        }));
        // jsdom reports a zero-height container, so this is the buffer alone —
        // which is the assertion that matters: not 4000.
        const drawn = container.querySelectorAll('.of-row').length;
        expect(drawn).toBeGreaterThan(0);
        expect(drawn).toBeLessThan(100);
    });

    it('hands the file to the real application rather than pretending to be one', async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        vi.mocked(invoke).mockClear();

        show(sheetsPreview());
        const btn = [...container.querySelectorAll('.of-btn')]
            .find(b => /office/i.test(b.textContent));
        expect(btn).toBeTruthy();

        btn.click();
        // Through the backend command, NOT the shell plugin's open(): its JS
        // side is scoped to http, tel and mailto, so it refused the path
        // before it reached the shell and the button did nothing at all.
        expect(invoke).toHaveBeenCalledWith('open_office_file', { path: 'C:/work/book.xlsx' });
    });

    it('says so instead of drawing nothing when there is nothing to draw', () => {
        show({ kind: 'sheets', sheets: [], slides: [], blocks: [] });
        expect(container.querySelector('.of-empty').textContent).toMatch(/no sheets/i);
    });
});

/* The wiring in Editor.js decides whether a file is parsed or read as text,
   and whether a tab can be written back. Both are reachable only through the
   whole editor, so they are asserted against the source — the same way
   FileSafety.test.js holds the rest of that file. */
describe('how an Office tab is opened and closed off', () => {
    const editor = read('src/modules/core/Editor.js');

    it('parses the file instead of running it through the encoding detector', () => {
        const open = editor.slice(editor.indexOf('export async function openFile'));
        const branch = open.indexOf('isOfficeFile(resolvedPath)');
        expect(branch).toBeGreaterThan(-1);
        // The branch has to come BEFORE the text read, or the detector gets a
        // zip file first and the tab opens full of mojibake.
        expect(branch).toBeLessThan(open.indexOf('FS.readFileAutoDetect'));
        expect(open).toContain("invoke('read_office_preview'");
    });

    it('refuses to write a file it can only read', () => {
        const save = editor.slice(editor.indexOf('export async function saveFile'));
        const guard = save.indexOf("file.type === 'office'");
        expect(guard).toBeGreaterThan(-1);
        // Before needsSaveLocation(), or an Office tab would be offered a Save
        // As dialog and then write an empty text file over the answer.
        expect(guard).toBeLessThan(save.indexOf('needsSaveLocation(file)'));
    });

    it('does not offer a text view an Office tab cannot go to', () => {
        // file.content is '' for these tabs, so the toggle would land in an
        // empty CodeMirror and look like the file had been wiped.
        const toggle = editor.slice(editor.indexOf("'app:toggle-view-mode'"), editor.indexOf("'md-block:nav'"));
        expect(toggle).toContain("file.type === 'office'");
    });

    it('reopens one with the workspace, since it is a real file on disk', () => {
        expect(read('src/modules/core/Session.js')).toContain("f.type !== 'office'");
        expect(editor).toContain('restoredOfficeTab');
    });

    // Opening a file with its default handler is a shell execute, which for an
    // .exe means running it. The command has to be narrow enough that a path
    // from anywhere else cannot turn it into a launcher.
    it('will only hand the shell a file the preview itself can read', () => {
        const office = read('src-tauri/src/commands/office.rs');
        const cmd = office.slice(office.indexOf('pub fn open_office_file'));
        const body = cmd.slice(0, cmd.indexOf('\n}'));
        expect(body).toContain('is_office_path');
        expect(body).toContain('is_file()');
    });
});
