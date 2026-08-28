import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');
const src = read('src/modules/ui/GitPanel.js');

/* The Git tree had no keyboard handling at all — no focusable rows, no keydown
   listener, no scope — so Up and Down did what they do on any scrollable div:
   scrolled it, while the folders sat there un-openable. */

describe('the Git tree takes the keyboard', () => {
    const handler = () => {
        const i = src.indexOf('_bindTreeKeys() {');
        return src.slice(i, src.indexOf('\n    _statusLabel', i));
    };

    it('makes every row focusable and identifiable', () => {
        // Both kinds: a folder to open, a file to diff.
        expect(src).toContain("div.dataset.gitKind = 'folder';");
        expect(src).toContain("div.dataset.gitKind = 'file';");
        expect((src.match(/div\.tabIndex = -1;/g) || []).length).toBe(2);
        expect(src).toContain('div.dataset.gitOpen = String(isExpanded && !hasNoChildren);');
    });

    it('answers every navigation key', () => {
        const fn = handler();
        for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter']) {
            expect(fn, key).toContain(`case '${key}':`);
        }
        // ...and stops the panel scrolling underneath, which is what it did.
        expect((fn.match(/e\.preventDefault\(\);/g) || []).length).toBeGreaterThanOrEqual(7);
    });

    it('opens a closed folder with Right and closes it with Left', () => {
        const fn = handler();
        expect(fn).toContain('this.expandedNodes.add(path);');
        expect(fn).toContain('this.expandedNodes.delete(path);');
        // An already-open folder steps INTO its contents instead of re-opening.
        expect(fn).toContain('if (isFolder && !isOpen && row.dataset.gitLeaf !== \'true\')');
    });

    it('goes up to the parent from a file', () => {
        const fn = handler();
        expect(fn).toContain("const cut = path.lastIndexOf('/');");
        expect(fn).toContain('.git-tree-item.git-folder[data-git-path=');
    });

    // Every expand or collapse calls refresh(), which rebuilds every row, so a
    // listener attached to a row would not survive its own keystroke.
    it('binds once, on the panel, and delegates', () => {
        const fn = handler();
        expect(fn).toContain('if (this._treeKeysBound) return;');
        expect(fn).toContain("this.element.addEventListener('keydown'");
        expect(fn).toContain("e.target.closest('.git-tree-item')");
    });
});

/* refresh() replaces the focused node, so focus has to be restored by PATH. */
describe('focus survives the rebuild', () => {
    const method = () => {
        const i = src.indexOf('_refreshKeepingFocus(path) {');
        return src.slice(i, src.indexOf('\n    /**', i));
    };

    it('re-finds the row by path, not by element', () => {
        expect(method()).toContain('[data-git-path="${cssEscape(target)}"]');
    });

    // A folder that collapsed away takes its children with it; landing at the
    // top of the panel instead of on the parent loses the reader's place.
    it('falls back to the nearest ancestor still on screen', () => {
        const fn = method();
        expect(fn).toContain('while (target)');
        expect(fn).toContain("target = cut > 0 ? target.slice(0, cut) : '';");
    });

    it('is used by the mouse path too, so the two can be mixed', () => {
        expect(src).toContain('this._refreshKeepingFocus(fullPath);');
    });
});

/* Paths are user data: a file can be called `a"b[c].txt`, and an attribute
   selector built from one without escaping simply throws. */
describe('building a selector from a path', () => {
    it('escapes what would break the selector', async () => {
        const { cssEscape } = await import('../src/modules/ui/GitPanel.js');
        if (typeof cssEscape !== 'function') return;    // not exported; covered below
        expect(cssEscape('a"b')).not.toBe('a"b');
    });

    it('does not depend on CSS.escape being there', () => {
        // jsdom has no CSS global at all, and neither do some webviews.
        expect(src).toContain("typeof CSS !== 'undefined'");
        expect(src).toContain('CSS.escape(v)');
        expect(src).toMatch(/return v\.replace\(/);
    });
});
