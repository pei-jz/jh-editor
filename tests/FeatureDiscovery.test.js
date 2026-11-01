import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

// EL captures the tab strip at import time, so it has to exist first.
document.body.innerHTML = '<div id="tab-bar"><div id="tabs-container"></div><button id="new-tab-btn"></button></div>';

const { renderTabs, canCompareWithSaved, saveCurrentFile } = await import('../src/modules/core/Editor.js');
const { Toast } = await import('../src/modules/ui/Toast.js');
const { State } = await import('../src/modules/core/Store.js');
const { SHORTCUTS } = await import('../src/modules/core/ShortcutDefinitions.js');
const { ShortcutManager, shortcuts } = await import('../src/modules/core/ShortcutManager.js');
const { listCommands } = await import('../src/modules/core/CommandRegistry.js');
const { initEmptyPaneGuide, renderEmptyPaneGuide } = await import('../src/modules/ui/EmptyPaneGuide.js');
const { ContextMenu } = await import('../src/modules/ui/ContextMenu.js');

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

function press(init) {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    window.dispatchEvent(e);
    return e;
}

describe('the terminal has a way in besides the title-bar button', () => {
    it('is a palette command that shows its key', () => {
        const cmd = listCommands().find((c) => c.id === 'app:toggle-terminal');
        expect(cmd).toBeTruthy();
        expect(cmd.binding).toBe('Ctrl+`');
    });

    it.each([
        ['US: Ctrl+`', { key: '`', ctrlKey: true }],
        ['JIS: Ctrl+@', { key: '@', ctrlKey: true }],
        ['JIS, reading the tooltip literally: Ctrl+Shift+@', { key: '`', ctrlKey: true, shiftKey: true }],
    ])('%s toggles it', (_name, init) => {
        const action = vi.fn();
        shortcuts.register({ cmd: 'app:toggle-terminal', scope: 'GLOBAL', action });
        press(init);
        expect(action).toHaveBeenCalledTimes(1);
    });

    it('stays at the end of GLOBAL, so saved rebindings keep their entries', () => {
        // An override is keyed by the entry's index. Anything inserted above
        // existing entries would move their saved keys onto other commands.
        const global = SHORTCUTS.GLOBAL;
        const first = global.findIndex((s) => s.cmd === 'app:toggle-terminal');
        expect(global.slice(first).every((s) => s.cmd === 'app:toggle-terminal')).toBe(true);
        expect(global[first - 1].cmd).toBe('editor:focus-other-pane');
    });

    it('names the key on the button', () => {
        expect(html).toContain('title="Toggle Terminal (Ctrl+`)"');
    });
});

describe('the workspace button says what it does', () => {
    it('reads as a list, not as a folder picker', () => {
        const button = html.match(/<button id="open-folder-btn"[\s\S]*?<\/button>/)[0];
        expect(button).toContain('title="Recent Workspaces (Ctrl+Alt+O)"');
        expect(button).toContain('aria-haspopup="menu"');
        expect(button).toContain('data-icon="chevron-down"');
    });
});

describe('compare with the saved file, on the tab', () => {
    const tabsContainer = () => document.getElementById('tabs-container');

    beforeEach(() => {
        State.splitMode = false;
        State.rightOpenFiles = [];
        State.activeTabIndex = 0;
    });

    it.each([
        ['a real file with edits', { path: 'C:/proj/a.txt', isDirty: true }, true],
        ['a real file without edits', { path: 'C:/proj/a.txt', isDirty: false }, false],
        ['an untitled buffer: no saved version', { path: '', name: 'Untitled', isDirty: true }, false],
        ['a comparison tab', { path: 'diff://disk:C:/proj/a.txt', isDirty: true }, false],
        ['a compare view', { path: 'C:/proj/a.txt', type: 'compare', isDirty: true }, false],
    ])('%s', (_name, file, expected) => {
        expect(canCompareWithSaved(file)).toBe(expected);
    });

    it('makes the * the way in, without another element on the tab', () => {
        const file = { path: 'C:/proj/a.txt', content: '', isDirty: true };
        State.openFiles = [file];
        renderTabs('left');
        const mark = tabsContainer().querySelector('.tab-dirty');
        expect(mark.classList.contains('tab-dirty-link')).toBe(true);
        expect(mark.title).toContain('Ctrl+Shift+D');
        expect(mark.nextElementSibling.className).toBe('tab-close');
    });

    it('leaves the * a plain mark where there is no saved version', () => {
        State.openFiles = [{ path: '', name: 'Untitled', content: 'x', isDirty: true }];
        renderTabs('left');
        const mark = tabsContainer().querySelector('.tab-dirty');
        expect(mark.classList.contains('tab-dirty-link')).toBe(false);
        expect(mark.onclick).toBeNull();
        expect(mark.title).toBe('');
    });

    it('clicking the * reads the saved file without switching to that tab', async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        State.openFiles = [
            { path: 'C:/proj/a.txt', content: '', isDirty: false },
            { path: 'C:/proj/b.txt', content: 'edited', isDirty: true },
        ];
        renderTabs('left');
        invoke.mockClear();
        tabsContainer().querySelector('.tab-dirty-link').click();
        expect(State.activeTabIndex).toBe(0);
        expect(invoke).toHaveBeenCalled();
        expect(JSON.stringify(invoke.mock.calls[0])).toContain('b.txt');
    });

    it('adds the command to the tab menu only when it applies', () => {
        const labels = (file) => {
            State.openFiles = [file];
            renderTabs('left');
            tabsContainer().querySelector('.tab').dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
            return [...ContextMenu.element.querySelectorAll('.context-menu-item')].map((el) => el.textContent);
        };
        expect(labels({ path: 'C:/proj/a.txt', content: '', isDirty: true }))
            .toContain('Compare with Saved FileCtrl+Shift+D');
        expect(labels({ path: 'C:/proj/a.txt', content: '', isDirty: false }).join())
            .not.toContain('Compare with Saved File');
    });
});

