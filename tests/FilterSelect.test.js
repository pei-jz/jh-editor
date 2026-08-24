import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFilterSelect } from '../src/modules/ui/FilterSelect.js';

// A native <select> cannot be filtered, so a repo with dozens of branches turns
// branch switching into a scroll hunt. This is the type-to-filter replacement.

const options = () => [...document.querySelectorAll('.filter-select-option')]
    .map((el) => el.textContent);
const groupLabels = () => [...document.querySelectorAll('.filter-select-group')]
    .map((el) => el.textContent);
const isOpen = () => document.querySelector('.filter-select-list').classList.contains('open');
const key = (input, k, over = {}) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over });
    input.dispatchEvent(e);
    return e;
};

describe('createFilterSelect', () => {
    let picker;
    let input;

    beforeEach(() => {
        document.body.innerHTML = '';
        picker = createFilterSelect({
            groups: [
                { label: 'Local', items: ['main', 'develop', 'feature/login'] },
                { label: 'Remote', items: ['origin/main', 'origin/develop'] },
            ],
            value: 'main',
        });
        document.body.appendChild(picker.element);
        input = picker.element.querySelector('.filter-select-input');
    });

    it('starts on the given value and reports it', () => {
        expect(input.value).toBe('main');
        expect(picker.getValue()).toBe('main');
    });

    it('opens on focus showing every option, grouped', () => {
        input.dispatchEvent(new FocusEvent('focus'));
        expect(isOpen()).toBe(true);
        expect(groupLabels()).toEqual(['Local', 'Remote']);
        expect(options()).toHaveLength(5);
    });

    it('narrows the list as you type, across groups', () => {
        input.dispatchEvent(new FocusEvent('focus'));
        input.value = 'develop';
        input.dispatchEvent(new Event('input'));
        expect(options()).toEqual(['develop', 'origin/develop']);
    });

    it('matches anywhere in the name, case-insensitively', () => {
        input.dispatchEvent(new FocusEvent('focus'));
        input.value = 'LOGIN';
        input.dispatchEvent(new Event('input'));
        expect(options()).toEqual(['feature/login']);
    });

    it('says so when nothing matches', () => {
        input.dispatchEvent(new FocusEvent('focus'));
        input.value = 'nope';
        input.dispatchEvent(new Event('input'));
        expect(options()).toEqual([]);
        expect(document.querySelector('.filter-select-empty')).toBeTruthy();
    });

    it('picks with the arrow keys and Enter, and fires onChange once', () => {
        const onChange = vi.fn();
        picker = createFilterSelect({ items: ['main', 'develop'], value: 'main', onChange });
        document.body.innerHTML = '';
        document.body.appendChild(picker.element);
        input = picker.element.querySelector('.filter-select-input');

        input.dispatchEvent(new FocusEvent('focus'));
        key(input, 'ArrowDown');
        key(input, 'Enter');

        expect(picker.getValue()).toBe('develop');
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith('develop');
    });

    it('does not fire onChange when the value did not change', () => {
        const onChange = vi.fn();
        picker = createFilterSelect({ items: ['main', 'develop'], value: 'main', onChange });
        document.body.innerHTML = '';
        document.body.appendChild(picker.element);
        input = picker.element.querySelector('.filter-select-input');

        input.dispatchEvent(new FocusEvent('focus'));
        key(input, 'Enter'); // 'main' is the active row
        expect(onChange).not.toHaveBeenCalled();
    });

    it('picks on mousedown, not click — blur would close the list first', () => {
        input.dispatchEvent(new FocusEvent('focus'));
        const row = [...document.querySelectorAll('.filter-select-option')]
            .find((el) => el.textContent === 'origin/main');
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        expect(picker.getValue()).toBe('origin/main');
        expect(isOpen()).toBe(false);
    });

    // Typing half a branch name and clicking away must not invent a value.
    it('reverts free text that was never picked', () => {
        input.dispatchEvent(new FocusEvent('focus'));
        input.value = 'dev';
        input.dispatchEvent(new Event('input'));
        key(input, 'Escape');
        expect(picker.getValue()).toBe('main');
        expect(input.value).toBe('main');
    });

    // The picker lives inside a themed dialog: Escape must close the list only,
    // or choosing a branch would dismiss the whole comparison dialog.
    it('keeps Escape from escaping to the dialog while the list is open', () => {
        input.dispatchEvent(new FocusEvent('focus'));
        const e = key(input, 'Escape');
        expect(e.defaultPrevented).toBe(true);
        expect(isOpen()).toBe(false);

        // Closed again, Escape belongs to whatever is around it.
        const e2 = key(input, 'Escape');
        expect(e2.defaultPrevented).toBe(false);
    });

    // Dialog.js listens on document in the capture phase. The picker marks
    // itself while its list is open so the dialog leaves Enter/Escape alone —
    // otherwise picking a branch fired the dialog's primary button instead.
    describe('key ownership inside a dialog', () => {
        it('claims the keys only while the list is open', () => {
            expect(picker.element.dataset.dialogKeys).toBeUndefined();

            input.dispatchEvent(new FocusEvent('focus'));
            expect(picker.element.dataset.dialogKeys).toBe('own');

            key(input, 'Escape');
            expect(picker.element.dataset.dialogKeys).toBeUndefined();
        });

        it('releases them once an option is picked', () => {
            input.dispatchEvent(new FocusEvent('focus'));
            key(input, 'ArrowDown');
            key(input, 'Enter');
            expect(picker.element.dataset.dialogKeys).toBeUndefined();
        });

        it('reclaims them when typing reopens the list', () => {
            input.dispatchEvent(new FocusEvent('focus'));
            key(input, 'Escape');
            input.value = 'dev';
            input.dispatchEvent(new Event('input'));
            expect(picker.element.dataset.dialogKeys).toBe('own');
        });
    });

    it('replaces its options and keeps a still-valid selection', () => {
        picker.setOptions([{ label: '', items: ['main', 'release'] }]);
        expect(picker.getValue()).toBe('main');
        picker.setOptions([{ label: '', items: ['release', 'hotfix'] }]);
        expect(picker.getValue()).toBe('release'); // 'main' is gone
    });
});
