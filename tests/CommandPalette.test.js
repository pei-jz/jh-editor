import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandPalette, initCommandPalette } from '../src/modules/ui/CommandPalette.js';

/* The unified palette: one box, the first character picks what is searched.
   Everything it reads from the app comes in through `sources`, so these tests
   give it fakes and watch the rows. */

const input = () => document.querySelector('.cmdp-input');
const rows = () => [...document.querySelectorAll('.cmdp-item')];
const labels = () => rows().map((r) => r.querySelector('.cmdp-item-label').textContent);
const active = () => document.querySelector('.cmdp-item.is-active .cmdp-item-label')?.textContent;
const empty = () => document.querySelector('.cmdp-empty')?.textContent;
const type = (text) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (k) => input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

const file = (path, over = {}) => ({ path, name: path.split('/').pop(), isDirty: false, ...over });

let sources;
let dispatcher;

beforeEach(() => {
    Element.prototype.scrollIntoView = function noop() {};
    const a = file('C:/w/src/a.js');
    const b = file('C:/w/src/b.js', { isDirty: true });
    const c = file('C:/w/docs/c.md');
    sources = {
        tabs: vi.fn(() => [
            { file: a, pane: 'left', index: 0 },
            { file: b, pane: 'left', index: 1 },
            { file: c, pane: 'right', index: 0 },
        ]),
        activeFile: vi.fn(() => a),
        activateTab: vi.fn(),
        hasWorkspace: vi.fn(() => true),
        searchFiles: vi.fn(async (q) => ({
            hits: [{ item: { path: `C:/w/src/${q}.js` }, rel: `src/${q}.js`, name: `${q}.js` }],
            partial: false,
        })),
        hitPath: (hit) => hit.item.path,
        recentFiles: vi.fn(() => ['C:/w/README.md']),
        openPath: vi.fn(),
        outline: vi.fn(() => ({ isMarkdown: false, items: [
            { level: 1, text: 'class Editor', lineIndex: 0 },
            { level: 2, text: 'render()', lineIndex: 9 },
        ] })),
        jumpOutline: vi.fn(),
        lineCount: vi.fn(() => 40),
        goToLine: vi.fn(),
        grep: vi.fn(),
    };
    dispatcher = vi.fn();
    initCommandPalette(dispatcher, sources);
});

afterEach(() => {
    CommandPalette.hide();
    delete Element.prototype.scrollIntoView;
});

describe('tabs (@)', () => {
    it('lists tabs as given, most recent first, and starts on the previous one', () => {
        CommandPalette.show('@');
        expect(labels()).toEqual(['a.js', 'b.js', 'c.md']);
        // a.js is on screen; Enter right away goes back to b.js.
        expect(active()).toBe('b.js');
        key('Enter');
        expect(sources.activateTab).toHaveBeenCalledWith(expect.objectContaining({ index: 1, pane: 'left' }));
        expect(CommandPalette.isOpen()).toBe(false);
    });

    it('marks unsaved tabs and shows the folder', () => {
        CommandPalette.show('@');
        expect(rows()[1].querySelector('.cmdp-item-dirty')).not.toBeNull();
        expect(rows()[0].querySelector('.cmdp-item-dirty')).toBeNull();
        expect(rows()[2].querySelector('.cmdp-item-detail').textContent).toBe('C:/w/docs');
    });

    it('filters by name and starts on the first hit', () => {
        CommandPalette.show('@');
        type('@md');
        expect(labels()).toEqual(['c.md']);
        expect(active()).toBe('c.md');
    });
});

describe('commands (>)', () => {
    it('runs the chosen command through the dispatcher', () => {
        CommandPalette.show('>');
        type('>search in workspace');
        key('Enter');
        expect(dispatcher).toHaveBeenCalledWith('app:grep');
    });
});

