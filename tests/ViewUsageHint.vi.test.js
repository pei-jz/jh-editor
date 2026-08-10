import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addViewUsageHint } from '../src/modules/core/Editor.js';

describe('addViewUsageHint — vi mode hint panel', () => {
    let container;

    beforeEach(() => {
        localStorage.clear();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
        localStorage.clear();
    });

    const mdFile = { path: '/tmp/notes.md', name: 'notes.md', content: '# hi' };

    it('shows vi command hints for Markdown when settings_vimMode is on', () => {
        localStorage.setItem('settings_vimMode', 'true');
        addViewUsageHint(container, mdFile);
        const panel = container.querySelector('.view-usage-hint');
        expect(panel).toBeTruthy();
        const title = panel.querySelector('.view-usage-title');
        expect(title.textContent).toContain('Vim');
        const text = panel.textContent;
        expect(text).toContain('j / k');
        expect(text).toContain('Enter');
        expect(text).toContain('insert mode');
        expect(text).toContain('link hints');
    });

    it('shows the ordinary Markdown hint when vi mode is off', () => {
        localStorage.setItem('settings_vimMode', 'false');
        addViewUsageHint(container, mdFile);
        const panel = container.querySelector('.view-usage-hint');
        const text = panel.textContent;
        expect(text).toContain('Markdown View');
        expect(text).toContain('move between blocks');
        expect(text).not.toContain('j / k');
    });

    it('uses a separate minimised-state key for the vi hint', () => {
        localStorage.setItem('settings_vimMode', 'true');
        localStorage.setItem('view-usage-hint-min-vi', '1');
        addViewUsageHint(container, mdFile);
        const panel = container.querySelector('.view-usage-hint');
        expect(panel.classList.contains('minimized')).toBe(true);
    });
});
