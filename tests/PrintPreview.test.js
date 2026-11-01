import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    splitHighlightedLines, codeToHtml, printSourceFor, buildPrintDocument,
    showPrintPreview, closePrintPreview, clampScale, stepScale, SCALES,
    pageCountOf, PAGE_W,
} from '../src/modules/ui/PrintPreview.js';
import { highlightCode } from '../src/modules/utils/CMHighlighter.js';
import { SHORTCUTS } from '../src/modules/core/ShortcutDefinitions.js';

const settle = () => new Promise((r) => setTimeout(r, 0));
const overlay = () => document.querySelector('.print-preview-overlay');
const frameDoc = () => document.querySelector('.print-preview-frame').contentDocument;

/* Printing the editor element itself gives one screenful: CodeMirror keeps
   only the visible lines in the DOM. So code is re-rendered line by line, and
   a highlighted token that spans lines must survive being cut. */
describe('splitHighlightedLines', () => {
    it('closes and reopens a token that runs across a newline', () => {
        const lines = splitHighlightedLines('a<span class="tok-comment">/* x\ny */</span>b');
        expect(lines).toEqual([
            'a<span class="tok-comment">/* x</span>',
            '<span class="tok-comment">y */</span>b',
        ]);
    });

    it('keeps empty lines as lines', () => {
        expect(splitHighlightedLines('a\n\nb')).toEqual(['a', '', 'b']);
    });

    it('loses no text from real highlighter output', () => {
        const src = 'const a = `x\ny`;\n/* one\ntwo */\nlet b = 1;';
        const lines = splitHighlightedLines(highlightCode(src, 'js'));
        const text = lines.map((l) => l.replace(/<[^>]+>/g, '')).join('\n')
            .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        expect(text).toBe(src);
        expect(lines).toHaveLength(5);
    });
});

describe('codeToHtml', () => {
    it('numbers every line, without counting the final newline', () => {
        const html = codeToHtml('a\nb\n', 'txt');
        expect(html.match(/class="pp-ln"/g)).toHaveLength(2);
        expect(html).toContain('<span class="pp-ln">2</span>');
    });

    it('leaves numbers out when asked', () => {
        expect(codeToHtml('a\nb', 'txt', { lineNumbers: false })).not.toContain('class="pp-ln"');
    });

    // The document's own text must never become markup in the print frame.
    it('escapes the source', () => {
        const html = codeToHtml('<img src=x onerror=alert(1)>', 'txt');
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });
});

describe('printSourceFor', () => {
    it('prefers a view that knows how to print itself', () => {
        const view = { getPrintContent: () => ({ html: '<p>hi</p>' }) };
        const s = printSourceFor(view, { name: 'a.md' });
        expect(s).toMatchObject({ kind: 'html', html: '<p>hi</p>', title: 'a.md' });
    });

    it('reads the live buffer, not the file as opened', () => {
        const view = { editorView: { state: { doc: { toString: () => 'edited' } } } };
        const s = printSourceFor(view, { path: 'C:/p/x.py', content: 'stale' });
        expect(s).toMatchObject({ kind: 'code', text: 'edited', ext: 'py', title: 'x.py' });
    });

    it('falls back to the file text', () => {
        expect(printSourceFor({}, { name: 'a.csv', content: 'a,b' }).text).toBe('a,b');
    });

    it('has nothing for a binary view', () => {
        expect(printSourceFor({}, { name: 'a.png', content: new Uint8Array(2) })).toBeNull();
        expect(printSourceFor(null, null)).toBeNull();
    });
});

