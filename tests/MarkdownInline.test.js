import { describe, it, expect, vi, afterEach } from 'vitest';
import { inlineHtml, inlineText } from '../src/modules/utils/MarkdownInline.js';
import { TableEditor } from '../src/modules/editors/TableEditor.js';

// A copied table goes to a program that does not read Markdown, so the marks
// have to become formatting in the HTML and disappear from the plain text.

describe('a table cell, read for copying', () => {
    it.each([
        ['**テキスト**', '<b>テキスト</b>', 'テキスト'],
        ['__bold__', '<b>bold</b>', 'bold'],
        ['*保存して解決済みにする* で進む', '<i>保存して解決済みにする</i> で進む', '保存して解決済みにする で進む'],
        ['_word_', '<i>word</i>', 'word'],
        ['~~old~~', '<s>old</s>', 'old'],
        ['**a *b* c**', '<b>a <i>b</i> c</b>', 'a b c'],
    ])('reads %s', (source, html, text) => {
        expect(inlineHtml(source)).toBe(html);
        expect(inlineText(source)).toBe(text);
    });

    it('keeps code as code, with the marks inside it left alone', () => {
        expect(inlineText('`**x**` and `F2`')).toBe('**x** and F2');
        expect(inlineHtml('`a<b`')).toContain('>a&lt;b</code>');
    });

    it('links only what can be opened from another program', () => {
        expect(inlineHtml('[site](https://example.com/a)')).toBe('<a href="https://example.com/a">site</a>');
        expect(inlineText('[site](https://example.com/a)')).toBe('site');
        expect(inlineHtml('[App.js.md](./App.js.md)')).toBe('App.js.md');
        expect(inlineHtml('[x](javascript:alert(1))')).not.toContain('<a');
        expect(inlineText('![a chart](c.png)')).toBe('a chart');
    });

    it('keeps a line break inside the cell, and off the plain text row', () => {
        expect(inlineHtml('a<br>b')).toBe('a<br style="mso-data-placement:same-cell;">b');
        expect(inlineText('a<br/>b')).toBe('a b');
    });

    it('leaves alone what only looks like a mark', () => {
        for (const text of ['2 * 3 * 4', 'snake_case_name', 'a ** b', '100%', '[not a link]', '*open']) {
            expect(inlineText(text)).toBe(text);
        }
        expect(inlineText('a\\|b \\*c\\*')).toBe('a|b *c*');
    });

    it('lets no other markup through', () => {
        const html = inlineHtml('<script>x</script> <img src=a onerror=b> **"q"**');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        expect(html).toContain('<b>&quot;q&quot;</b>');
    });

    it('takes an empty cell', () => {
        expect(inlineHtml('')).toBe('');
        expect(inlineText(null)).toBe('');
    });
});

describe('copying a whole table', () => {
    const original = {
        clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
        item: global.ClipboardItem,
    };

    afterEach(() => {
        if (original.clipboard) Object.defineProperty(navigator, 'clipboard', original.clipboard);
        else delete navigator.clipboard;
        global.ClipboardItem = original.item;
    });

    it('writes formatting to the HTML and leaves the marks out of the text', async () => {
        const written = {};
        global.ClipboardItem = class { constructor(parts) { Object.assign(written, parts); } };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: vi.fn(async () => {}) } });
        const read = (blob) => new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsText(blob);
        });

        expect(await TableEditor.copyToClipboard([['**モード**', '内容'], ['**差分**', '`Alt+R` で再比較']])).toBe(true);

        const html = await read(written['text/html']);
        expect(html).toContain('<b>差分</b>');
        expect(html).toContain('>Alt+R</code>');
        expect(html).not.toContain('**');
        expect(await read(written['text/plain'])).toBe('モード\t内容\n差分\tAlt+R で再比較');
    });
});
