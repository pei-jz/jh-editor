import { describe, it, expect, beforeEach, vi } from 'vitest';

// The Tauri HTTP plugin is unavailable in jsdom — stub it and assert what
// smartFetch hands to it (the proxy wiring is the actual logic here).
const tauriFetch = vi.fn(async () => ({ ok: true }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a) => tauriFetch(...a) }));

const { smartFetch } = await import('../src/modules/utils/Network.js');

describe('Network.smartFetch', () => {
    beforeEach(() => {
        localStorage.clear();
        tauriFetch.mockClear();
        tauriFetch.mockImplementation(async () => ({ ok: true }));
    });

    it('passes the request through untouched when no proxy is configured', async () => {
        await smartFetch('https://example.com', { method: 'GET' });
        const [url, opts] = tauriFetch.mock.calls[0];
        expect(url).toBe('https://example.com');
        expect(opts.method).toBe('GET');
        expect(opts.proxy).toBeUndefined();
    });

    it('adds the proxy when it is enabled AND set', async () => {
        localStorage.setItem('settings_proxyEnabled', 'true');
        localStorage.setItem('settings_proxy', 'http://proxy:8080');
        await smartFetch('https://example.com');
        expect(tauriFetch.mock.calls[0][1].proxy).toEqual({ all: 'http://proxy:8080' });
    });

    it('ignores an enabled-but-empty proxy setting', async () => {
        localStorage.setItem('settings_proxyEnabled', 'true');
        localStorage.setItem('settings_proxy', '');
        await smartFetch('https://example.com');
        expect(tauriFetch.mock.calls[0][1].proxy).toBeUndefined();
    });

    it('ignores a configured proxy while it is disabled', async () => {
        localStorage.setItem('settings_proxyEnabled', 'false');
        localStorage.setItem('settings_proxy', 'http://proxy:8080');
        await smartFetch('https://example.com');
        expect(tauriFetch.mock.calls[0][1].proxy).toBeUndefined();
    });

    it('does not mutate the caller\'s options object', async () => {
        localStorage.setItem('settings_proxyEnabled', 'true');
        localStorage.setItem('settings_proxy', 'http://proxy:8080');
        const opts = { method: 'POST' };
        await smartFetch('https://example.com', opts);
        expect(opts.proxy).toBeUndefined();
    });

    it('returns the response from the underlying fetch', async () => {
        tauriFetch.mockImplementation(async () => ({ ok: true, status: 204 }));
        await expect(smartFetch('https://example.com')).resolves.toEqual({ ok: true, status: 204 });
    });

    it('propagates errors instead of swallowing them', async () => {
        tauriFetch.mockImplementation(async () => { throw new Error('offline'); });
        await expect(smartFetch('https://example.com')).rejects.toThrow('offline');
    });

    it('is exposed on window for manual use', () => {
        expect(typeof window.smartFetch).toBe('function');
    });
});