describe('buildPrintDocument', () => {
    it('carries the theme class only when the theme is kept', () => {
        const kept = buildPrintDocument({ title: 't', body: '', keepTheme: true, themeClassList: ['theme-dark'] });
        expect(kept).toMatch(/<body class="theme-dark pp-keep-theme">/);
        const white = buildPrintDocument({ title: 't', body: '', keepTheme: false, themeClassList: ['theme-dark'] });
        expect(white).toMatch(/<body class="pp-white">/);
    });

    // A dark sheet prints as white unless backgrounds are forced, and the app
    // shell's 100vh / overflow:hidden would stop the print after one page.
    it('forces backgrounds and lets the document run past one page', () => {
        const doc = buildPrintDocument({ title: 't', body: '', keepTheme: true });
        expect(doc).toContain('print-color-adjust: exact');
        expect(doc).toContain('overflow: visible !important');
        expect(doc).toContain('box-decoration-break: clone');
    });

    it('switches scripts off and escapes the title', () => {
        const doc = buildPrintDocument({ title: '<script>x</script>', body: '', keepTheme: false });
        expect(doc).toContain(`script-src 'none'`);
        expect(doc).not.toContain('<script>x');
    });
});

describe('showPrintPreview', () => {
    const view = { editorView: { state: { doc: { toString: () => 'line one\nline two' } } } };
    const file = { name: 'a.js' };

    beforeEach(() => {
        localStorage.clear();
        document.body.className = 'theme-dark';
    });
    afterEach(() => {
        closePrintPreview();
        document.body.className = '';
    });

    it('opens with the theme kept by default', async () => {
        expect(showPrintPreview({ view, file })).toBe(true);
        await settle();
        expect(overlay()).not.toBeNull();
        expect(frameDoc().body.className).toBe('theme-dark pp-keep-theme');
        expect(frameDoc().querySelectorAll('.pp-line')).toHaveLength(2);
    });

    it('re-renders on white, and remembers the choice', async () => {
        showPrintPreview({ view, file });
        const white = overlay().querySelector('input[value="white"]');
        white.checked = true;
        white.dispatchEvent(new Event('change'));
        await settle();
        expect(frameDoc().body.className).toBe('pp-white');
        closePrintPreview();

        showPrintPreview({ view, file });
        await settle();
        expect(overlay().querySelector('input[value="white"]').checked).toBe(true);
        expect(frameDoc().body.className).toBe('pp-white');
    });

    it('toggles line numbers', async () => {
        showPrintPreview({ view, file });
        const box = overlay().querySelector('input[type="checkbox"]');
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        await settle();
        expect(frameDoc().querySelector('.pp-ln')).toBeNull();
    });

    it('prints the frame, and Ctrl+P inside the preview prints instead of reopening', async () => {
        showPrintPreview({ view, file });
        const win = document.querySelector('.print-preview-frame').contentWindow;
        const print = vi.fn();
        win.print = print;

        const e = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
        overlay().querySelector('button.primary').dispatchEvent(e);
        await settle(); await settle();
        expect(e.defaultPrevented).toBe(true);
        expect(print).toHaveBeenCalledOnce();
        expect(document.querySelectorAll('.print-preview-overlay')).toHaveLength(1);

        win.dispatchEvent(new Event('afterprint'));
        await settle();
        expect(overlay()).toBeNull();
    });

    it('Escape closes it', () => {
        showPrintPreview({ view, file });
        document.querySelector('.print-preview button').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(overlay()).toBeNull();
    });

    it('says so when there is nothing to print', () => {
        expect(showPrintPreview({ view: {}, file: { name: 'a.png', content: null } })).toBe(false);
        expect(overlay()).toBeNull();
    });
});

/* Smaller text means more on each line and more lines on each page, so the
   size is a real re-flow of the sheet — not a picture shrunk after layout. */
