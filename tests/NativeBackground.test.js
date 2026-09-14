import { describe, it, expect, vi, beforeEach } from 'vitest';

const windowSetBackground = vi.fn(async () => {});
const webviewSetBackground = vi.fn(async () => {});

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ setBackgroundColor: (...a) => windowSetBackground(...a) }),
}));
vi.mock('@tauri-apps/api/webview', () => ({
    getCurrentWebview: () => ({ setBackgroundColor: (...a) => webviewSetBackground(...a) }),
}));

const { syncNativeBackground } = await import('../src/modules/utils/NativeBackground.js');

beforeEach(() => {
    windowSetBackground.mockReset().mockResolvedValue(undefined);
    webviewSetBackground.mockReset().mockResolvedValue(undefined);
    document.body.style.backgroundColor = '';
});

describe('syncNativeBackground', () => {
    it("paints the window and the webview in the page's background colour", async () => {
        document.body.style.backgroundColor = 'rgb(30, 30, 30)';
        await syncNativeBackground();
        expect(windowSetBackground).toHaveBeenCalledWith([30, 30, 30, 255]);
        expect(webviewSetBackground).toHaveBeenCalledWith([30, 30, 30, 255]);
    });

    it('does nothing when the page has no usable colour', async () => {
        document.body.style.backgroundColor = 'transparent';
        await syncNativeBackground();
        expect(windowSetBackground).not.toHaveBeenCalled();
        expect(webviewSetBackground).not.toHaveBeenCalled();
    });

    it('still reaches the webview when the window refuses', async () => {
        // e.g. the permission is missing, or the app runs outside Tauri.
        document.body.style.backgroundColor = 'rgb(248, 249, 250)';
        windowSetBackground.mockRejectedValue(new Error('not allowed'));
        await expect(syncNativeBackground()).resolves.toBeUndefined();
        expect(webviewSetBackground).toHaveBeenCalledWith([248, 249, 250, 255]);
    });

    it('never throws when the webview refuses too', async () => {
        document.body.style.backgroundColor = 'rgb(1, 2, 3)';
        windowSetBackground.mockRejectedValue(new Error('no'));
        webviewSetBackground.mockRejectedValue(new Error('no'));
        await expect(syncNativeBackground()).resolves.toBeUndefined();
    });
});
