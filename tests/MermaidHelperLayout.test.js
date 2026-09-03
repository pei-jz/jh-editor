/* The mermaid dialog's layout controls and its source field.
 *
 * These are the parts a person reaches for when the diagram stops fitting:
 * a flowchart grows sideways, the window does not, and the preview underneath
 * squeezes both halves. Everything here is about getting room.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MermaidHelper } from '../src/modules/ui/MermaidHelper.js';

/** The dialog renders a preview on open; there is no mermaid bundle in jsdom. */
beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    document.getElementById('mermaid-helper-overlay')?.remove();
    vi.restoreAllMocks();
});

const open = (code = 'flowchart TD\n  A --> B') => {
    MermaidHelper.show(() => {}, code);
    const overlay = document.getElementById('mermaid-helper-overlay');
    expect(overlay, 'the dialog did not open').toBeTruthy();
    return {
        overlay,
        box: overlay.querySelector('.mh-box'),
        center: overlay.querySelector('.mh-center'),
        editor: overlay.querySelector('.mh-editor'),
        types: overlay.querySelector('.mh-types'),
        cheat: overlay.querySelector('.mh-cheat'),
        btn: (label) => [...overlay.querySelectorAll('.mh-head-btn')]
            .find((b) => b.title && b.title.length > 0 && b.textContent === label),
    };
};

describe('making room in the mermaid dialog', () => {
    it('can fill the window', () => {
        const d = open();
        const btn = [...d.overlay.querySelectorAll('.mh-head-btn')].at(-1);

        expect(d.box.classList.contains('mh-max')).toBe(false);
        btn.click();
        expect(d.box.classList.contains('mh-max')).toBe(true);
        btn.click();
        expect(d.box.classList.contains('mh-max')).toBe(false);
    });

    // At 100vh the dialog covered the title bar, taking the window's own close
    // button with it. The bar's height is measured rather than assumed: it
    // moves with the theme and the display scale.
    it('starts below the title bar when filled', () => {
        const bar = document.createElement('div');
        bar.id = 'custom-titlebar';
        document.body.appendChild(bar);
        try {
            const d = open();
            [...d.overlay.querySelectorAll('.mh-head-btn')].at(-1).click();

            expect(d.overlay.classList.contains('mh-max-overlay')).toBe(true);
            expect(d.overlay.style.getPropertyValue('--mh-top')).toMatch(/^\d+px$/);
        } finally {
            bar.remove();
        }
    });

    // `resize: both` only grips the bottom-right corner, so widening the
    // dialog also dragged its height around.
    it('can be widened from either edge', () => {
        const d = open();
        expect(d.overlay.querySelector('.mh-edge-l')).toBeTruthy();
        expect(d.overlay.querySelector('.mh-edge-r')).toBeTruthy();
    });

    // Stacked, a wide flowchart squeezes the source and the preview alike.
    it('can put the preview beside the source', () => {
        const d = open();
        const btn = [...d.overlay.querySelectorAll('.mh-head-btn')].at(-2);

        btn.click();
        expect(d.center.classList.contains('mh-side')).toBe(true);
        btn.click();
        expect(d.center.classList.contains('mh-side')).toBe(false);
    });

    // A height dragged in the stacked layout would apply as a width once the
    // panes sit side by side, so the pane opens already collapsed.
    it('drops a dragged size when the orientation changes', () => {
        const d = open();
        d.editor.style.height = '300px';

        [...d.overlay.querySelectorAll('.mh-head-btn')].at(-2).click();
        expect(d.editor.style.height).toBe('');
        expect(d.editor.style.width).toBe('');
    });

    it('can fold the side columns away', () => {
        const d = open();
        const [typesBtn, partsBtn] = d.overlay.querySelectorAll('.mh-head-btn');

        typesBtn.click();
        expect(d.types.classList.contains('mh-collapsed')).toBe(true);
        partsBtn.click();
        expect(d.cheat.classList.contains('mh-collapsed')).toBe(true);

        typesBtn.click();
        partsBtn.click();
        expect(d.types.classList.contains('mh-collapsed')).toBe(false);
        expect(d.cheat.classList.contains('mh-collapsed')).toBe(false);
    });

    // A folded column leaves its splitter behind otherwise: a 5px strip with
    // a resize cursor sitting against nothing.
    it('folds each splitter with its column', () => {
        const d = open();
        const splits = d.overlay.querySelectorAll('.mh-split');
        const [typesBtn, partsBtn] = d.overlay.querySelectorAll('.mh-head-btn');

        typesBtn.click();
        expect(splits[0].classList.contains('mh-collapsed')).toBe(true);
        partsBtn.click();
        expect(splits[1].classList.contains('mh-collapsed')).toBe(true);
    });
});

describe('the mermaid source field', () => {
    const tab = (el) => {
        el.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Tab', bubbles: true, cancelable: true,
        }));
    };

    // mermaid nests by indentation. Tab moved focus out of the field, so the
    // only way to indent a subgraph was to hold the space bar.
    it('indents instead of leaving the field', () => {
        const d = open('flowchart TD');
        d.editor.value = 'flowchart TD';
        d.editor.selectionStart = d.editor.selectionEnd = d.editor.value.length;

        tab(d.editor);

        expect(d.editor.value).toBe('flowchart TD  ');
        expect(document.activeElement).toBe(d.editor);
    });

    it('indents every line of a selection', () => {
        const d = open();
        d.editor.value = 'A --> B\nB --> C';
        d.editor.selectionStart = 0;
        d.editor.selectionEnd = d.editor.value.length;

        tab(d.editor);

        expect(d.editor.value).toBe('  A --> B\n  B --> C');
    });

    // Shift+Tab is the way back out, so the field is never a trap.
    it('leaves Shift+Tab alone', () => {
        const d = open();
        const before = d.editor.value;
        d.editor.focus();
        const ev = new KeyboardEvent('keydown', {
            key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
        });
        document.dispatchEvent(ev);

        expect(d.editor.value).toBe(before);
        expect(ev.defaultPrevented).toBe(false);
    });
});