describe('text size', () => {
    it('snaps to the offered sizes and stops at either end', () => {
        expect(clampScale(73)).toBe(70);
        expect(clampScale('garbage')).toBe(100);
        expect(stepScale(100, -1)).toBe(90);
        expect(stepScale(SCALES[0], -1)).toBe(SCALES[0]);
        expect(stepScale(SCALES[SCALES.length - 1], 1)).toBe(SCALES[SCALES.length - 1]);
    });

    it('zooms the sheet inside the page margins', () => {
        const doc = buildPrintDocument({ title: 't', body: 'x', keepTheme: false, scale: 70 });
        expect(doc).toContain('<div class="pp-sheet" style="zoom:0.7;--pp-z:0.7">x</div>');
    });

    describe('in the preview', () => {
        const view = { editorView: { state: { doc: { toString: () => 'a' } } } };
        const sheet = () => frameDoc().querySelector('.pp-sheet');
        const stepper = () => [...overlay().querySelectorAll('.print-preview-scale button')];
        const key = (k) => {
            const e = new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true });
            stepper()[1].dispatchEvent(e);
            return e;
        };
        beforeEach(() => localStorage.clear());
        afterEach(() => closePrintPreview());

        it('steps with the buttons and the keys, and keeps them from WebView2', () => {
            showPrintPreview({ view, file: { name: 'a.txt' } });
            expect(sheet().style.zoom).toBe('1');
            const [smaller, value, larger] = stepper();
            smaller.click();
            expect(sheet().style.zoom).toBe('0.9');
            expect(key('-').defaultPrevented).toBe(true);
            expect(sheet().style.zoom).toBe('0.8');
            expect(value.textContent).toBe('80%');
            larger.click();
            key('=');
            expect(sheet().style.zoom).toBe('1');
            key('-');
            key('0');
            expect(sheet().style.zoom).toBe('1');
            smaller.click();
            value.click();   // the value itself resets
            expect(value.textContent).toBe('100%');
        });

        it('remembers the size and survives a colour change', async () => {
            showPrintPreview({ view, file: { name: 'a.txt' } });
            const [smaller] = stepper();
            for (let i = 0; i < 4; i++) smaller.click();   // 100 → 60
            const white = overlay().querySelector('input[value="white"]');
            white.checked = true;
            white.dispatchEvent(new Event('change'));
            await settle();
            expect(sheet().style.zoom).toBe('0.6');
            closePrintPreview();
            showPrintPreview({ view, file: { name: 'a.txt' } });
            expect(sheet().style.zoom).toBe('0.6');
        });
    });
});

/* The preview shows one whole sheet and turns pages; it never scrolls. */
describe('pages', () => {
    it('counts sheets from the paginated width', () => {
        expect(pageCountOf(0)).toBe(1);
        expect(pageCountOf(PAGE_W)).toBe(1);
        expect(pageCountOf(PAGE_W * 3 - 57)).toBe(3);   // last column ends before its margin
        expect(pageCountOf(PAGE_W * 3)).toBe(3);
    });

    it('turns pages with the buttons and PageUp / PageDown, inside the bounds', () => {
        showPrintPreview({ view: { editorView: { state: { doc: { toString: () => 'a' } } } }, file: { name: 'a.txt' } });
        // jsdom has no layout; give the frame three sheets' worth of width.
        Object.defineProperty(frameDoc().documentElement, 'scrollWidth', { configurable: true, value: PAGE_W * 3 });
        const [prev, next] = [...overlay().querySelectorAll('.print-preview-nav button')];
        overlay().querySelector('.print-preview-scale button').click();   // any re-layout re-reads the count
        overlay().querySelector('.print-preview-scale button:last-child').click();
        const no = () => overlay().querySelector('.print-preview-pageno').textContent;
        expect(no()).toBe('1 / 3');
        expect(prev.disabled).toBe(true);
        next.click();
        expect(no()).toBe('2 / 3');
        const pd = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true });
        next.dispatchEvent(pd);
        expect(pd.defaultPrevented).toBe(true);
        expect(no()).toBe('3 / 3');
        expect(next.disabled).toBe(true);
        next.click();
        expect(no()).toBe('3 / 3');
        prev.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }));
        expect(no()).toBe('2 / 3');
        closePrintPreview();
    });
});

describe('Ctrl+P', () => {
    it('prints, and file search keeps Ctrl+Shift+R', () => {
        const g = SHORTCUTS.GLOBAL;
        const ctrlP = g.filter((s) => s.key === 'p' && s.ctrl && !s.shift && !s.alt);
        expect(ctrlP.map((s) => s.cmd)).toEqual(['app:print']);
        expect(g.some((s) => s.key === 'r' && s.ctrl && s.shift && s.cmd === 'app:file-search')).toBe(true);
    });
});