describe('files (no prefix)', () => {
    it('shows recently opened files before anything is typed', () => {
        CommandPalette.show('');
        expect(labels()).toEqual(['README.md']);
    });

    it('ranks workspace files from the index and opens the chosen one', async () => {
        CommandPalette.show('');
        type('main');
        await vi.waitFor(() => expect(labels()).toEqual(['main.js']));
        expect(rows()[0].querySelector('.cmdp-item-detail').textContent).toBe('src');
        key('Enter');
        expect(sources.openPath).toHaveBeenCalledWith('C:/w/src/main.js');
    });

    it('highlights the matched part of the name and the folder', async () => {
        sources.searchFiles.mockImplementationOnce(async () => ({
            hits: [{ item: { path: 'C:/w/src/build.rs' }, rel: 'src/build.rs', name: 'build.rs',
                nameRanges: [], relRanges: [[0, 3], [4, 7]] }],
            partial: false,
        }));
        CommandPalette.show('');
        type('srcbui');
        await vi.waitFor(() => expect(labels()).toEqual(['build.rs']));
        const marks = (sel) => [...rows()[0].querySelectorAll(`${sel} .cmdp-hit`)].map((m) => m.textContent);
        expect(marks('.cmdp-item-label')).toEqual(['bui']);
        expect(marks('.cmdp-item-detail')).toEqual(['src']);
        expect(rows()[0].querySelector('.cmdp-item-label').textContent).toBe('build.rs');
    });

    // An answer for "ma" arriving after "main" was typed must not replace it.
    it('drops the answer to a query the user has typed past', async () => {
        let release;
        sources.searchFiles.mockImplementationOnce(() => new Promise((r) => { release = r; }));
        CommandPalette.show('');
        type('ma');
        type('main');
        await vi.waitFor(() => expect(labels()).toEqual(['main.js']));
        release({ hits: [{ item: { path: 'C:/w/ma.js' }, rel: 'ma.js', name: 'ma.js' }] });
        await Promise.resolve();
        await Promise.resolve();
        expect(labels()).toEqual(['main.js']);
    });

    it('falls back to recent files when no folder is open', () => {
        sources.hasWorkspace.mockReturnValue(false);
        CommandPalette.show('');
        expect(labels()).toEqual(['README.md']);
        expect(sources.searchFiles).not.toHaveBeenCalled();
    });
});

describe('symbols (#)', () => {
    it('lists the outline and jumps to the chosen item', () => {
        CommandPalette.show('#');
        expect(labels()).toEqual(['class Editor', 'render()']);
        type('#rend');
        key('Enter');
        expect(sources.jumpOutline).toHaveBeenCalledWith(expect.objectContaining({ lineIndex: 9 }));
    });
});

describe('line (:)', () => {
    it('offers the line and goes there', () => {
        CommandPalette.show(':');
        type(':12');
        expect(labels()).toHaveLength(1);
        key('Enter');
        expect(sources.goToLine).toHaveBeenCalledWith(12);
    });

    it('offers nothing to run for a line past the end', () => {
        CommandPalette.show(':');
        type(':99');
        expect(rows()).toHaveLength(0);
        expect(empty()).toContain('40');
        key('Enter');
        expect(sources.goToLine).not.toHaveBeenCalled();
    });
});

describe('text (?)', () => {
    it('hands the query to workspace search', () => {
        CommandPalette.show('?');
        type('?TODO');
        key('Enter');
        expect(sources.grep).toHaveBeenCalledWith('TODO');
    });
});

