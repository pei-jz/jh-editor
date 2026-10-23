import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    PROSE_FONTS, DEFAULT_PROSE_FONT, getProseFont, setProseFont, applyProseFont, normalizeProseFont,
    getProseSize, setProseSize, normalizeProseSize, stepProseSize, MIN_PROSE_PT, MAX_PROSE_PT,
} from '../src/modules/utils/ProseFont.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/* The face rendered Markdown is set in is a reader's choice: what one reader
   finds easiest another finds hard going. The default stays in the
   stylesheet, where :lang() gives Chinese and Korean their own faces. */
describe('the document font setting', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.style.removeProperty('--font-body');
    });

    it('defaults to the stylesheet face', () => {
        expect(getProseFont()).toBe(DEFAULT_PROSE_FONT);
        expect(PROSE_FONTS[DEFAULT_PROSE_FONT]).toBeNull();
    });

    it('writes a chosen face over the stylesheet, and stores it', () => {
        expect(setProseFont('ud-kyokasho')).toBe('ud-kyokasho');
        expect(localStorage.getItem('settings_proseFont')).toBe('ud-kyokasho');
        expect(document.documentElement.style.getPropertyValue('--font-body')).toContain('UD Digi Kyokasho');
    });

    it('removes the override for the default, so :lang() still applies', () => {
        applyProseFont('mincho');
        applyProseFont(DEFAULT_PROSE_FONT);
        expect(document.documentElement.style.getPropertyValue('--font-body')).toBe('');
    });

    it('treats an unknown stored value as the default', () => {
        localStorage.setItem('settings_proseFont', 'comic-sans');
        expect(getProseFont()).toBe(DEFAULT_PROSE_FONT);
        expect(normalizeProseFont(undefined)).toBe(DEFAULT_PROSE_FONT);
    });

    it('offers every face in the settings screen, and names each in every language', () => {
        const html = read('index.html');
        const select = html.slice(html.indexOf('id="prose-font-selector"'), html.indexOf('</select>', html.indexOf('id="prose-font-selector"')));
        const keys = [];
        for (const id of Object.keys(PROSE_FONTS)) {
            const m = new RegExp(`<option value="${id}" data-i18n="([^"]+)"`).exec(select);
            expect(m, id).toBeTruthy();
            keys.push(m[1]);
        }
        keys.push('Document Font (Markdown)');
        for (const lang of ['ja', 'zh', 'ko']) {
            const dict = read(`src/locales/${lang}.js`);
            for (const k of keys) expect(dict, `${lang}: ${k}`).toContain(`'${k}':`);
        }
    });

    it('is applied at start-up', () => {
        expect(read('src/modules/core/Layout.js')).toMatch(/applyProseFont\(getProseFont\(\)\)/);
        expect(read('src/modules/core/Layout.js')).toMatch(/applyProseSize\(getProseSize\(\)\)/);
    });
});

/* The 15px floor keeps the DEFAULT readable when the code size is small. It is
   not a limit on the reader: a size set here is taken as given, smaller too. */
describe('the document font size setting', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.style.removeProperty('--prose-font-size');
    });

    it('is automatic until set', () => {
        expect(getProseSize()).toBeNull();
    });

    it('takes a size below the automatic floor as given', () => {
        expect(setProseSize('9')).toBe(9);
        expect(localStorage.getItem('settings_proseFontSize')).toBe('9');
        expect(document.documentElement.style.getPropertyValue('--prose-font-size')).toBe('9pt');
    });

    it('goes back to automatic when cleared', () => {
        setProseSize('9');
        expect(setProseSize('')).toBeNull();
        expect(localStorage.getItem('settings_proseFontSize')).toBeNull();
        expect(document.documentElement.style.getPropertyValue('--prose-font-size')).toBe('');
    });

    it('keeps a size inside the field limits', () => {
        expect(normalizeProseSize('2')).toBe(MIN_PROSE_PT);
        expect(normalizeProseSize('99')).toBe(MAX_PROSE_PT);
        expect(normalizeProseSize('10.3')).toBe(10.5);
        expect(normalizeProseSize('abc')).toBeNull();
    });

    it('steps from the size on screen with the wheel, past the automatic floor', () => {
        setProseSize('11');
        expect(stepProseSize(-0.5)).toBe(10.5);
        expect(stepProseSize(-0.5)).toBe(10);
        expect(stepProseSize(+0.5)).toBe(10.5);
    });

    it('sizes the document, not the code, when the wheel is over a document', () => {
        const layout = read('src/modules/core/Layout.js');
        expect(layout).toMatch(/closest\('\.md-body, \.markdown-mode'\)/);
        expect(layout).toMatch(/stepProseSize\(/);
        // ...and the book drops heights measured at the old size.
        expect(read('src/modules/views/MarkdownView.js')).toMatch(/_onFontChange[\s\S]{0,600}this\._blockHeightCache = null;/);
    });

    it('labels the field in every language', () => {
        for (const lang of ['ja', 'zh', 'ko']) {
            const dict = read(`src/locales/${lang}.js`);
            expect(dict).toContain("'Document Font Size (pt)':");
            expect(dict).toContain("'Automatic (editor size + 1.5, at least 15px)':");
        }
    });
});
