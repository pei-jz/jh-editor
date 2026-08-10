import { describe, it, expect, beforeEach, vi } from 'vitest';

// Tauri's asset-protocol mapper and the byte writer are backend calls; stub
// both so the *logic* (path building, naming, embed fallback) can be asserted.
vi.mock('@tauri-apps/api/core', () => ({
    convertFileSrc: (p) => `asset://localhost/${encodeURI(p)}`,
}));

const writeFileBytes = vi.fn(async () => {});
vi.mock('../src/modules/utils/FileSystem.js', () => ({
    writeFileBytes: (...a) => writeFileBytes(...a),
    getParentDir: (p) => String(p).replace(/\\/g, '/').replace(/\/[^/]*$/, ''),
}));

const { State } = await import('../src/modules/core/Store.js');
const {
    saveImageForDocument, resolveImageSrc, setEmbedMode, setAssetDirName,
} = await import('../src/modules/utils/MarkdownAssets.js');

const pngBlob = () => ({
    type: 'image/png',
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
});

describe('MarkdownAssets — saving a pasted image', () => {
    beforeEach(() => {
        localStorage.clear();
        writeFileBytes.mockClear();
        State.currentDir = '/ws';
    });

    it('writes the file next to the document and returns a relative link', async () => {
        const md = await saveImageForDocument(pngBlob(), '/ws/notes/a.md');

        expect(writeFileBytes).toHaveBeenCalledTimes(1);
        const [target, bytes] = writeFileBytes.mock.calls[0];
        expect(target).toMatch(/^\/ws\/notes\/assets\/clip-\d{8}-\d{6}\.png$/);
        expect(Array.from(bytes)).toEqual([1, 2, 3]);

        // The link must stay RELATIVE so the note remains portable.
        expect(md).toMatch(/^!\[clip-\d{8}-\d{6}\]\(assets\/clip-\d{8}-\d{6}\.png\)$/);
    });

    it('honours a custom asset folder', async () => {
        setAssetDirName('images');
        const md = await saveImageForDocument(pngBlob(), '/ws/a.md');
        expect(writeFileBytes.mock.calls[0][0]).toContain('/ws/images/');
        expect(md).toContain('(images/');
    });

    it.each([
        ['image/jpeg', 'jpg'],
        ['image/gif', 'gif'],
        ['image/webp', 'webp'],
        ['image/svg+xml', 'svg'],
        ['image/png', 'png'],
        ['', 'png'],
    ])('derives the extension from %s', async (mime, ext) => {
        const blob = { type: mime, arrayBuffer: async () => new Uint8Array([0]).buffer };
        await saveImageForDocument(blob, '/ws/a.md');
        expect(writeFileBytes.mock.calls[0][0].endsWith(`.${ext}`)).toBe(true);
    });

    it('embeds as a data URI when the document has no path yet', async () => {
        const md = await saveImageForDocument(pngBlob(), null);
        expect(writeFileBytes).not.toHaveBeenCalled();
        expect(md).toMatch(/^!\[image\]\(data:image\/png;base64,[A-Za-z0-9+/=]+\)$/);
    });

    it('embeds when the user opted into embed mode', async () => {
        setEmbedMode(true);
        const md = await saveImageForDocument(pngBlob(), '/ws/a.md');
        expect(writeFileBytes).not.toHaveBeenCalled();
        expect(md).toContain('data:image/png;base64,');
    });

    it('base64-encodes large images without blowing the call stack', async () => {
        const big = new Uint8Array(200000).fill(65);
        const blob = { type: 'image/png', arrayBuffer: async () => big.buffer };
        setEmbedMode(true);
        const md = await saveImageForDocument(blob, null);
        expect(md.length).toBeGreaterThan(200000);
    });
});

describe('MarkdownAssets — resolving image sources for display', () => {
    beforeEach(() => { State.currentDir = '/ws'; });

    it('maps a relative path through the asset protocol, based on the doc folder', () => {
        expect(resolveImageSrc('assets/a.png', '/ws/notes/a.md'))
            .toBe('asset://localhost//ws/notes/assets/a.png');
    });

    it('falls back to the workspace root when the doc has no path', () => {
        expect(resolveImageSrc('a.png', null)).toBe('asset://localhost//ws/a.png');
    });

    it('maps an absolute path as-is', () => {
        expect(resolveImageSrc('/tmp/a.png', '/ws/a.md')).toBe('asset://localhost//tmp/a.png');
        expect(resolveImageSrc('C:/x/a.png', '/ws/a.md')).toBe('asset://localhost/C:/x/a.png');
    });

    it('normalises Windows separators', () => {
        expect(resolveImageSrc('assets\\a.png', '/ws/a.md')).toContain('/ws/assets/a.png');
    });

    it.each(['https://x/a.png', 'http://x/a.png', 'data:image/png;base64,AA', 'blob:abc', 'asset://x'])(
        'leaves %s untouched', (src) => {
            expect(resolveImageSrc(src, '/ws/a.md')).toBe(src);
        });

    it('passes through empty input', () => {
        expect(resolveImageSrc('', '/ws/a.md')).toBe('');
        expect(resolveImageSrc(null, '/ws/a.md')).toBe('');
    });
});
