import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// The tree's cursor and keyboard focus are two things. refresh() restores the
// cursor, and the tree is refreshed by things unrelated to where the user is
// typing — a save, a git update, a refresh still running from an earlier
// click. Each of those used to focus the row, so focus left the editor mid-edit:
// Shift+arrows then selected rows in the tree, and Delete offered to delete
// files.

vi.mock('../src/modules/utils/FileSystem.js', async (orig) => {
    const real = await orig();
    return {
        ...real,
        readDirectory: vi.fn(async () => [
            { entry: 'a.md', type: 'FILE' },
            { entry: 'b.md', type: 'FILE' },
        ]),
    };
});

describe('explorer focus', () => {
    let Explorer;
    let State;
    let editor;
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
            <textarea id="editor"></textarea>
        `;
        editor = document.getElementById('editor');
        ({ State } = await import('../src/modules/core/Store.js'));
        Explorer = await import('../src/modules/core/Explorer.js');
        await Explorer.initExplorer(vi.fn(), {});
    });

    afterAll(() => {
        global.ResizeObserver = originalResizeObserver;
        document.body.innerHTML = '';
    });

    beforeEach(async () => {
        localStorage.clear();
        State.currentDir = 'C:/root';
        State.expandedFolders = new Set();
        await Explorer.loadExplorer(true);
    });

    const list = () => document.getElementById('file-list');
    const row = (name) => [...list().querySelectorAll('.tree-label')]
        .find((l) => l.textContent === name).parentElement;
    const settle = () => new Promise((r) => setTimeout(r, 80));

    it('leaves the editor focused when the tree refreshes', async () => {
        // A click in the tree leaves a cursor row behind…
        row('a.md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await settle();
        // …then the user goes back to typing.
        editor.focus();
        expect(document.activeElement).toBe(editor);

        await Explorer.loadExplorer(true);
        await settle();

        expect(document.activeElement).toBe(editor);
    });

    it('keeps focus in the tree when the tree had it', async () => {
        row('a.md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await settle();
        expect(list().contains(document.activeElement)).toBe(true);

        await Explorer.loadExplorer(true);
        await settle();

        expect(list().contains(document.activeElement)).toBe(true);
    });

    it('focusIsFree: only the tree itself or <body>', () => {
        const container = list();
        editor.focus();
        expect(Explorer.focusIsFree(container)).toBe(false);
        editor.blur();
        expect(Explorer.focusIsFree(container)).toBe(true);   // <body>
        container.focus();
        expect(Explorer.focusIsFree(container)).toBe(true);
    });
});
