import { describe, it, expect, vi } from 'vitest';
import { createModifierTap } from '../src/modules/utils/ModifierTap.js';

/* The Markdown toolbar's Alt hints got this wrong twice, and both times the
   code looked right. Acting on the keydown meant Alt+Tab left the overlay up.
   Requiring a 500ms hold meant a quick press did nothing — and a long one
   showed the overlay and then hid it again, because holding a key repeats its
   keydown and every repeat after the timer had fired read as a second press.

   Neither failure is visible in the shape of the code, only in the sequence of
   events. So the rule lives in a function that can be handed a sequence. */

const tap = (onTap = vi.fn()) => ({ det: createModifierTap({ key: 'Alt', onTap }), onTap });

const down = (key, opts = {}) => ({ key, repeat: false, ...opts });
const up = (key) => ({ key });

describe('a tap of Alt', () => {
    it('fires on the release, not on the press', () => {
        const { det, onTap } = tap();
        det.keydown(down('Alt'));
        // Nothing yet: at this point the press is indistinguishable from the
        // start of Alt+Tab.
        expect(onTap).not.toHaveBeenCalled();
        det.keyup(up('Alt'));
        expect(onTap).toHaveBeenCalledTimes(1);
    });

    it('fires once however long the key is held', () => {
        // The repeat bug, exactly: holding Alt sends keydown over and over,
        // and the overlay appeared and then vanished while the key was still
        // down. A repeat is the same press and must change nothing.
        const { det, onTap } = tap();
        det.keydown(down('Alt'));
        for (let i = 0; i < 25; i++) det.keydown(down('Alt', { repeat: true }));
        det.keyup(up('Alt'));
        expect(onTap).toHaveBeenCalledTimes(1);
    });

    it('fires however briefly the key is held', () => {
        // No threshold to be under. A press too quick to register reads as a
        // key that does not work.
        const { det, onTap } = tap();
        det.keydown(down('Alt'));
        det.keyup(up('Alt'));
        expect(onTap).toHaveBeenCalledTimes(1);
    });

    it('fires again on the next tap, so the same key closes it', () => {
        const { det, onTap } = tap();
        det.keydown(down('Alt'));
        det.keyup(up('Alt'));
        det.keydown(down('Alt'));
        det.keyup(up('Alt'));
        expect(onTap).toHaveBeenCalledTimes(2);
    });
});

describe('what is not a tap', () => {
    it('Alt+Tab', () => {
        // The one that started all this. Tab arrives while Alt is still down.
        const { det, onTap } = tap();
        det.keydown(down('Alt'));
        det.keydown(down('Tab', { altKey: true }));
        det.keyup(up('Tab'));
        det.keyup(up('Alt'));
        expect(onTap).not.toHaveBeenCalled();
    });

    it('Alt+Tab where the release never comes back', () => {
        // The usual shape of it: the window is gone by the time Alt is let go,
        // so the keyup is delivered somewhere else entirely.
        const { det, onTap } = tap();
        det.keydown(down('Alt'));
        det.keydown(down('Tab', { altKey: true }));
        det.disarm();                       // window blur
        det.keyup(up('Alt'));               // if it ever arrives
        expect(onTap).not.toHaveBeenCalled();
    });

    it('Ctrl+Alt+L, whichever order the modifiers arrive in', () => {
        const { det, onTap } = tap();
        det.keydown(down('Control'));
        det.keydown(down('Alt', { ctrlKey: true }));
        det.keydown(down('l', { ctrlKey: true, altKey: true }));
        det.keyup(up('l'));
        det.keyup(up('Alt'));
        expect(onTap).not.toHaveBeenCalled();

        // Alt first, then Ctrl.
        const b = tap();
        b.det.keydown(down('Alt'));
        b.det.keydown(down('Control', { altKey: true }));
        b.det.keydown(down('l', { ctrlKey: true, altKey: true }));
        b.det.keyup(up('Alt'));
        expect(b.onTap).not.toHaveBeenCalled();
    });

    it('Alt with Shift or the Windows key held', () => {
        for (const mod of ['shiftKey', 'metaKey']) {
            const { det, onTap } = tap();
            det.keydown(down('Alt', { [mod]: true }));
            det.keyup(up('Alt'));
            expect(onTap, mod).not.toHaveBeenCalled();
        }
    });

    it('Alt and then a click — that is a drag, not a tap', () => {
        const { det, onTap } = tap();
        det.keydown(down('Alt'));
        det.disarm();                       // pointerdown
        det.keyup(up('Alt'));
        expect(onTap).not.toHaveBeenCalled();
    });

    it('a release with no press behind it', () => {
        // Pressing Alt in another window and releasing it over this one.
        const { det, onTap } = tap();
        det.keyup(up('Alt'));
        expect(onTap).not.toHaveBeenCalled();
    });

    it('some other key entirely', () => {
        const { det, onTap } = tap();
        det.keydown(down('b'));
        det.keyup(up('b'));
        expect(onTap).not.toHaveBeenCalled();
    });
});

describe('the detector reports its own state', () => {
    it('is armed only between a bare press and whatever ends it', () => {
        const { det } = tap();
        expect(det.isArmed()).toBe(false);
        det.keydown(down('Alt'));
        expect(det.isArmed()).toBe(true);
        det.keydown(down('Tab', { altKey: true }));
        expect(det.isArmed()).toBe(false);
    });

    it('survives being built with no handler at all', () => {
        const det = createModifierTap();
        det.keydown(down('Alt'));
        expect(() => det.keyup(up('Alt'))).not.toThrow();
    });

    it('can watch a key other than Alt', () => {
        const onTap = vi.fn();
        const det = createModifierTap({ key: 'Shift', onTap });
        det.keydown(down('Shift'));
        det.keyup(up('Shift'));
        expect(onTap).toHaveBeenCalledTimes(1);
    });
});
