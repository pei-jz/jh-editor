/**
 * ModalKeys.js — the keyboard contract every modal in the app honours.
 *
 * Each dialog had grown its own key handling, so which keys worked depended on
 * which dialog you were in: Tab escaped some of them into the editor behind,
 * arrow keys moved nothing, and because a programmatically focused button did
 * not always draw a focus ring, pressing Enter was a guess about which button
 * would fire. That last one is the worst kind of bug — it does not look broken,
 * it just occasionally does the other thing.
 *
 * The contract, in one place:
 *
 *   Escape          cancel
 *   Enter           activate the focused button; otherwise the default action
 *   Tab / Shift+Tab cycle focus INSIDE the modal, never out of it
 *   ← →             move between the action buttons
 *   ↑ ↓             the same, for a modal whose buttons stack
 *   Home / End      first / last action button
 *
 * Arrow keys only move between buttons when focus is already ON one. A text
 * field owns its caret, and stealing ← → from it would be a worse bug than the
 * one this fixes.
 *
 * A control inside the modal can opt out of Enter/Escape by carrying
 * `data-dialog-keys="own"` — an open combobox list, for instance, where Enter
 * picks an option rather than confirming the dialog.
 */

const FOCUSABLE = 'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Is this element actually on screen?
 *
 * NOT `offsetParent !== null`, which is the usual shorthand: jsdom reports null
 * for everything, so under test that shorthand hides every control and the
 * focus cycle silently becomes empty. Walking for `hidden` and an inline
 * `display: none` covers what this codebase actually does to hide a pane — a
 * settings tab, a collapsed section — and behaves the same in both.
 */
function isVisible(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.hidden) return false;
        if (n.style && n.style.display === 'none') return false;
        if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
}

/** Visible, focusable controls inside `root`, in tab order. */
export function focusablesIn(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll(FOCUSABLE))
        .filter((el) => !el.disabled && isVisible(el));
}

function ownsKeys(el) {
    return !!(el && typeof el.closest === 'function' && el.closest('[data-dialog-keys="own"]'));
}

function isTextEntry(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag !== 'INPUT') return false;
    return !['button', 'submit', 'reset', 'checkbox', 'radio'].includes((el.type || 'text').toLowerCase());
}

/**
 * Install the contract on a modal.
 *
 * @param {Element} root  the modal box (not the backdrop) — the focus trap's boundary
 * @param {object} opts
 * @param {() => void} [opts.onCancel]   Escape, and the backdrop if the caller wires it
 * @param {() => void} [opts.onDefault]  Enter with no button focused
 * @param {string} [opts.buttonSelector] which buttons the arrows walk; defaults
 *   to the action row, falling back to every button in the modal
 * @param {(e: KeyboardEvent) => boolean} [opts.shouldIgnore]  caller's own escape hatch
 * @returns {() => void} dispose
 */
export function installModalKeys(root, opts = {}) {
    const {
        onCancel = null,
        onDefault = null,
        buttonSelector = '.app-dialog-actions button, .modal-actions button, .input-actions button',
        shouldIgnore = null,
    } = opts;

    const actionButtons = () => {
        const scoped = Array.from(root.querySelectorAll(buttonSelector))
            .filter((b) => !b.disabled && isVisible(b));
        if (scoped.length) return scoped;
        return Array.from(root.querySelectorAll('button'))
            .filter((b) => !b.disabled && isVisible(b));
    };

    const moveButton = (delta) => {
        const btns = actionButtons();
        if (btns.length < 2) return false;
        const i = btns.indexOf(document.activeElement);
        if (i === -1) return false;                 // focus is not on a button
        const next = (i + delta + btns.length) % btns.length;
        btns[next].focus();
        return true;
    };

    const onKey = (e) => {
        if (shouldIgnore && shouldIgnore(e)) return;

        const target = e.target;
        const owns = ownsKeys(target);

        if (e.key === 'Escape') {
            if (owns) return;
            e.preventDefault();
            e.stopPropagation();
            if (onCancel) onCancel();
            return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            if (owns) return;
            // A multi-line field keeps Enter for itself.
            if (target && target.tagName === 'TEXTAREA') return;
            e.preventDefault();
            e.stopPropagation();
            const active = document.activeElement;
            if (active && active.tagName === 'BUTTON' && root.contains(active) && !active.disabled) {
                active.click();
            } else if (onDefault) {
                onDefault();
            }
            return;
        }

        if (e.key === 'Tab') {
            const items = focusablesIn(root);
            if (!items.length) return;
            e.preventDefault();
            e.stopPropagation();
            const i = items.indexOf(document.activeElement);
            const last = items.length - 1;
            const next = e.shiftKey
                ? (i <= 0 ? last : i - 1)
                : (i === -1 || i === last ? 0 : i + 1);
            items[next].focus();
            return;
        }

        // Arrows walk the action row — but only from a button. In a text field
        // they belong to the caret.
        if (!isTextEntry(document.activeElement) && !owns) {
            let delta = 0;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') delta = 1;
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') delta = -1;

            if (delta && moveButton(delta)) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            if (e.key === 'Home' || e.key === 'End') {
                const btns = actionButtons();
                if (btns.length && btns.indexOf(document.activeElement) !== -1) {
                    e.preventDefault();
                    e.stopPropagation();
                    btns[e.key === 'Home' ? 0 : btns.length - 1].focus();
                    return;
                }
            }
        }

        // Nothing else may reach the editor behind the modal. Typing into a
        // dialog must not also type into the document.
        if (!root.contains(e.target)) {
            e.stopPropagation();
        }
    };

    // Capture phase on document: ShortcutManager listens on window with
    // capture too, so anything less would let Escape and Enter fire an app
    // command behind the dialog as well as acting on it.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
}

/**
 * Give a modal a starting focus, so the keys above have a defined subject.
 *
 * Order: an explicit target, then a text field (people type first), then the
 * primary button, then anything focusable. `focus-visible` is forced on,
 * because a programmatic focus does not set it in Chromium — which is exactly
 * why a Tab-then-Enter felt like a guess: the ring only appeared after the
 * SECOND key.
 */
export function focusModal(root, preferred = null) {
    if (!root) return null;
    const target = preferred
        || root.querySelector('input:not([type="hidden"]), textarea')
        || root.querySelector('button.primary, .app-dialog-btn.primary, [data-default]')
        || focusablesIn(root)[0];
    if (!target) return null;
    target.focus({ preventScroll: true });
    if (target.select && target.tagName === 'INPUT') {
        try { target.select(); } catch (_) { /* not a selectable type */ }
    }
    root.classList.add('modal-keys-active');
    return target;
}

export default { installModalKeys, focusModal, focusablesIn };
