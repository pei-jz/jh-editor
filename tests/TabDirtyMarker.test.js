import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn(), watch: vi.fn() }));
vi.mock('../src/modules/ui/Dialog.js', () => ({
    showAlert: vi.fn(async () => true),
    showConfirm: vi.fn(async () => false),
    showDialog: vi.fn(async () => 'cancel'),
}));

// The first renderTabs watches the strip for overflow; jsdom has no observer.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

// EL captures the tab strip at import time, so it has to exist first. The
// scroll buttons renderTabs adds are inserted around these, inside #tab-bar.
document.body.innerHTML = '<div id="tab-bar"><div id="tabs-container"></div><button id="new-tab-btn"></button></div>';

const { renderTabs, setFileEol } = await import('../src/modules/core/Editor.js');
const { State } = await import('../src/modules/core/Store.js');
const { markSaved } = await import('../src/modules/utils/DirtyState.js');

const LONG = 'a-very-long-file-name-that-will-certainly-not-fit-in-a-tab-2026-09-14.xml';

const tabsContainer = () => document.getElementById('tabs-container');

describe('tab dirty marker', () => {
    beforeEach(() => {
        State.splitMode = false;
        State.rightOpenFiles = [];
        State.activeTabIndex = 0;
    });

    it('is its own element after the title, so the ellipsis cannot cut it', () => {
        State.openFiles = [{ path: `C:/proj/${LONG}`, content: '', isDirty: true }];
        renderTabs('left');
        const tab = tabsContainer().querySelector('.tab');
        const title = tab.querySelector('.tab-title');
        const mark = tab.querySelector('.tab-dirty');
        expect(title.textContent).toBe(LONG);
        expect(mark).not.toBeNull();
        expect(mark.textContent).toBe('*');
        expect(title.nextElementSibling).toBe(mark);
        // Long names get cut short, so the full path is on hover.
        expect(tab.title).toBe(`C:/proj/${LONG}`);
    });

    it('is absent on a clean tab', () => {
        State.openFiles = [{ path: 'C:/proj/a.xml', content: '', isDirty: false }];
        renderTabs('left');
        expect(tabsContainer().querySelector('.tab-dirty')).toBeNull();
        expect(tabsContainer().querySelector('.tab-title').textContent).toBe('a.xml');
    });

    it('the stylesheet keeps the marker from shrinking', async () => {
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const { dirname, join } = await import('node:path');
        const here = dirname(fileURLToPath(import.meta.url));
        const css = readFileSync(join(here, '..', 'src/styles/layout.css'), 'utf8');
        expect(css).toMatch(/\.tab-dirty\s*\{[^}]*flex-shrink:\s*0/);
    });
});

describe('setFileEol', () => {
    it('changing the line ending back to the saved one clears the mark', () => {
        const file = { path: 'C:/proj/a.txt', content: 'x\ny', eol: '\r\n', isDirty: false };
        markSaved(file);
        State.splitMode = false;
        State.openFiles = [file];
        State.activeTabIndex = 0;

        setFileEol('\n');
        expect(file.isDirty).toBe(true);
        setFileEol('\r\n');
        expect(file.isDirty).toBe(false);
    });

    it('does not clear a buffer whose text was also edited', () => {
        const file = { path: 'C:/proj/a.txt', content: 'x\ny', eol: '\r\n', isDirty: false };
        markSaved(file);
        file.content = 'x\ny\nz';
        file.isDirty = true;
        State.openFiles = [file];
        State.activeTabIndex = 0;

        setFileEol('\n');
        setFileEol('\r\n');
        expect(file.isDirty).toBe(true);
    });
});
