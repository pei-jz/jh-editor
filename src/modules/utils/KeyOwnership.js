/**
 * A popup that reads its own keys (the workspace menu: arrows, Enter, Escape,
 * Delete) marks itself `data-shortcut-keys="own"`.
 *
 * ShortcutManager honours the mark, but the views that listen on the WINDOW in
 * the capture phase (Markdown block navigation, book-mode page keys, the
 * structure tree) hear every key before the popup does. Each of them asks
 * here, so the arrows walk the menu instead of the document behind it.
 */
const OWN = '[data-shortcut-keys="own"]';

/** True when the key belongs to a popup that handles it itself. */
export function keyIsOwnedByPopup(e) {
    const inOwner = (el) => !!(el && typeof el.closest === 'function' && el.closest(OWN));
    return inOwner(e && e.target) || inOwner(typeof document !== 'undefined' ? document.activeElement : null);
}
