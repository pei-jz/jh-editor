import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORTCUTS } from '../src/modules/core/ShortcutDefinitions.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

/* Two dialogs fill the window — the Markdown block editor and the Mermaid
   helper — and both could only be un-filled with the mouse, which is the one
   input you are least likely to reach for while typing a diagram.

   Both live inside their own overlay and are driven by their own key handler
   rather than by the global shortcut manager, so there is no registry to
   assert against. These hold the wiring in place instead. */

const markdown = read('src/modules/views/MarkdownView.js');
const mermaid = read('src/modules/ui/MermaidHelper.js');

/** The body of the overlay key handler in the Markdown block editor. */
const markdownOverlayKeys = () => {
    const i = markdown.indexOf("overlay.addEventListener('keydown'");
    expect(i, 'the block editor should have an overlay key handler').toBeGreaterThan(-1);
    return markdown.slice(i, markdown.indexOf('}, true);', i));
};

/** The body of the Mermaid helper's key handler. */
const mermaidKeys = () => {
    const i = mermaid.indexOf('const onKey = (e) => {');
    expect(i).toBeGreaterThan(-1);
    return mermaid.slice(i, mermaid.indexOf('\n        };', i));
};

describe('full screen has a key in both editors', () => {
    it('uses the same combination in each', () => {
        // One key for one idea. Learning it in the Markdown editor and finding
        // it missing in the Mermaid one is worse than never having it.
        for (const [name, body] of [['markdown', markdownOverlayKeys()], ['mermaid', mermaidKeys()]]) {
            expect(body, `${name}: Ctrl/Cmd required`).toMatch(/e\.ctrlKey \|\| e\.metaKey/);
            expect(body, `${name}: Alt required`).toContain('e.altKey');
            expect(body, `${name}: F`).toContain("'KeyF'");
        }
    });

    it('matches on the physical key as well as the character', () => {
        // Holding Alt changes the reported CHARACTER on several layouts while
        // the physical key stays put, which is why `e.code` is checked too.
        for (const [name, body] of [['markdown', markdownOverlayKeys()], ['mermaid', mermaidKeys()]]) {
            expect(body, name).toMatch(/e\.code === 'KeyF'/);
            expect(body, name).toMatch(/String\(e\.key\)\.toLowerCase\(\) === 'f'/);
        }
    });

    it('lets Escape step out of full screen before it closes anything', () => {
        // Full screen is the state where the dialog covers everything, so it
        // is also where a reflex Escape is likeliest. Throwing away a half
        // written block or diagram to that key is not a trade anyone picks.
        const md = markdownOverlayKeys();
        expect(md).toMatch(/e\.key === 'Escape' && isFullScreen\(\)/);
        expect(md).toContain('setFullScreen(false)');

        const mm = mermaidKeys();
        expect(mm).toMatch(/if \(isMax\(\)\) setMax\(false\);\s*\n\s*else close\(\);/);
    });

    it('says the key on the button, so it can be found without the guide', () => {
        expect(markdown).toContain("maxBtn.title = `${t('Fill the window')} (Ctrl+Alt+F)`");
        expect(mermaid).toContain("`${t('Fill the window')} (Ctrl+Alt+F)`");
    });

    it('is listed in the Markdown shortcut guide', () => {
        const entry = SHORTCUTS.MARKDOWN.find((s) => s.key === 'f' && s.ctrl && s.alt);
        expect(entry, 'Ctrl+Alt+F should be documented').toBeTruthy();
        expect(entry.description).toMatch(/full screen/i);
        // Documentation-only: the modal handles the key on its own overlay, so
        // a cmd here would route it through the global manager as well.
        expect(entry.cmd).toBeUndefined();
    });
});

describe('the Alt toolbar hints are wired to a tap', () => {
    // What a tap IS lives in tests/ModifierTap.test.js, where it can be handed
    // a sequence of events. These only check that the editor is plugged into
    // it — and into the two things a keyboard cannot report on its own.

    it('drives the overlay from the tap detector, not from a timer', () => {
        expect(markdown).toContain("createModifierTap({ key: 'Alt'");
        expect(markdown).toContain('altTap.keydown(e)');
        expect(markdown).toContain('altTap.keyup(e)');
        // A threshold is what the previous version used, and it gave the user
        // a duration to guess at: too quick and nothing happened at all.
        expect(markdown).not.toContain('ALT_HOLD_MS');
    });

    it('abandons the press on a click', () => {
        // Alt and then a click is a drag gesture. The keyboard sees only a
        // clean press and release and would call it a tap.
        expect(markdown).toContain("container.addEventListener('pointerdown', handlePointerDown)");
        expect(markdown).toMatch(/handlePointerDown = \(\) => altTap\.disarm\(\)/);
    });

    it('abandons the press, and the overlay, when the window goes inactive', () => {
        // The Alt+Tab case itself: the release is delivered to whatever took
        // the focus, so nothing here ever sees it.
        expect(markdown).toContain("window.addEventListener('blur', handleWindowBlur)");
        expect(markdown).toMatch(/const handleWindowBlur = \(\) => \{[\s\S]*?altTap\.disarm\(\);[\s\S]*?toggleAltHints\(false\);/);
    });

    it('takes the window listener back down with the modal', () => {
        // The container is thrown away when the modal closes; the window is
        // not, so a listener left on it outlives every edit.
        expect(markdown).toContain("window.removeEventListener('blur', handleWindowBlur)");
        expect(markdown).toMatch(/_closeEditModal\(\) \{\s*\n\s*this\._altHintCleanup\?\.\(\);/);
    });

    it('says in the guide what the key actually does', () => {
        const entry = SHORTCUTS.MARKDOWN.find((sc) => sc.key === 'Alt');
        expect(entry).toBeTruthy();
        // It said "(hold)" for as long as it did not hold, and then for as
        // long as it did. Now it says what it is.
        expect(entry.description).toMatch(/tap/i);
    });
});
