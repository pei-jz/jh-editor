import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A search of a large file can run for a while between matches. The tab has to
// show that it is still working, and offer a way out.

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

// CodeMirror measures its text in the next frame; jsdom lays nothing out.
Range.prototype.getClientRects = () => [];
Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

const { SearchResultsView, describeProgress } = await import('../src/modules/views/SearchResultsView.js');

const MB = 1024 * 1024;

describe('search results while the search runs', () => {
    let container;

    const view = (over = {}) => new SearchResultsView(container, {
        query: 'needle', searchId: 42, streaming: true, matches: [], options: {}, ...over,
    });
    const header = () => container.querySelector('.sr-header');
    const cancel = () => container.querySelector('.sr-cancel');
    const arrive = (v, ...matches) => { v.file.matches.push(...matches); v.appendMatches(); };

    beforeEach(() => {
        invoke.mockClear();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => container.remove());

    it('counts files, and gives a large file its percentage', () => {
        expect(describeProgress({ files: 12, current: '', current_done: 0, current_size: 0 })).toBe('12 files searched');
        const line = describeProgress({ files: 12, current: 'C:\\ws\\logs\\big.log', current_done: 54 * MB, current_size: 108 * MB });
        expect(line).toContain('big.log 50% (108 MB)');
        expect(describeProgress(null)).toBe('');
    });

    it('updates the progress line without rebuilding the header', () => {
        const v = view();
        const spinner = header().querySelector('.sr-spinner');
        v.setProgress({ files: 3, current: 'big.log', current_done: MB, current_size: 2 * MB });
        expect(header().textContent).toContain('big.log 50%');
        expect(header().querySelector('.sr-spinner')).toBe(spinner);
    });

    it('cancels its own search, with a button that survives new matches', () => {
        const v = view();
        const button = cancel();
        arrive(v, { path: 'C:/ws/a.txt', line: 1, text: 'needle' });
        expect(cancel()).toBe(button);
        button.click();
        expect(invoke).toHaveBeenCalledWith('cancel_grep', { searchId: 42 });
    });

    it('stops looking busy when done, and says if it was canceled', () => {
        const v = view();
        arrive(v, { path: 'C:/ws/a.txt', line: 1, text: 'needle' });
        v.setDone(false, true);
        expect(cancel()).toBeNull();
        expect(header().querySelector('.sr-spinner')).toBeNull();
        expect(header().textContent).toContain('1 files, 1 hits');
        expect(header().textContent).toContain('canceled');
    });

    it('does not call a canceled search with nothing found "no results"', () => {
        const v = view();
        v.setDone(false, true);
        expect(header().textContent).not.toContain('No results');
    });

    it('rebuilds from what the tab has kept when switched back to', () => {
        view({ _progress: { files: 9, current: '', current_done: 0, current_size: 0 } });
        expect(header().textContent).toContain('9 files searched');
        container.innerHTML = '';
        view({ _done: true, _canceled: true });
        expect(header().textContent).toContain('canceled');
        expect(cancel()).toBeNull();
    });
});
