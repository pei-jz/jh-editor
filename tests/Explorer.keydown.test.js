import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// The VirtualExplorer class is module-private, but initExplorer() wires up a
// real #file-list container (matching index.html) and its keydown handler
// (bound on the container) stamps every keydown that reaches the explorer with
// `e.__explorerKeyDown = true`. The markdown views' window-level CAPTURE
// handlers (which run AFTER ShortcutManager dispatched explorer:nav) use that
// stamp to detect "the explorer already owns this key" — critical because the
// virtual-scroll render (setFocus → render → contentHost.innerHTML='')
// synchronously detaches the focused row, so e.target.closest('#explorer')
// returns null by the time they run.
//
// Constants.js caches `EL` at import time, so the DOM must exist BEFORE the
// module loads — hence the dynamic import below.

describe('Explorer keydown event stamping', () => {
    let Explorer;
    let container;
    let originalResizeObserver;

    beforeAll(async () => {
        originalResizeObserver = global.ResizeObserver;
        global.ResizeObserver = class {
            constructor() { this.observe = vi.fn(); this.unobserve = vi.fn(); this.disconnect = vi.fn(); }
        };

        document.body.innerHTML = `
            <div id="explorer">
                <div id="explorer-files-panel">
                    <input id="explorer-search" type="text" />
                    <div id="file-list"></div>
                </div>
            </div>
        `;
        container = document.getElementById('file-list');
        Explorer = await import('../src/modules/core/Explorer.js');
        await Explorer.initExplorer(() => {}, {});
    });

    afterAll(() => {
        global.ResizeObserver = originalResizeObserver;
        document.body.innerHTML = '';
    });

    it('stamps the event when the explorer handles a keydown', () => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        container.dispatchEvent(e);
        expect(e.__explorerKeyDown).toBe(true);
    });

    it('stamps arrow keys regardless of modifier combos the explorer owns', () => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
        container.dispatchEvent(e);
        expect(e.__explorerKeyDown).toBe(true);
    });

    it('leaves unrelated keydowns unstamped', () => {
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        outside.dispatchEvent(e);
        expect(e.__explorerKeyDown).toBeUndefined();
        outside.remove();
    });
});