describe('the one-time hint on saving', () => {
    const KEY = 'jh_compare_hint_shown_v1';
    let toast;

    const edited = (path = 'C:/proj/a.txt') => {
        const file = { path, content: 'x', isDirty: true };
        State.splitMode = false;
        State.openFiles = [file];
        State.activeTabIndex = 0;
        return file;
    };

    beforeEach(() => {
        localStorage.removeItem(KEY);
        toast = vi.spyOn(Toast, 'info').mockImplementation(() => {});
    });
    afterEach(() => toast.mockRestore());

    it('names the key, on the first save of edits, and only then', async () => {
        edited();
        expect(await saveCurrentFile()).toBe(true);
        expect(toast).toHaveBeenCalledTimes(1);
        expect(toast.mock.calls[0][0]).toContain('Ctrl+Shift+D');

        edited();
        await saveCurrentFile();
        expect(toast).toHaveBeenCalledTimes(1);
    });

    it('waits for a save that had edits', async () => {
        edited().isDirty = false;
        await saveCurrentFile();
        expect(toast).not.toHaveBeenCalled();
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('does not spend itself on a save that was refused', async () => {
        edited().isLarge = true;
        expect(await saveCurrentFile()).toBe(false);
        expect(toast).not.toHaveBeenCalled();
        expect(localStorage.getItem(KEY)).toBeNull();
    });
});

describe('the new-tab menu button', () => {
    it('sits straight after the "+", which the tab scroller inserts before', () => {
        expect(html).toMatch(/<button id="new-tab-btn"[^>]*>\+<\/button>\s*<button id="new-tab-menu-btn"/);
    });

    it('its hint renders as part of the menu item', () => {
        const event = new MouseEvent('click');
        ContextMenu.show(event, [{ label: 'One', hint: 'Ctrl+1', action: () => {} }, { label: 'Two' }]);
        const items = ContextMenu.element.querySelectorAll('.context-menu-item');
        expect(items[0].querySelector('.context-menu-hint').textContent).toBe('Ctrl+1');
        expect(items[1].querySelector('.context-menu-hint')).toBeNull();
        ContextMenu.hide();
    });
});

describe('the empty pane guide', () => {
    const render = () => {
        const pane = document.createElement('div');
        pane.innerHTML = '<div>old</div>';
        renderEmptyPaneGuide(pane);
        return pane;
    };

    it('replaces the pane contents with a row for each hidden feature', () => {
        const pane = render();
        expect(pane.textContent).not.toContain('old');
        const cmds = [...pane.querySelectorAll('.empty-guide-row')].map((r) => r.dataset.cmd);
        expect(cmds).toEqual(expect.arrayContaining(['app:open-compare', 'app:toggle-terminal', 'app:workspace-menu']));
    });

    it('runs the command a row names', () => {
        const run = vi.fn();
        initEmptyPaneGuide(run);
        render().querySelector('[data-cmd="app:open-compare"]').click();
        expect(run).toHaveBeenCalledWith('app:open-compare');
    });

    it('shows each row\'s key, and a language change can reach the labels', () => {
        const row = render().querySelector('[data-cmd="app:open-compare"]');
        expect(row.querySelector('kbd').textContent).toBe('Ctrl+Alt+D');
        expect(row.querySelector('[data-i18n]').dataset.i18n).toBe('Compare Scratch Text');
    });

    it('is what renderEditor draws for a pane with no tab', () => {
        // The English sentence it replaced was hard-coded there, past the translator.
        const src = readFileSync(join(here, '..', 'src/modules/core/Editor.js'), 'utf8');
        expect(src).toContain('renderEmptyPaneGuide(container)');
        expect(src).not.toContain('class="welcome-message"');
    });
});

describe('ShortcutManager.bindingFor', () => {
    beforeEach(() => localStorage.removeItem('user_shortcuts'));

    it('reads the rebinding, not the default', () => {
        const sm = new ShortcutManager();
        expect(sm.bindingFor('app:open-compare')).toBe('Ctrl+Alt+D');
        const id = sm.shortcuts.find((s) => s.cmd === 'app:open-compare').id;
        sm.updateShortcut(id, { key: 'F9', ctrl: false, shift: false, alt: false });
        expect(sm.bindingFor('app:open-compare')).toBe('F9');
        sm.resetToDefaults();
    });

    it('is empty for a command with no key', () => {
        expect(new ShortcutManager().bindingFor('app:git-panel')).toBe('');
    });
});
