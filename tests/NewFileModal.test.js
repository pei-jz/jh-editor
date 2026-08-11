import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NewFileModal } from '../src/modules/ui/NewFileModal.js';
import { MarkdownTemplates, BUILTIN_TEMPLATES } from '../src/modules/utils/MarkdownTemplates.js';

const overlay = () => document.getElementById('new-file-overlay');

describe('NewFileModal', () => {
    beforeEach(() => {
        localStorage.clear();
        overlay()?.remove();
    });

    afterEach(() => {
        overlay()?.remove();
    });

    it('opens the overlay with the two type cards and hides the template picker for Text', () => {
        NewFileModal.show(() => {});
        expect(overlay()).toBeTruthy();
        const cards = overlay().querySelectorAll('.nf-card');
        expect(cards).toHaveLength(2);
        // Text is selected first → no template picker.
        expect(overlay().querySelector('.nf-tpl').classList.contains('visible')).toBe(false);
    });

    it('shows the template picker when the Markdown card is selected', () => {
        NewFileModal.show(() => {});
        overlay().querySelectorAll('.nf-card')[1].dispatchEvent(new MouseEvent('mouseenter'));
        expect(overlay().querySelector('.nf-tpl').classList.contains('visible')).toBe(true);
        // Built-in templates are listed.
        const items = overlay().querySelectorAll('.nf-tpl-item');
        expect(items.length).toBe(BUILTIN_TEMPLATES.length);
        // The register form sits above the list so a long list cannot push it away.
        const tpl = overlay().querySelector('.nf-tpl');
        const children = [...tpl.children].map(el => el.classList[0]);
        expect(children.indexOf('nf-reg')).toBeLessThan(children.indexOf('nf-tpl-list'));
    });

    it('calls onPick with the extension for Text (no template content)', () => {
        let picked = null;
        NewFileModal.show((ext, content) => { picked = { ext, content }; });
        overlay().querySelectorAll('.nf-card')[0].click();
        expect(picked.ext).toBe('txt');
        expect(picked.content).toBeUndefined();
        expect(overlay()).toBeNull(); // closed after picking
    });

    it('passes the selected template content for Markdown', () => {
        let picked = null;
        NewFileModal.show((ext, content) => { picked = { ext, content }; });
        const cards = overlay().querySelectorAll('.nf-card');
        cards[1].dispatchEvent(new MouseEvent('mouseenter'));
        // Hover the Meeting Notes row to select it.
        const items = overlay().querySelectorAll('.nf-tpl-item');
        const meetingIdx = [...items].findIndex(el => el.textContent.includes('Meeting Notes'));
        items[meetingIdx].dispatchEvent(new MouseEvent('mouseenter'));
        cards[1].click();
        expect(picked.ext).toBe('md');
        expect(picked.content).toContain('Meeting Notes');
    });

    it('walks the template list with ↑/↓ (Tab) and confirms with Enter', () => {
        let picked = null;
        NewFileModal.show((ext, content) => { picked = { ext, content }; });
        // Move to the Markdown card; the template list becomes visible.
        overlay().querySelectorAll('.nf-card')[1].dispatchEvent(new MouseEvent('mouseenter'));
        const items = overlay().querySelectorAll('.nf-tpl-item');
        // Blank is selected by default.
        expect(items[0].classList.contains('sel')).toBe(true);
        // ArrowDown moves through the template list, not the format cards.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        expect(items[1].classList.contains('sel')).toBe(true);
        // Tab does the same thing.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(items[2].classList.contains('sel')).toBe(true);
        // Shift+Tab walks back up.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(items[1].classList.contains('sel')).toBe(true);
        // Enter confirms the highlighted template.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(picked.ext).toBe('md');
        expect(picked.content).toContain('Meeting Notes');
    });

    it('registers a new template from the modal and preselects it', () => {
        NewFileModal.show(() => {});
        overlay().querySelectorAll('.nf-card')[1].dispatchEvent(new MouseEvent('mouseenter'));
        overlay().querySelector('.nf-tpl-new').click();
        expect(overlay().querySelector('.nf-reg').classList.contains('visible')).toBe(true);

        overlay().querySelector('.nf-reg-name').value = 'My Template';
        overlay().querySelector('.nf-reg-content').value = '# My\n\nbody';
        overlay().querySelector('.nf-reg-save').click();

        // Form closed, template persisted, and it is the selected row.
        expect(overlay().querySelector('.nf-reg').classList.contains('visible')).toBe(false);
        const user = MarkdownTemplates.getUserTemplates();
        expect(user).toHaveLength(1);
        expect(user[0].name).toBe('My Template');
        const sel = overlay().querySelector('.nf-tpl-item.sel');
        expect(sel.textContent).toContain('My Template');
    });

    it('deletes templates via the modal — Blank stays, other built-ins can go', () => {
        const saved = MarkdownTemplates.add('Temp', 'x');
        NewFileModal.show(() => {});
        overlay().querySelectorAll('.nf-card')[1].dispatchEvent(new MouseEvent('mouseenter'));
        const items = () => overlay().querySelectorAll('.nf-tpl-item');
        const delBtn = overlay().querySelector('.nf-tpl-del');

        // Blank selected by default → delete button hidden.
        expect(items()[0].textContent).toContain('Blank');
        expect(delBtn.style.display).toBe('none');

        // Select the user template → delete visible and functional.
        items()[items().length - 1].dispatchEvent(new MouseEvent('mouseenter'));
        expect(delBtn.style.display).not.toBe('none');
        delBtn.click();
        expect(MarkdownTemplates.getUserTemplates()).toHaveLength(0);

        // A non-blank built-in can also be deleted (hidden) from the modal.
        const meetingIdx = [...items()].findIndex(el => el.textContent.includes('Meeting Notes'));
        items()[meetingIdx].dispatchEvent(new MouseEvent('mouseenter'));
        delBtn.click();
        expect([...items()].some(el => el.textContent.includes('Meeting Notes'))).toBe(false);
        // … and Blank is still there.
        expect([...items()].some(el => el.textContent.includes('Blank'))).toBe(true);
    });

    it('keeps typing inside the register form from triggering modal key jumps', () => {
        NewFileModal.show(() => {});
        overlay().querySelectorAll('.nf-card')[1].dispatchEvent(new MouseEvent('mouseenter'));
        overlay().querySelector('.nf-tpl-new').click();
        const nameInput = overlay().querySelector('.nf-reg-name');
        // Pressing "m" inside the input must not jump-pick the Markdown card.
        const evt = new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true });
        nameInput.dispatchEvent(evt);
        expect(overlay()).toBeTruthy(); // still open
    });

    it('closes on Escape', () => {
        NewFileModal.show(() => {});
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(overlay()).toBeNull();
    });
});
