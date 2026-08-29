import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import GitPanel from '../src/modules/ui/GitPanel.js';

// The detail pane sits below the history. Three things were wrong: it kept a
// stale commit after the log reloaded (so something looked selected when
// nothing was), the history section left the rest of the scrolling area as dead
// space with its own bottom border stranded in it, and the split between the
// two was fixed.

describe('git commit detail pane', () => {
    let panel;
    let el;

    beforeEach(() => {
        document.body.innerHTML = '';
        panel = new GitPanel();
        el = panel.element;
        document.body.appendChild(el);
    });

    const detail = () => el.querySelector('#git-commit-detail-panel');
    const resizer = () => el.querySelector('#git-detail-resizer');

    it('starts hidden, together with its divider', () => {
        expect(detail().style.display).toBe('none');
        expect(resizer().style.display).toBe('none');
    });

    it('shows the pane and the divider together', () => {
        panel._showDetailPanel();
        expect(detail().style.display).toBe('block');
        expect(resizer().style.display).toBe('block');
    });

    it('hides both again and drops the stale content', () => {
        const p = panel._showDetailPanel();
        p.innerHTML = '<div>02916db</div>';
        panel._hideDetailPanel();
        expect(detail().style.display).toBe('none');
        expect(resizer().style.display).toBe('none');
        expect(detail().innerHTML).toBe('');
    });

    // A commit selected before a reload is not selected after it.
    it('clears the pane when the panel refreshes', async () => {
        const p = panel._showDetailPanel();
        p.innerHTML = '<div>stale</div>';
        await panel.refresh();
        expect(detail().style.display).toBe('none');
        expect(detail().innerHTML).toBe('');
    });

    it('restores the height the divider was last dragged to', () => {
        localStorage.setItem('git_detail_height', '260');
        panel._showDetailPanel();
        expect(detail().style.height).toBe('260px');
        localStorage.removeItem('git_detail_height');
    });

    it('ignores a nonsense stored height', () => {
        localStorage.setItem('git_detail_height', 'not-a-number');
        panel._showDetailPanel();
        expect(detail().style.height).toBe('');
        localStorage.removeItem('git_detail_height');
    });

    describe('divider', () => {
        // Binding on every refresh would pile up live document listeners.
        it('binds only once', () => {
            const add = vi.spyOn(document, 'addEventListener');
            panel._detailResizerBound = false;
            panel._bindDetailResizer();
            const first = add.mock.calls.length;
            panel._bindDetailResizer();
            expect(add.mock.calls.length).toBe(first);
            add.mockRestore();
        });

        it('grows the pane when dragged upwards, and remembers it', () => {
            panel._detailResizerBound = false;
            panel._bindDetailResizer();
            el.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 });

            resizer().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            document.dispatchEvent(new MouseEvent('mousemove', { clientY: 400 }));
            expect(detail().style.height).toBe('200px');   // 600 - 400
            expect(localStorage.getItem('git_detail_height')).toBe('200');

            document.dispatchEvent(new MouseEvent('mousemove', { clientY: 300 }));
            expect(detail().style.height).toBe('300px');

            document.dispatchEvent(new MouseEvent('mouseup'));
            document.dispatchEvent(new MouseEvent('mousemove', { clientY: 100 }));
            expect(detail().style.height).toBe('300px');   // released
            localStorage.removeItem('git_detail_height');
        });

        it('clamps the drag so neither side can be squeezed away', () => {
            panel._detailResizerBound = false;
            panel._bindDetailResizer();
            el.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 });
            resizer().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

            document.dispatchEvent(new MouseEvent('mousemove', { clientY: 599 }));
            expect(detail().style.height).toBe('80px');    // floor

            document.dispatchEvent(new MouseEvent('mousemove', { clientY: -50 }));
            expect(detail().style.height).toBe('480px');   // 80% of 600

            document.dispatchEvent(new MouseEvent('mouseup'));
            localStorage.removeItem('git_detail_height');
        });
    });
});

describe('git panel layout', () => {
    // The sections keep their natural height, so whatever is left of the
    // scrolling area used to sit below them as dead space — with the history
    // section's own bottom border stranded in the middle of it.
    it('gives the leftover height to the history section', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const css = readFileSync(join(here, '..', 'src/styles/explorer.css'), 'utf8').replace(/\r\n/g, '\n');
        const i = css.indexOf('#git-section-history {');
        expect(i).toBeGreaterThan(-1);
        expect(css.slice(i, css.indexOf('}', i))).toContain('flex: 1 1 auto;');
    });
});
