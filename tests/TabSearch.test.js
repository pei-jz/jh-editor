import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TabSearch } from '../src/modules/ui/TabSearch.js';

/* The arrow keys moved the `.selected` class down the list but never scrolled
   it, so past the sixth or seventh tab the highlight walked off the bottom of
   the panel and the keys looked like they had stopped working. The source even
   said so: `// Scroll into view logic if needed`. */

const files = Array.from({ length: 20 }, (_, i) => ({
    name: `File${i}.js`, path: `C:/proj/src/File${i}.js`,
}));

const input = () => document.querySelector('.tab-search-input');
const items = () => [...document.querySelectorAll('.tab-search-item')];
const selected = () => document.querySelector('.tab-search-item.selected');
const key = (k) => input().dispatchEvent(new KeyboardEvent('keydown', {
    key: k, bubbles: true, cancelable: true,
}));
const type = (text) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
};

let scrolled;

beforeEach(() => {
    document.body.innerHTML = '';
    scrolled = [];
    // jsdom has no scrollIntoView; record the calls instead.
    Element.prototype.scrollIntoView = function record(opts) {
        scrolled.push({ el: this, opts });
    };
});

afterEach(() => {
    document.getElementById('tab-search-overlay')?.remove();
    delete Element.prototype.scrollIntoView;
});

describe('moving through the list', () => {
    it('scrolls the selection into view on every step', () => {
        TabSearch.show(files, () => {});
        expect(scrolled).toHaveLength(1);          // the initial render

        key('ArrowDown');
        expect(selected().textContent).toContain('File1.js');
        expect(scrolled).toHaveLength(2);
        expect(scrolled.at(-1).el).toBe(selected());
    });

    // Re-centring the list on every keystroke is its own kind of unusable.
    it('leaves a row that is already visible where it is', () => {
        TabSearch.show(files, () => {});
        key('ArrowDown');
        expect(scrolled.at(-1).opts).toEqual({ block: 'nearest' });
    });

    it('wraps around at both ends', () => {
        TabSearch.show(files, () => {});
        key('ArrowUp');
        expect(selected().textContent).toContain('File19.js');
        key('ArrowDown');
        expect(selected().textContent).toContain('File0.js');
    });

    it('jumps to the ends with Home and End', () => {
        TabSearch.show(files, () => {});
        key('End');
        expect(selected().textContent).toContain('File19.js');
        key('Home');
        expect(selected().textContent).toContain('File0.js');
    });
});

describe('filtering', () => {
    it('selects the first hit and shows it', () => {
        TabSearch.show(files, () => {});
        type('File7');
        expect(items()).toHaveLength(1);
        expect(selected().textContent).toContain('File7.js');
    });

    /* `% 0` is NaN. Moving the selection with nothing matching used to put it
       somewhere no render could ever highlight again — the list stayed dead
       even after the query was cleared. */
    it('survives the arrow keys with no matches', () => {
        TabSearch.show(files, () => {});
        type('nothing matches this');
        expect(items()).toHaveLength(0);

        key('ArrowDown');
        key('ArrowUp');
        key('End');

        type('File3');
        expect(selected(), 'the list stopped highlighting anything').not.toBeNull();
        expect(selected().textContent).toContain('File3.js');
    });
});

describe('choosing one', () => {
    it('hands back the index into the ORIGINAL list, not the filtered one', () => {
        const onSelect = vi.fn();
        TabSearch.show(files, onSelect);
        type('File7');
        key('Enter');
        expect(onSelect).toHaveBeenCalledWith(7);
        expect(document.getElementById('tab-search-overlay')).toBeNull();
    });

    it('closes on Escape without choosing', () => {
        const onSelect = vi.fn();
        TabSearch.show(files, onSelect);
        key('Escape');
        expect(onSelect).not.toHaveBeenCalled();
        expect(document.getElementById('tab-search-overlay')).toBeNull();
    });

    it('does nothing on Enter when nothing matches', () => {
        const onSelect = vi.fn();
        TabSearch.show(files, onSelect);
        type('zzz');
        key('Enter');
        expect(onSelect).not.toHaveBeenCalled();
    });
});
