import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The explorer's folder button drops down the recent workspaces, so moving
// between projects is one click instead of a trip through the folder picker.

const { toggleWorkspaceMenu, closeWorkspaceMenu } = await import('../src/modules/ui/WorkspaceMenu.js');
const { RecentFiles, sameWorkspace } = await import('../src/modules/utils/RecentFiles.js');
const { State } = await import('../src/modules/core/Store.js');
const { keyIsOwnedByPopup } = await import('../src/modules/utils/KeyOwnership.js');
const { readFileSync } = await import('node:fs');

describe('workspace history', () => {
    beforeEach(() => localStorage.clear());

    it('keeps the most recent first, without duplicates, up to ten', () => {
        for (let i = 0; i < 12; i++) RecentFiles.recordWorkspace(`C:/w/p${i}`);
        RecentFiles.recordWorkspace('C:\\w\\p5');           // same folder, other slashes
        const list = RecentFiles.getWorkspaces();
        expect(list).toHaveLength(10);
        expect(list[0]).toBe('C:\\w\\p5');
        expect(list.filter((p) => sameWorkspace(p, 'C:/w/p5'))).toHaveLength(1);
    });

    it('forgets a workspace', () => {
        RecentFiles.recordWorkspace('C:/a');
        RecentFiles.recordWorkspace('C:/b');
        RecentFiles.forgetWorkspace('C:/A/');
        expect(RecentFiles.getWorkspaces()).toEqual(['C:/b']);
    });
});

describe('workspace menu', () => {
    let anchor;
    let handlers;

    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '<button id="anchor">folder</button>';
        anchor = document.getElementById('anchor');
        handlers = { onSwitch: vi.fn(), onOpenFolder: vi.fn(), onOpenInNewWindow: vi.fn() };
        RecentFiles.recordWorkspace('C:/work/old');
        RecentFiles.recordWorkspace('D:/repo/other');
        RecentFiles.recordWorkspace('C:/work/current');
        State.currentDir = 'C:\\work\\current';
    });

    afterEach(() => {
        closeWorkspaceMenu();
        document.body.innerHTML = '';
    });

    const menu = () => document.querySelector('.ws-menu');
    const items = () => [...document.querySelectorAll('.ws-menu-item')];
    const key = (k) => document.activeElement.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

    it('lists the history, marks the current one, and ends with Open Folder', () => {
        toggleWorkspaceMenu(anchor, handlers);
        const names = items().map((r) => (r.querySelector('.ws-menu-name') || r.querySelector('.ws-menu-text')).textContent);
        expect(names[0]).toBe('current');
        expect(names[1]).toBe('other');
        expect(items()[0].classList.contains('current')).toBe(true);
        expect(items().at(-1).classList.contains('ws-menu-open')).toBe(true);
        // ShortcutManager leaves its keys alone.
        expect(menu().dataset.shortcutKeys).toBe('own');
    });

    it('switches with one click, and does nothing for the current workspace', () => {
        toggleWorkspaceMenu(anchor, handlers);
        items()[0].click();
        expect(handlers.onSwitch).not.toHaveBeenCalled();
        items()[1].click();
        expect(handlers.onSwitch).toHaveBeenCalledWith('D:/repo/other');
        expect(menu()).toBe(null);
    });

    it('starts on the first other workspace and walks with the keys', () => {
        toggleWorkspaceMenu(anchor, handlers);
        expect(document.activeElement).toBe(items()[1]);
        key('ArrowDown');
        key('Enter');
        expect(handlers.onSwitch).toHaveBeenCalledWith('C:/work/old');
    });

    it('opens the folder picker from the last row', () => {
        toggleWorkspaceMenu(anchor, handlers);
        key('End');
        key('Enter');
        expect(handlers.onOpenFolder).toHaveBeenCalled();
    });

    it('removes a workspace from the history with Delete', () => {
        toggleWorkspaceMenu(anchor, handlers);
        key('Delete');                                     // on "other"
        expect(RecentFiles.getWorkspaces()).toEqual(['C:/work/current', 'C:/work/old']);
        expect(items()).toHaveLength(3);                   // two workspaces + Open Folder
    });

    it('closes on Escape and on a second click of the button', () => {
        toggleWorkspaceMenu(anchor, handlers);
        key('Escape');
        expect(menu()).toBe(null);
        toggleWorkspaceMenu(anchor, handlers);
        toggleWorkspaceMenu(anchor, handlers);
        expect(menu()).toBe(null);
    });
});

// The views that listen on the window in the capture phase hear every key
// before the menu does. With a Markdown file open, ↑/↓ moved the block
// selection behind the menu instead of walking its rows.
describe('arrow keys while the menu is open', () => {
    afterEach(() => {
        closeWorkspaceMenu();
        document.body.innerHTML = '';
    });

    it('belong to the menu, not to a window-level view handler', () => {
        localStorage.clear();
        document.body.innerHTML = '<button id="anchor">folder</button>';
        RecentFiles.recordWorkspace('C:/a');
        RecentFiles.recordWorkspace('C:/b');
        toggleWorkspaceMenu(document.getElementById('anchor'), {
            onSwitch: vi.fn(), onOpenFolder: vi.fn(), onOpenInNewWindow: vi.fn(),
        });

        const view = vi.fn();
        const listener = (e) => { if (!keyIsOwnedByPopup(e)) view(e.key); };
        window.addEventListener('keydown', listener, true);
        const before = document.activeElement;
        before.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        window.removeEventListener('keydown', listener, true);

        expect(view).not.toHaveBeenCalled();
        expect(document.activeElement).not.toBe(before);   // the menu moved instead
    });

    it('is not claimed when no popup is involved', () => {
        document.body.innerHTML = '<div id="doc" tabindex="0"></div>';
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown' });
        Object.defineProperty(e, 'target', { value: document.getElementById('doc') });
        expect(keyIsOwnedByPopup(e)).toBe(false);
    });

    it('is asked by every window-level arrow handler', () => {
        for (const f of ['src/modules/views/MarkdownView.js', 'src/modules/views/CodeMirrorView.js',
            'src/modules/editors/StructureEditor.js']) {
            expect(readFileSync(f, 'utf8'), f).toContain('if (keyIsOwnedByPopup(e)) return;');
        }
        // MarkdownView has two: block navigation and the book-mode page keys.
        const md = readFileSync('src/modules/views/MarkdownView.js', 'utf8');
        expect(md.split('if (keyIsOwnedByPopup(e)) return;').length - 1).toBe(2);
    });
});
