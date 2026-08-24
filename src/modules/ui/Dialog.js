/**
 * Dialog.js — themed replacements for the blocking browser/OS dialogs.
 *
 * `alert()` / `confirm()` and the Tauri dialog plugin's ask()/confirm()/message()
 * all draw an OS window that ignores the app's theme entirely — a grey Windows
 * box in the middle of the Bamboo Slip or Paper palette. Worse, Tauri replaces
 * `window.confirm` with an ASYNC version returning a Promise, so the classic
 * `if (!confirm(...)) return;` guard silently always passed.
 *
 * Everything here is in-page DOM styled from the theme's CSS variables, and
 * every function returns a Promise — so a call site reads the same as the
 * native one it replaced, minus the footgun:
 *
 *     await showAlert('Save failed');
 *     if (!await showConfirm('Discard changes?')) return;
 *     const name = await showPrompt('New name', { value: old });
 *
 * OS FILE PICKERS (dialog.open / dialog.save) are deliberately NOT covered:
 * those must stay native.
 */

let _styleInjected = false;

function _injectStyles() {
    if (_styleInjected) return;
    _styleInjected = true;
    const style = document.createElement('style');
    style.id = 'app-dialog-styles';
    style.textContent = `
    .app-dialog-overlay {
        position: fixed; inset: 0; z-index: 100000;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.42);
        backdrop-filter: blur(1.5px);
        animation: app-dialog-fade 0.12s ease-out;
    }
    @keyframes app-dialog-fade { from { opacity: 0; } to { opacity: 1; } }
    .app-dialog {
        min-width: 340px; max-width: min(560px, 90vw);
        max-height: 90vh;
        background: var(--bg-color);
        color: var(--text-color);
        border: 1px solid var(--border-color);
        border-radius: var(--radius, 6px);
        box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.35));
        font-family: var(--font-main);
        overflow: hidden;
        animation: app-dialog-pop 0.12s ease-out;
    }
    @keyframes app-dialog-pop { from { transform: translateY(-6px); } to { transform: none; } }
    .app-dialog-head {
        display: flex; align-items: center; gap: 9px;
        padding: 11px 16px;
        background: var(--bg-color-secondary);
        border-bottom: 1px solid var(--border-color);
        font-weight: 600; font-size: 13px;
    }
    /* The kind stripe is the only colour in the box, so the severity reads at a
       glance without an OS icon. */
    .app-dialog-kind { width: 3px; align-self: stretch; border-radius: 2px; background: var(--primary-color); }
    .app-dialog-kind.warning { background: var(--git-modified-color, #d9a44a); }
    .app-dialog-kind.error   { background: var(--code-color, #e06a52); }
    .app-dialog-kind.success { background: var(--git-staged-color, #86c68a); }
    .app-dialog-body {
        padding: 16px;
        font-size: 13px; line-height: 1.6;
        white-space: pre-wrap; word-break: break-word;
        max-height: 50vh; overflow: auto;
    }
    /* A control in the body may own a popup (a combobox list). Clipping it to a
       scrolling body would cut the popup in half, so let it escape. */
    .app-dialog-body.has-content { max-height: none; overflow: visible; }
    .app-dialog-input {
        width: 100%; margin-top: 12px; padding: 7px 9px;
        font-family: var(--editor-font-family); font-size: 13px;
        background: var(--bg-color-secondary);
        color: var(--text-color);
        border: 1px solid var(--border-color);
        border-radius: 4px; outline: none;
    }
    .app-dialog-input:focus { border-color: var(--primary-color); }
    .app-dialog-actions {
        display: flex; justify-content: flex-end; gap: 8px;
        padding: 11px 16px;
        background: var(--bg-color-secondary);
        border-top: 1px solid var(--border-color);
    }
    .app-dialog-btn {
        min-width: 84px; padding: 6px 14px;
        font-family: inherit; font-size: 12.5px;
        background: var(--bg-color);
        color: var(--text-color);
        border: 1px solid var(--border-color);
        border-radius: 4px; cursor: pointer;
    }
    .app-dialog-btn:hover { background: var(--hover-color); }
    .app-dialog-btn:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
    .app-dialog-btn.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: var(--active-tab-bg, #fff);
        font-weight: 600;
    }
    .app-dialog-btn.primary:hover { filter: brightness(1.1); }
    `;
    document.head.appendChild(style);
}

