import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showAlert, showConfirm, showPrompt, showDialog } from '../src/modules/ui/Dialog.js';

// These replaced alert()/confirm() and the Tauri dialog plugin. The native ones
// blocked and returned synchronously; every call site now awaits a Promise, so
// the resolution contract is what the app actually depends on.

const overlay = () => document.querySelector('.app-dialog-overlay');
const buttons = () => [...document.querySelectorAll('.app-dialog-btn')];
const byLabel = (label) => buttons().find((b) => b.textContent === label);
const press = (key, target = document.body) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
};
/** Let the resolve() microtask and the DOM removal settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Dialog', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.querySelectorAll('.app-dialog-overlay').forEach((o) => o.remove());
    });

    describe('showAlert', () => {
        it('shows the message and resolves when acknowledged', async () => {
            const p = showAlert('Save failed', { title: 'Save', kind: 'error' });
            expect(overlay()).toBeTruthy();
            expect(document.querySelector('.app-dialog-body').textContent).toBe('Save failed');
            expect(document.querySelector('.app-dialog-head').textContent).toContain('Save');
            expect(document.querySelector('.app-dialog-kind').className).toContain('error');

            byLabel('OK').click();
            await p;
            expect(overlay()).toBeNull();
        });

        it('is dismissible with Escape', async () => {
            const p = showAlert('Heads up');
            press('Escape');
            await p;
            expect(overlay()).toBeNull();
        });
    });

    describe('showConfirm', () => {
        it('resolves true on OK and false on Cancel', async () => {
            let p = showConfirm('Discard?');
            byLabel('OK').click();
            expect(await p).toBe(true);

            p = showConfirm('Discard?');
            byLabel('Cancel').click();
            expect(await p).toBe(false);
        });

        it('honours custom button labels', async () => {
            const p = showConfirm('Discard?', { okLabel: 'Discard', cancelLabel: 'Keep Editing' });
            expect(byLabel('Discard')).toBeTruthy();
            expect(byLabel('Keep Editing')).toBeTruthy();
            byLabel('Discard').click();
            expect(await p).toBe(true);
        });

        // The old native confirm() was cancel-by-default on Escape; a dialog
        // that resolved `true` there would silently discard the user's work.
        it('treats Escape as cancel, not as OK', async () => {
            const p = showConfirm('Discard?');
            press('Escape');
            expect(await p).toBe(false);
        });

        it('treats Enter as the primary action', async () => {
            const p = showConfirm('Discard?');
            press('Enter');
            expect(await p).toBe(true);
        });
    });

    describe('showPrompt', () => {
        it('resolves the entered text', async () => {
            const p = showPrompt('New name', { value: 'old.md' });
            const input = document.querySelector('.app-dialog-input');
            expect(input.value).toBe('old.md');
            input.value = 'new.md';
            byLabel('OK').click();
            expect(await p).toBe('new.md');
        });

        it('resolves null when cancelled, whatever was typed', async () => {
            const p = showPrompt('New name');
            document.querySelector('.app-dialog-input').value = 'ignored';
            byLabel('Cancel').click();
            expect(await p).toBeNull();
        });
    });

    describe('keyboard containment', () => {
        // Anything listening BELOW window — the views' own document/container
        // handlers — must not see the dialog's keys. (ShortcutManager sits on
        // window in the capture phase and therefore cannot be stopped from
        // here; it bails on its own while a dialog is open. See
        // ShortcutManager.dispatch.test.js.)
        it('consumes Escape and Enter instead of letting them bubble on', async () => {
            const belowWindow = vi.fn();
            document.addEventListener('keydown', belowWindow);
            try {
                const p = showConfirm('Discard?');
                const e = press('Escape');
                expect(e.defaultPrevented).toBe(true);
                expect(await p).toBe(false);
                expect(belowWindow).not.toHaveBeenCalled();
            } finally {
                document.removeEventListener('keydown', belowWindow);
            }
        });

        // Tab used to fall through to the editor behind the overlay: the caret
        // moved down there and the dialog buttons could not be reached at all.
        it('cycles Tab through its own controls instead of the page behind', async () => {
            const behind = document.createElement('input');
            document.body.appendChild(behind);

            const p = showConfirm('Discard?');
            const [cancel, ok] = buttons();
            expect(document.activeElement).toBe(ok); // primary starts focused

            const e = press('Tab', ok);
            expect(e.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(cancel);

            press('Tab', cancel);
            expect(document.activeElement).toBe(ok); // wraps around

            expect(document.activeElement).not.toBe(behind);
            behind.remove();
            byLabel('Cancel').click();
            await p;
        });

        it('walks backwards on Shift+Tab', async () => {
            const p = showConfirm('Discard?');
            const [cancel, ok] = buttons();
            const shiftTab = () => {
                const e = new KeyboardEvent('keydown', {
                    key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
                });
                document.activeElement.dispatchEvent(e);
            };
            expect(document.activeElement).toBe(ok);
            shiftTab();
            expect(document.activeElement).toBe(cancel);
            shiftTab();
            expect(document.activeElement).toBe(ok);
            byLabel('Cancel').click();
            await p;
        });

        it('includes the text field in the cycle', async () => {
            const p = showPrompt('New name');
            const input = document.querySelector('.app-dialog-input');
            expect(document.activeElement).toBe(input);
            press('Tab', input);
            expect(buttons()).toContain(document.activeElement);
            byLabel('Cancel').click();
            await p;
        });

        // Once Tab can move the focus, Enter must act on what is focused —
        // otherwise tabbing to Cancel and pressing Enter would confirm.
        it('fires the FOCUSED button on Enter, not always the primary', async () => {
            const p = showConfirm('Discard?');
            const [cancel] = buttons();
            cancel.focus();
            press('Enter', cancel);
            expect(await p).toBe(false);
        });

        it('does not swallow typing inside its own input', async () => {
            const p = showPrompt('Name');
            const input = document.querySelector('.app-dialog-input');
            const e = press('a', input);
            expect(e.cancelBubble).toBeFalsy();
            byLabel('Cancel').click();
            await p;
        });
    });

    it('hands focus back to whatever had it', async () => {
        const field = document.createElement('input');
        document.body.appendChild(field);
        field.focus();
        expect(document.activeElement).toBe(field);

        const p = showConfirm('Discard?');
        expect(document.activeElement).not.toBe(field);
        byLabel('Cancel').click();
        await p;
        await settle();
        expect(document.activeElement).toBe(field);
    });

    it('closes on a backdrop click but not on a click inside the box', async () => {
        const p = showConfirm('Discard?');
        document.querySelector('.app-dialog')
            .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(overlay()).toBeTruthy();

        overlay().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(await p).toBe(false);
    });

    // The whole point of the exercise: no hardcoded greys, so the box follows
    // whatever theme (Bamboo, Paper, Solarized…) the app is wearing.
    it('draws itself from the theme variables', () => {
        showAlert('x');
        const css = document.getElementById('app-dialog-styles').textContent;
        for (const v of ['--bg-color', '--text-color', '--border-color',
            '--primary-color', '--hover-color', '--font-main']) {
            expect(css).toContain(`var(${v}`);
        }
        byLabel('OK').click();
    });

    // The Git branch comparison puts two <select>s in a dialog and reads them
    // back when the primary button resolves.
    describe('content slot', () => {
        const form = () => {
            const el = document.createElement('div');
            const sel = document.createElement('select');
            sel.id = 'pick';
            sel.innerHTML = '<option value="main">main</option><option value="dev">dev</option>';
            el.appendChild(sel);
            return el;
        };

        it('renders the caller markup and focuses its first control', async () => {
            const content = form();
            const p = showDialog({
                title: 'Compare', message: 'Pick a ref', content,
                buttons: [
                    { label: 'Cancel', value: false, cancel: true },
                    { label: 'Compare', value: true, primary: true },
                ],
            });
            const sel = document.querySelector('#pick');
            expect(sel).toBeTruthy();
            expect(document.activeElement).toBe(sel);

            sel.value = 'dev';
            byLabel('Compare').click();
            expect(await p).toBe(true);
            // The caller keeps its own node, so the choice survives the close.
            expect(sel.value).toBe('dev');
        });

        // Dialog's key handler is on document in the CAPTURE phase, so it runs
        // BEFORE any control inside the body. Choosing a branch with Enter in
        // the comparison dialog therefore fired "Compare" and closed it before
        // the combobox ever saw the key.
        it('lets a control that claims the keys handle Enter itself', async () => {
            const content = form();
            const owner = document.createElement('div');
            owner.dataset.dialogKeys = 'own';
            const inner = document.createElement('input');
            owner.appendChild(inner);
            content.appendChild(owner);

            const p = showDialog({
                title: 'Compare', message: '', content,
                buttons: [
                    { label: 'Cancel', value: false, cancel: true },
                    { label: 'Compare', value: true, primary: true },
                ],
            });
            const e = press('Enter', inner);
            expect(e.defaultPrevented).toBe(false);
            expect(overlay()).toBeTruthy(); // still open

            const esc = press('Escape', inner);
            expect(esc.defaultPrevented).toBe(false);
            expect(overlay()).toBeTruthy();

            // Once the control releases them, the dialog gets its keys back.
            delete owner.dataset.dialogKeys;
            press('Enter', inner);
            expect(await p).toBe(true);
        });

        // A plain px value here: jsdom's CSS parser drops min()/clamp(), which
        // the app itself uses.
        it('gives the box the requested width', () => {
            const p = showDialog({
                title: 'Compare', message: '', content: form(), width: '620px',
                buttons: [{ label: 'OK', value: true, primary: true, cancel: true }],
            });
            expect(document.querySelector('.app-dialog').style.width).toBe('620px');
            byLabel('OK').click();
            return p;
        });

        // The body scrolls by default, which clipped the combobox popup in half.
        it('stops clipping the body when it holds caller markup', () => {
            const p = showDialog({
                title: 'Compare', message: '', content: form(),
                buttons: [{ label: 'OK', value: true, primary: true, cancel: true }],
            });
            expect(document.querySelector('.app-dialog-body').classList.contains('has-content')).toBe(true);
            const css = document.getElementById('app-dialog-styles').textContent;
            expect(css).toContain('.app-dialog-body.has-content { max-height: none; overflow: visible; }');
            byLabel('OK').click();
            return p;
        });

        it('still cycles Tab through the content controls', async () => {
            const p = showDialog({
                title: 'Compare', message: '', content: form(),
                buttons: [{ label: 'OK', value: true, primary: true, cancel: true }],
            });
            const sel = document.querySelector('#pick');
            expect(document.activeElement).toBe(sel);
            press('Tab', sel);
            expect(document.activeElement).toBe(byLabel('OK'));
            byLabel('OK').click();
            await p;
        });
    });

    it('supports an arbitrary button set through showDialog', async () => {
        const p = showDialog({
            message: 'Save before closing?',
            title: 'Unsaved',
            buttons: [
                { label: 'Save', value: 'save', primary: true },
                { label: 'Discard', value: 'discard' },
                { label: 'Cancel', value: null, cancel: true },
            ],
        });
        expect(buttons().map((b) => b.textContent)).toEqual(['Save', 'Discard', 'Cancel']);
        byLabel('Discard').click();
        expect(await p).toBe('discard');
    });
});
