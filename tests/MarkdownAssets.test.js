import { describe, it, expect, beforeEach } from 'vitest';
import {
    expandWikiLinks, extractWikiLinks,
    hasMath,
    getAssetDirName, setAssetDirName,
    isEmbedMode, setEmbedMode,
    extractImageBlob,
} from '../src/modules/utils/MarkdownAssets.js';

describe('MarkdownAssets — wiki links', () => {
    it('expands [[Note]] into a .md link', () => {
        expect(expandWikiLinks('see [[Design]] here')).toBe('see [Design](Design.md) here');
    });

    it('supports [[target|label]]', () => {
        expect(expandWikiLinks('[[api/Spec|API仕様]]')).toBe('[API仕様](api/Spec.md)');
    });

    it('keeps an explicit extension instead of appending .md', () => {
        expect(expandWikiLinks('[[diagram.png]]')).toBe('[diagram.png](diagram.png)');
    });

    it('handles several links on one line', () => {
        expect(expandWikiLinks('[[A]] and [[B]]')).toBe('[A](A.md) and [B](B.md)');
    });

    it('trims surrounding whitespace in the target', () => {
        expect(expandWikiLinks('[[  Spaced Note  ]]')).toBe('[Spaced Note](Spaced Note.md)');
    });

    it('leaves ordinary text and single brackets alone', () => {
        const s = 'array[0] and [link](x.md) and [[unclosed';
        expect(expandWikiLinks(s)).toBe(s);
    });

    it('is a no-op on empty / null input', () => {
        expect(expandWikiLinks('')).toBe('');
        expect(expandWikiLinks(null)).toBe(null);
    });

    it('extracts targets, normalising to file names', () => {
        expect(extractWikiLinks('[[A]] x [[b/c|label]] y [[d.txt]]'))
            .toEqual(['A.md', 'b/c.md', 'd.txt']);
    });

    it('extracts nothing when there are no links', () => {
        expect(extractWikiLinks('plain text')).toEqual([]);
        expect(extractWikiLinks('')).toEqual([]);
    });

    it('is stateless across calls (regex lastIndex is reset)', () => {
        const s = '[[A]] [[B]]';
        expect(extractWikiLinks(s)).toEqual(extractWikiLinks(s));
    });
});

describe('MarkdownAssets — math detection', () => {
    it('detects display math', () => {
        expect(hasMath('text $$x^2 + y^2$$ more')).toBe(true);
    });

    it('detects inline math', () => {
        expect(hasMath('the value $a_1$ here')).toBe(true);
    });

    it('ignores plain text and lone dollar signs', () => {
        expect(hasMath('costs $5 today')).toBe(false);
        expect(hasMath('no math at all')).toBe(false);
        expect(hasMath('')).toBe(false);
    });

    it('ignores an escaped dollar', () => {
        expect(hasMath('price is \\$100')).toBe(false);
    });
});

describe('MarkdownAssets — settings', () => {
    beforeEach(() => localStorage.clear());

    it('defaults the asset folder to "assets"', () => {
        expect(getAssetDirName()).toBe('assets');
    });

    it('persists a custom asset folder', () => {
        setAssetDirName('images');
        expect(getAssetDirName()).toBe('images');
    });

    it('strips path separators from the folder name', () => {
        setAssetDirName('a/b:c*?');
        expect(getAssetDirName()).toBe('abc');
    });

    it('defaults embed mode off (external files are the sane default)', () => {
        expect(isEmbedMode()).toBe(false);
        setEmbedMode(true);
        expect(isEmbedMode()).toBe(true);
        setEmbedMode(false);
        expect(isEmbedMode()).toBe(false);
    });
});

describe('MarkdownAssets — image extraction from events', () => {
    it('finds an image among clipboard items', () => {
        const file = new File(['x'], 'a.png', { type: 'image/png' });
        const e = { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } };
        expect(extractImageBlob(e)).toBe(file);
    });

    it('ignores non-image clipboard content', () => {
        const e = { clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } };
        expect(extractImageBlob(e)).toBeNull();
    });

    it('falls back to dataTransfer.files for drops', () => {
        const file = new File(['x'], 'a.gif', { type: 'image/gif' });
        const e = { dataTransfer: { files: [file] } };
        expect(extractImageBlob(e)).toBe(file);
    });

    it('returns null when the event carries nothing', () => {
        expect(extractImageBlob({})).toBeNull();
    });
});
