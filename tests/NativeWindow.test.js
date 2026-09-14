import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCssColor } from '../src/modules/utils/NativeBackground.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('parseCssColor', () => {
    it('reads computed rgb() and rgba() values as an opaque tuple', () => {
        expect(parseCssColor('rgb(30, 30, 30)')).toEqual([30, 30, 30, 255]);
        // WebView2 takes only fully opaque or fully transparent; transparent
        // would bring the white back, so alpha is always forced to 255.
        expect(parseCssColor('rgba(248, 249, 250, 0.5)')).toEqual([248, 249, 250, 255]);
        expect(parseCssColor('rgb(15 17 26)')).toEqual([15, 17, 26, 255]);
    });

    it('returns null for values it cannot use', () => {
        // A computed "no background" is transparent black, not black.
        expect(parseCssColor('rgba(0, 0, 0, 0)')).toBeNull();
        expect(parseCssColor('')).toBeNull();
        expect(parseCssColor('transparent')).toBeNull();
        expect(parseCssColor(undefined)).toBeNull();
    });
});

/* Structural: Rust and JSON config cannot be executed from vitest. */
describe('WebView2 browser arguments', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    const windowRs = read('src-tauri/src/commands/window.rs');
    const rustArgs = (/pub const WEBVIEW2_BROWSER_ARGS: &str =\s*"([^"]+)"/.exec(windowRs) || [])[1];

    it('are identical for the main window and windows opened later', () => {
        // Webviews sharing a user data folder must use the same environment
        // options; a mismatch makes every second window fail to open.
        expect(rustArgs).toBeTruthy();
        expect(conf.app.windows[0].additionalBrowserArgs).toBe(rustArgs);
        expect(windowRs).toMatch(/\.additional_browser_args\(WEBVIEW2_BROWSER_ARGS\)/);
    });

    it("keep wry's defaults, which any explicit value replaces", () => {
        for (const feature of ['msWebOOUI', 'msPdfOOUI', 'msSmartScreenProtection']) {
            expect(rustArgs).toContain(feature);
        }
    });

    it('turn off occlusion tracking so a covered window keeps its frames', () => {
        expect(rustArgs).toContain('CalculateNativeWinOcclusion');
    });

    it('the frontend is allowed to set the native background colour', () => {
        const caps = JSON.parse(read('src-tauri/capabilities/default.json'));
        expect(caps.permissions).toContain('core:window:allow-set-background-color');
        expect(caps.permissions).toContain('core:webview:allow-set-webview-background-color');
    });
});
