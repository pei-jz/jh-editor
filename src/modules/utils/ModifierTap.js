/**
 * ModifierTap.js — "was that a TAP of Alt, or the start of Alt+something?"
 *
 * Windows answers this every time you press Alt in a window with a menu bar:
 * tapped on its own, it underlines the access keys; pressed as part of Alt+Tab
 * or Alt+F4, it does not. The rule it uses is the one here — act on the
 * RELEASE, and only if nothing disturbed the key while it was down.
 *
 * The Markdown toolbar's hint overlay tried two other rules first and both
 * failed in ways worth recording, because they are the obvious ones:
 *
 *   - Act on the keydown. A bare Alt is the first half of every combination
 *     the window manager owns, so switching windows put the overlay up — and
 *     LEFT it up, because the keyup went to whatever took the focus.
 *
 *   - Require the key to be HELD for a threshold. That fixed the window
 *     switch and bought two problems: a duration nobody can feel (too quick
 *     and nothing happens, which reads as a broken key), and the overlay
 *     flickering off again, because holding a key repeats its keydown and
 *     every repeat after the timer had fired was read as a second press.
 *
 * Waiting for the release needs no threshold and no repeat handling, and it
 * cannot fire for a combination: the other key arrives first and disarms it.
 *
 * Kept apart from the view because it is a four-line state machine that was
 * wrong twice. It is worth being able to test it without a DOM.
 */

/**
 * @param {object}   options
 * @param {string}   [options.key='Alt']  the KeyboardEvent.key to watch
 * @param {Function} options.onTap        called once per completed tap
 * @returns {{ keydown(e): void, keyup(e): void, disarm(): void, isArmed(): boolean }}
 */
export function createModifierTap({ key = 'Alt', onTap } = {}) {
    let armed = false;

    /** True when this event is the watched key with no other modifier held. */
    const isBare = (e) => e.key === key
        && !(key !== 'Control' && e.ctrlKey)
        && !(key !== 'Meta' && e.metaKey)
        && !(key !== 'Shift' && e.shiftKey)
        && !(key !== 'Alt' && e.altKey);

    return {
        keydown(e) {
            if (isBare(e)) {
                // A repeat is still the same press: it neither re-arms the
                // detector nor counts as the "something else" that clears it.
                if (!e.repeat) armed = true;
                return;
            }
            // Anything else — including the watched key inside a combination —
            // means this press was never a bare tap.
            armed = false;
        },

        keyup(e) {
            if (e.key !== key) return;
            if (!armed) return;
            armed = false;
            if (typeof onTap === 'function') onTap();
        },

        /**
         * Abandon the press without firing. For the cases the keyboard cannot
         * report: a click part way through, or the window going inactive —
         * which is the Alt+Tab case itself, where the release is delivered to
         * another window and never comes back.
         */
        disarm() {
            armed = false;
        },

        isArmed() {
            return armed;
        },
    };
}
