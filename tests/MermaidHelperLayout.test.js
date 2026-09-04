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
        // By name, not by position: the header gains buttons, and an index
        // silently starts pointing at the wrong one.
        btn: (label) => {
            const found = [...overlay.querySelectorAll('.mh-head-btn')]
                .find((b) => b.textContent === label);
            expect(found, `no header button labelled ${label}`).toBeTruthy();
            return found;
        },
    };
};

describe('making room in the mermaid dialog', () => {
    it('can fill the window', () => {
        const d = open();
        const btn = d.btn('Full screen');

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
            d.btn('Full screen').click();

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
        const btn = d.btn('Side preview');

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

        d.btn('Side preview').click();
        expect(d.editor.style.height).toBe('');
        expect(d.editor.style.width).toBe('');
    });

    it('can fold the side columns away', () => {
        const d = open();
        const typesBtn = d.btn('Types');
        const partsBtn = d.btn('Parts');

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
        const typesBtn = d.btn('Types');
        const partsBtn = d.btn('Parts');

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

describe('choosing colours', () => {
    const directive = (el) => (el.value.match(/^%%\{init:.*?\}%%/) || [''])[0];
    const styleSelect = (d) => d.overlay.querySelector('.mh-style select');
    const swatch = (d, key) => d.overlay.querySelector(`input[data-key="${key}"]`);
    const change = (el) => el.dispatchEvent(new Event('change'));

    // The style is written into the diagram, not kept as an app setting, so it
    // travels with the document and renders the same wherever it is read.
    it('writes the palette into the diagram', () => {
        const d = open('graph TD\n  A --> B');
        const sel = styleSelect(d);

        sel.value = 'forest';
        change(sel);

        expect(directive(d.editor)).toContain('"theme":"forest"');
        expect(d.editor.value, 'the diagram itself must survive').toContain('A --> B');
    });

    // Only `base` reads themeVariables; under a named palette the swatches
    // would sit there doing nothing.
    it('offers the swatches only where they apply', () => {
        const d = open();
        const sel = styleSelect(d);
        const wrap = swatch(d, 'primaryColor').parentElement.parentElement;

        sel.value = 'neutral';
        change(sel);
        expect(wrap.style.display).toBe('none');

        sel.value = 'base';
        change(sel);
        expect(wrap.style.display).toBe('flex');
    });

    it('carries the chosen colours', () => {
        const d = open('graph TD\n  A --> B');
        const sel = styleSelect(d);
        sel.value = 'base';
        change(sel);

        const fill = swatch(d, 'primaryColor');
        fill.value = '#ffcc00';
        fill.dispatchEvent(new Event('input'));

        expect(directive(d.editor)).toContain('"primaryColor":"#ffcc00"');
    });

    // mermaid reads the first directive, so a second one is dead weight that
    // silently wins or loses depending on order.
    it('replaces the directive rather than piling them up', () => {
        const d = open('graph TD\n  A --> B');
        const sel = styleSelect(d);

        for (const v of ['forest', 'dark', 'neutral']) {
            sel.value = v;
            change(sel);
        }

        expect((d.editor.value.match(/%%\{init:/g) || []).length).toBe(1);
        expect(directive(d.editor)).toContain('"theme":"neutral"');
    });

    it('takes the palette back off again', () => {
        const d = open('graph TD\n  A --> B');
        const sel = styleSelect(d);

        sel.value = 'dark';
        change(sel);
        sel.value = '';
        change(sel);

        expect(d.editor.value).not.toContain('%%{init:');
        expect(d.editor.value.trim()).toBe('graph TD\n  A --> B');
    });

    // Opening the dialog on a diagram that already carries a style must not
    // quietly reset it.
    it('reads back a style the diagram already has', () => {
        const d = open('%%{init: {"theme":"base","themeVariables":{"primaryColor":"#123456"}}}%%\n'
            + 'graph TD\n  A --> B');

        expect(styleSelect(d).value).toBe('base');
        expect(swatch(d, 'primaryColor').value).toBe('#123456');
    });
});
