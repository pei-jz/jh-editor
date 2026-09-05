/* Who is allowed to draw into an editor container.
 *
 * Book mode watches its container with a ResizeObserver and re-renders when
 * the size changes, using the blocks captured when that observer was made.
 * Splitting the editor resizes both panes — so an observer belonging to a view
 * that used to render there fires, and paints its own file over whatever is on
 * screen now. That is how a README from an entirely different workspace showed
 * up in a freshly split pane.
 *
 * The guard that was there — `this.file.path === this._lastFilePath` — compares
 * a view against a value it wrote itself, so it is always true. What has to be
 * asked is whether the container still belongs to this view.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const src = read('src/modules/views/MarkdownView.js');

describe('an editor container has one owner', () => {
    it('is claimed on every render, not only in book mode', () => {
        const i = src.indexOf('render(content, file) {');
        expect(i).toBeGreaterThan(-1);
        const body = src.slice(i, i + 2000);
        expect(body, 'a view that takes over in scroll mode must displace the last owner')
            .toContain('__mdViewOwner');
    });

    // A container holding a strong reference back would keep the view of a
    // closed tab alive for as long as the element lives.
    it('is held weakly', () => {
        expect(src).toContain('__mdViewOwner = new WeakRef(this)');
    });

    it('stops the observer that no longer owns it', () => {
        const i = src.indexOf('this._resizeObserver = new ResizeObserver');
        expect(i).toBeGreaterThan(-1);
        const cb = src.slice(i, i + 1400);

        expect(cb).toContain('__mdViewOwner');
        expect(cb).toContain('owner.deref() !== this');
        // A detached container cannot be resized back into relevance either.
        expect(cb).toContain('this.container.isConnected');
        expect(cb, 'the observer should let go rather than keep firing')
            .toContain('this._resizeObserver.disconnect()');
    });

    // The old guard is kept — it still stops a re-render for a file the view
    // has since moved off — but it must not be the only thing standing between
    // a stale observer and the document on screen.
    it('does not rely on a view comparing itself to itself', () => {
        const i = src.indexOf('this._resizeObserver = new ResizeObserver');
        const cb = src.slice(i, i + 1400);
        const ownerAt = cb.indexOf('owner.deref() !== this');
        const pathAt = cb.indexOf('this._lastFilePath');
        expect(ownerAt).toBeGreaterThan(-1);
        expect(pathAt, 'the ownership check has to come first').toBeGreaterThan(ownerAt);
    });
});
