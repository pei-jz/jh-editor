import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PathCrumbMenu } from '../src/modules/ui/PathCrumbMenu.js';

/* The drop-down under a folder in the title bar's path: what is in the
   folder, with subfolders to step into and "Show in Explorer" first. */

const tree = {
    'C:/w/src': [
        { entry: 'ui', type: 'DIRECTORY', path: 'C:/w/src/ui' },
        { entry: 'b.js', type: 'FILE', path: 'C:/w/src/b.js' },
        { entry: 'A.js', type: 'FILE', path: 'C:/w/src/A.js' },
    ],
    'C:/w/src/ui': [{ entry: 'Panel.js', type: 'FILE', path: 'C:/w/src/ui/Panel.js' }],
    'C:/w': [{ entry: 'src', type: 'DIRECTORY', path: 'C:/w/src' }],
};

const labels = () => [...document.querySelectorAll('.crumb-menu-item .crumb-menu-label')].map((l) => l.textContent);
const filter = () => document.querySelector('.crumb-menu-filter');
const key = (k) => filter().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const settle = () => vi.waitFor(() => expect(document.querySelector('.crumb-menu-empty')?.textContent).not.toBe('Loading…'));

let opts;
let anchor;

beforeEach(async () => {
    Element.prototype.scrollIntoView = function noop() {};
    document.body.innerHTML = '<span id="crumb">src</span>';
    anchor = document.getElementById('crumb');
    opts = {
        list: vi.fn(async (dir) => {
            if (!tree[dir]) throw new Error('nope');
            return tree[dir];
        }),
        open: vi.fn(),
        reveal: vi.fn(),
        currentPath: 'C:\\w\\src\\b.js',
    };
});

afterEach(() => {
    PathCrumbMenu.hide();
    delete Element.prototype.scrollIntoView;
});

describe('PathCrumbMenu', () => {
    it('lists folders first, then files, after "Show in Explorer" and ".."', async () => {
        PathCrumbMenu.show(anchor, 'C:/w/src', opts);
        await settle();
        expect(labels()).toEqual(['Show in Explorer', '..', 'ui', 'A.js', 'b.js']);
    });

    it('starts on the file being edited and opens a sibling with Enter', async () => {
        PathCrumbMenu.show(anchor, 'C:/w/src', opts);
        await settle();
        expect(document.querySelector('.crumb-menu-item.is-active').textContent).toContain('b.js');
        key('ArrowUp');
        key('Enter');
        expect(opts.open).toHaveBeenCalledWith('C:/w/src/A.js');
        expect(PathCrumbMenu.isOpen()).toBe(false);
    });

    it('steps into a subfolder, and Backspace on an empty filter goes back up', async () => {
        PathCrumbMenu.show(anchor, 'C:/w/src', opts);
        await settle();
        [...document.querySelectorAll('.crumb-menu-item')].find((r) => r.textContent.includes('ui')).click();
        await vi.waitFor(() => expect(labels()).toContain('Panel.js'));
        key('Backspace');
        await vi.waitFor(() => expect(labels()).toContain('A.js'));
    });

    it('filters as you type, and reveals the folder from the first row', async () => {
        PathCrumbMenu.show(anchor, 'C:/w/src', opts);
        await settle();
        filter().value = 'a.';
        filter().dispatchEvent(new Event('input', { bubbles: true }));
        expect(labels()).toEqual(['A.js']);

        filter().value = '';
        filter().dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.crumb-menu-reveal').click();
        expect(opts.reveal).toHaveBeenCalledWith('C:/w/src');
    });

    it('says so when a folder cannot be read', async () => {
        PathCrumbMenu.show(anchor, 'C:/nowhere', opts);
        await vi.waitFor(() => expect(document.querySelector('.crumb-menu-empty')?.textContent).toMatch(/could not be read/));
    });

    it('closes on Escape and on a click outside', async () => {
        PathCrumbMenu.show(anchor, 'C:/w/src', opts);
        key('Escape');
        expect(PathCrumbMenu.isOpen()).toBe(false);
        PathCrumbMenu.show(anchor, 'C:/w/src', opts);
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(PathCrumbMenu.isOpen()).toBe(false);
    });
});