/**
 * The one dialog primitive. Everything public below is a thin wrapper.
 *
 * @param {object} opts
 * @param {string} opts.message          body text (newlines preserved)
 * @param {string} [opts.title]
 * @param {'info'|'warning'|'error'|'success'} [opts.kind]
 * @param {Array<{label: string, value: any, primary?: boolean, cancel?: boolean}>} opts.buttons
 *        `primary` is focused and fires on Enter; `cancel` fires on Escape /
 *        backdrop click / window close.
 * @param {object|null} [opts.input]     `{ value, placeholder, password }` to show a text field
 * @param {HTMLElement|null} [opts.content]  extra markup for the body (a form,
 *        a pair of <select>s…). The caller reads its own values on resolve.
 * @param {string} [opts.width]      CSS width for the box, when the default
 *        content-sized one is too cramped (a two-column form, say).
 * @returns {Promise<any>} the chosen button's `value`, or the input's text when
 *          `input` is set and a non-cancel button was pressed.
 */
export function showDialog({
    message, title = '', kind = 'info', buttons, input = null, content = null, width = '',
}) {
    _injectStyles();

    return new Promise((resolve) => {
        // Hand the keyboard back where it came from — dismissing a dialog must
        // not leave the editor unfocused.
        const returnFocusTo = document.activeElement;

        const overlay = document.createElement('div');
        overlay.className = 'app-dialog-overlay';

        const box = document.createElement('div');
        box.className = 'app-dialog';
        if (width) box.style.width = width;
        box.setAttribute('role', input ? 'dialog' : 'alertdialog');
        box.setAttribute('aria-modal', 'true');

        if (title) {
            const head = document.createElement('div');
            head.className = 'app-dialog-head';
            const stripe = document.createElement('span');
            stripe.className = `app-dialog-kind ${kind}`;
            const label = document.createElement('span');
            label.textContent = title;
            head.append(stripe, label);
            box.appendChild(head);
        }

        const body = document.createElement('div');
        body.className = 'app-dialog-body';
        body.textContent = message == null ? '' : String(message);

        if (content) {
            // The body scrolls by default, which would clip an absolutely
            // positioned dropdown belonging to a control inside `content`. Let
            // the box grow instead — the whole dialog is capped below.
            body.classList.add('has-content');
            body.appendChild(content);
        }

        let inputEl = null;
        if (input) {
            inputEl = document.createElement('input');
            inputEl.className = 'app-dialog-input';
            inputEl.type = input.password ? 'password' : 'text';
            inputEl.value = input.value == null ? '' : String(input.value);
            if (input.placeholder) inputEl.placeholder = input.placeholder;
            body.appendChild(inputEl);
        }
        box.appendChild(body);

        const actions = document.createElement('div');
        actions.className = 'app-dialog-actions';

        let primaryBtn = null;
        const cancelSpec = buttons.find((b) => b.cancel);
        const specOf = new Map();

        const close = (value) => {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            if (returnFocusTo && returnFocusTo.isConnected
                && typeof returnFocusTo.focus === 'function') {
                returnFocusTo.focus({ preventScroll: true });
            }
            resolve(value);
        };

        // A non-cancel button on an input dialog resolves with the TEXT, so
        // showPrompt() reads like the native prompt() it replaces.
        const pick = (spec) => close(
            inputEl && !spec.cancel ? inputEl.value : spec.value
        );

        for (const spec of buttons) {
            const btn = document.createElement('button');
            btn.className = 'app-dialog-btn' + (spec.primary ? ' primary' : '');
            btn.textContent = spec.label;
            btn.onclick = () => pick(spec);
            actions.appendChild(btn);
            specOf.set(btn, spec);
            if (spec.primary) primaryBtn = btn;
        }
        box.appendChild(actions);

        // Capture phase: ShortcutManager also listens on window with capture, so
        // without stopping the event here Escape/Enter would additionally fire
        // an app command behind the dialog.
        const onKey = (e) => {
            // A control inside the dialog can own Enter/Escape by marking itself
            // `data-dialog-keys="own"` — an open combobox list, for instance,
            // where Enter picks an option and Escape closes the list. This
            // listener is on document in the CAPTURE phase, so without the
            // opt-out it fires the primary button before the control ever sees
            // the key: choosing a branch would start the comparison instead.
            const target = e.target;
            if ((e.key === 'Enter' || e.key === 'Escape')
                && target && typeof target.closest === 'function'
                && target.closest('[data-dialog-keys="own"]')) {
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (cancelSpec) pick(cancelSpec);
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                // Whatever the user tabbed to wins; otherwise the primary
                // action. Always firing the primary would turn Tab-to-Cancel +
                // Enter into a confirmation.
                const spec = specOf.get(document.activeElement)
                    || buttons.find((b) => b.primary) || buttons[0];
                if (spec) pick(spec);
                return;
            }
            // Tab has to cycle INSIDE the dialog. The browser's own traversal
            // walks straight past the overlay into the editor behind it, which
            // both moved the caret down there and left the buttons unreachable
            // from the keyboard.
            if (e.key === 'Tab') {
                const focusables = Array.from(box.querySelectorAll(
                    'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'
                )).filter((el) => !el.disabled);
                if (!focusables.length) return;
                e.preventDefault();
                e.stopPropagation();
                const i = focusables.indexOf(document.activeElement);
                const last = focusables.length - 1;
                const next = e.shiftKey
                    ? (i <= 0 ? last : i - 1)
                    : (i === -1 || i === last ? 0 : i + 1);
                focusables[next].focus();
                return;
            }
            // Keep every other key inside the dialog — typing must not reach the
            // editor underneath.
            if (!box.contains(e.target)) {
                e.stopPropagation();
            }
        };
        document.addEventListener('keydown', onKey, true);

        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay && cancelSpec) pick(cancelSpec);
        });

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // The text field wins the focus when there is one; otherwise the
        // primary action, so Space/Enter act on it immediately.
        const firstInContent = content
            && content.querySelector('input, select, textarea, button');
        if (inputEl) { inputEl.focus(); inputEl.select(); }
        else if (firstInContent) firstInContent.focus();
        else if (primaryBtn) primaryBtn.focus();
    });
}

/** Themed `alert()`. Resolves when dismissed. */
export function showAlert(message, { title = 'Notice', kind = 'info', okLabel = 'OK' } = {}) {
    return showDialog({
        message, title, kind,
        buttons: [{ label: okLabel, value: undefined, primary: true, cancel: true }],
    });
}

/** Themed `confirm()`. Resolves true/false. */
export function showConfirm(message, {
    title = 'Confirm', kind = 'warning', okLabel = 'OK', cancelLabel = 'Cancel',
} = {}) {
    return showDialog({
        message, title, kind,
        buttons: [
            { label: cancelLabel, value: false, cancel: true },
            { label: okLabel, value: true, primary: true },
        ],
    });
}

/** Themed `prompt()`. Resolves the entered text, or null when cancelled. */
export function showPrompt(message, {
    title = 'Input', kind = 'info', value = '', placeholder = '',
    okLabel = 'OK', cancelLabel = 'Cancel', password = false,
} = {}) {
    return showDialog({
        message, title, kind,
        input: { value, placeholder, password },
        buttons: [
            { label: cancelLabel, value: null, cancel: true },
            { label: okLabel, value: undefined, primary: true },
        ],
    });
}