describe('tree view', () => {
    const folders = () => [...document.querySelectorAll('.cmdp-folder .cmdp-folder-label')].map((f) => f.textContent);

    beforeEach(() => {
        localStorage.clear();
        sources.workspace = () => 'C:/w';
    });

    it('shows tabs under their folders, and remembers the choice', () => {
        CommandPalette.show('@');
        document.querySelector('.cmdp-view-toggle').click();
        expect(folders()).toEqual(['w', 'docs', 'src']);
        expect(labels()).toEqual(['c.md', 'a.js', 'b.js']);
        // The folder is the row above, so the path is not repeated.
        expect(document.querySelector('.cmdp-item-detail')).toBeNull();
        expect(JSON.parse(localStorage.getItem('jh_command_palette_view_v1')).tree).toBe(true);
    });

    it('still starts on the previous tab, wherever the tree put it', () => {
        CommandPalette.show('@');
        document.querySelector('.cmdp-view-toggle').click();
        expect(active()).toBe('b.js');
        key('Enter');
        expect(sources.activateTab).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
    });

    it('folds a folder on click, and the arrow keys skip folder rows', () => {
        CommandPalette.show('@');
        document.querySelector('.cmdp-view-toggle').click();
        const src = [...document.querySelectorAll('.cmdp-folder')].find((f) => f.textContent.includes('src'));
        src.click();
        expect(labels()).toEqual(['c.md']);
        key('ArrowDown');
        expect(active()).toBe('c.md');
    });

    it('is offered only where rows are files', () => {
        CommandPalette.show('>');
        expect(document.querySelector('.cmdp-view-toggle').hidden).toBe(true);
        type('@');
        expect(document.querySelector('.cmdp-view-toggle').hidden).toBe(false);
    });

    it('toggles with Ctrl+Alt+T', () => {
        CommandPalette.show('@');
        const before = document.querySelectorAll('.cmdp-folder').length > 0;
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
        expect(document.querySelectorAll('.cmdp-folder').length > 0).toBe(!before);
    });
});

describe('size', () => {
    beforeEach(() => localStorage.clear());

    const drag = (edge, dx, dy) => {
        const handle = document.querySelector(`.cmdp-resize-${edge}`);
        handle.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100 + dx, clientY: 100 + dy, bubbles: true }));
        window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    };

    it('grows from the bottom-right corner and keeps the size', () => {
        CommandPalette.show('>');
        const panel = document.querySelector('.cmdp-panel');
        panel.getBoundingClientRect = () => ({ width: 640, height: 400, left: 0, top: 0, right: 640, bottom: 400 });
        drag('br', 50, 80);
        // A side edge moves both sides of a centred panel: twice the distance.
        expect(panel.style.width).toBe('740px');
        expect(panel.style.height).toBe('480px');
        expect(JSON.parse(localStorage.getItem('jh_command_palette_view_v1'))).toMatchObject({ w: 740, h: 480 });
    });

    it('never shrinks below a usable size, and a double-click resets it', () => {
        CommandPalette.show('>');
        const panel = document.querySelector('.cmdp-panel');
        panel.getBoundingClientRect = () => ({ width: 640, height: 400, left: 0, top: 0, right: 640, bottom: 400 });
        drag('r', -500, 0);
        expect(panel.style.width).toBe('420px');
        document.querySelector('.cmdp-resize-r').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(panel.style.width).toBe('');
    });
});

describe('switching modes', () => {
    it('keeps the query when a mode chip is clicked', () => {
        CommandPalette.show('@');
        type('@b');
        document.querySelector('.cmdp-mode[data-mode="commands"]').click();
        expect(input().value).toBe('>b');
        expect(document.querySelector('.cmdp-mode.is-active').dataset.mode).toBe('commands');
    });

    it('closes on the same key, switches on another', () => {
        CommandPalette.toggle('@');
        expect(CommandPalette.isOpen()).toBe(true);
        CommandPalette.toggle('#');
        expect(CommandPalette.isOpen()).toBe(true);
        expect(input().value).toBe('#');
        CommandPalette.toggle('#');
        expect(CommandPalette.isOpen()).toBe(false);
    });

    it('closes on Escape without running anything', () => {
        CommandPalette.show('@');
        key('Escape');
        expect(CommandPalette.isOpen()).toBe(false);
        expect(sources.activateTab).not.toHaveBeenCalled();
    });
});
