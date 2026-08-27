import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { RegexPresets, BUILTIN_PRESETS } from '../src/modules/ui/RegexPresets.js';
import { showRegexPicker, closeRegexPicker } from '../src/modules/ui/RegexPicker.js';

/* The keyboard here was covered by reading RegexPicker.js for `case 'ArrowDown'`
   and friends. That passes whether or not the key does anything — which is
   exactly how "Down does nothing while a section is folded" survived a green
   suite: the case existed, and the row it moved onto was `display:none` and
   could not take focus. So this drives the real panel. */

const key = (k, opts = {}) => document.querySelector('.regex-picker')
    .dispatchEvent(new KeyboardEvent('keydown', {
        key: k, bubbles: true, cancelable: true, ...opts,
    }));

const focused = () => document.activeElement;
const label = (el) => (el && el.textContent ? el.textContent.trim() : '');
const heads = () => [...document.querySelectorAll('.regex-group-head')];
const items = () => [...document.querySelectorAll('.regex-item')];

/** Open the panel over a stub button, with one known library. */
function open(onPick = () => {}) {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    return showRegexPicker(anchor, onPick);
}

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    // Stand the panel up over a library this test controls. The shipped
    // presets are covered by their own tests; here they would just make every
    // count and every arrow-key step depend on how many ship today.
    for (const p of BUILTIN_PRESETS) RegexPresets.remove(p.id);
    // Two categories, so "the second one starts folded" is observable.
    RegexPresets.add('Alpha one', 'a1', 'Common');
    RegexPresets.add('Alpha two', 'a2', 'Common');
    RegexPresets.add('Zed one', 'z1', 'Zeta');
});

afterEach(() => closeRegexPicker());

describe('opening', () => {
    // Everything open is thirty-eight rows: taller than the window, and the
    // category names are the first thing scrolled off.
    it('starts with only the first category expanded', () => {
        open();
        const open0 = heads().map((h) => h.dataset.open);
        expect(open0[0]).toBe('true');
        expect(open0.slice(1).every((v) => v === 'false')).toBe(true);
        // ...so only the first category's rows are on screen.
        expect(items().length).toBe(2);
    });

    it('puts the keyboard in the filter box', () => {
        open();
        expect(focused().className).toContain('regex-picker-filter');
    });
});

describe('walking it with the arrow keys', () => {
    it('goes from the filter box into the list and back up', () => {
        open();
        key('ArrowDown');
        expect(focused().className).toContain('regex-group-head');
        key('ArrowDown');
        expect(label(focused())).toContain('Alpha one');
        key('ArrowUp');
        expect(focused().className).toContain('regex-group-head');
    });

    // THE bug: a folded group left its rows in the document, the arrow keys
    // stepped onto a button that cannot take focus, and Down appeared dead.
    it('steps over a folded category instead of into it', () => {
        open();
        key('ArrowDown');                       // Common heading
        key('ArrowDown'); key('ArrowDown');     // its two rows
        key('ArrowDown');                       // must reach the Zeta heading
        expect(focused().className).toContain('regex-group-head');
        expect(label(focused())).toContain('Zeta');

        // And there is nowhere further to go: the folded rows do not exist.
        key('ArrowDown');
        expect(label(focused())).toContain('Zeta');
    });

    it('opens a category with Right and closes it with Left', () => {
        open();
        // Walk to the folded second heading.
        for (let i = 0; i < 4; i++) key('ArrowDown');
        expect(focused().dataset.open).toBe('false');

        key('ArrowRight');
        expect(focused().dataset.open).toBe('true');
        expect(items().length).toBe(3);
        // Focus stays on the heading it just toggled.
        expect(label(focused())).toContain('Zeta');

        key('ArrowLeft');
        expect(focused().dataset.open).toBe('false');
        expect(items().length).toBe(2);
    });

    it('goes from a row back up to its own heading with Left', () => {
        open();
        key('ArrowDown'); key('ArrowDown');
        expect(label(focused())).toContain('Alpha one');
        key('ArrowLeft');
        expect(focused().className).toContain('regex-group-head');
        expect(label(focused())).toContain('Common');
    });

    // Home and End belong to the FILTER BOX while the caret is in it — moving
    // the text cursor is what those keys mean in a text field. They walk the
    // list only once the keyboard has left the box.
    it('leaves Home and End to the filter box', () => {
        open();
        key('Home');
        expect(focused().className).toContain('regex-picker-filter');
    });

    it('jumps to the ends of the list once focus is in it', () => {
        open();
        key('ArrowDown');
        key('End');
        expect(label(focused())).toContain('Zeta');
        key('Home');
        expect(label(focused())).toContain('Common');
    });
});

/* Tab used to leave the panel entirely and land in the window behind it,
   toggling the explorer. A popup owns the keyboard while it is up. */
describe('Tab', () => {
    it('cycles inside the panel instead of escaping it', () => {
        open();
        const inside = () => document.querySelector('.regex-picker').contains(focused());

        for (let i = 0; i < 8; i++) {
            key('Tab');
            expect(inside(), `after ${i + 1} tabs`).toBe(true);
        }
        for (let i = 0; i < 8; i++) {
            key('Tab', { shiftKey: true });
            expect(inside(), `after ${i + 1} back-tabs`).toBe(true);
        }
    });

    it('reaches the filter box on the way round', () => {
        open();
        let sawFilter = false;
        for (let i = 0; i < 6; i++) {
            key('Tab');
            if (focused().className.includes('regex-picker-filter')) sawFilter = true;
        }
        expect(sawFilter).toBe(true);
    });
});

describe('filtering', () => {
    const type = (text) => {
        const box = document.querySelector('.regex-picker-filter');
        box.value = text;
        box.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // A hit hidden inside a folded section reads as no hit at all.
    it('reaches into a folded category', () => {
        open();
        expect(items().length).toBe(2);   // Zeta is folded
        type('z1');
        expect(items().length).toBe(1);
        expect(label(items()[0])).toContain('Zed one');
    });

    it('says so rather than showing an empty panel', () => {
        open();
        type('nothing matches this');
        expect(items().length).toBe(0);
        expect(document.querySelector('.regex-picker-empty').textContent)
            .toContain('No sample matches');
    });

    it('takes the first hit on Enter', () => {
        let picked = null;
        open((p) => { picked = p; });
        type('z1');
        document.querySelector('.regex-picker-filter')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(picked).toBe('z1');
        expect(document.querySelector('.regex-picker')).toBeNull();
    });
});

describe('picking and closing', () => {
    it('hands back the pattern and closes', () => {
        let picked = null;
        open((p) => { picked = p; });
        key('ArrowDown'); key('ArrowDown');
        focused().click();
        expect(picked).toBe('a1');
        expect(document.querySelector('.regex-picker')).toBeNull();
    });

    it('closes on Escape without picking anything', () => {
        let picked = null;
        open((p) => { picked = p; });
        key('Escape');
        expect(document.querySelector('.regex-picker')).toBeNull();
        expect(picked).toBeNull();
    });

    // Opening a second one must not leave the first behind it.
    it('never leaves two panels open', () => {
        open();
        open();
        expect(document.querySelectorAll('.regex-picker').length).toBe(1);
    });
});
