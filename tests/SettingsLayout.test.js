import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SettingsView, initSettingsSections } from '../src/modules/views/SettingsView.js';

// The settings are a tab: a few broad categories down the side, and the general
// settings in folding groups by what they are for.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('the settings screen', () => {
    let doc;

    beforeAll(() => {
        doc = new DOMParser().parseFromString(read('index.html'), 'text/html');
    });

    const sectionOf = (id) => doc.getElementById(id).closest('.settings-section').dataset.section;

    it('has a pane for every category, and the code knows about each', () => {
        const constants = read('src/modules/core/Constants.js');
        const tabs = [...doc.querySelectorAll('.settings-tab')].map((t) => t.dataset.tab);
        expect(tabs).toEqual(['general', 'agent', 'keybindings', 'templates', 'snippets', 'regex']);
        for (const tab of tabs) {
            expect(doc.getElementById(`settings-${tab}`), tab).not.toBeNull();
            expect(constants).toContain(`getElementById('settings-${tab}')`);
        }
    });

    it('opens on a single pane', () => {
        const shown = [...doc.querySelectorAll('.settings-pane')].filter((p) => p.style.display !== 'none');
        expect(shown.map((p) => p.id)).toEqual(['settings-general']);
    });

    it.each([
        ['theme-selector', 'appearance'],
        ['language-selector', 'appearance'],
        ['view-mode-selector', 'appearance'],
        ['font-family-selector', 'editor'],
        ['font-size-input', 'editor'],
        ['prose-font-selector', 'editor'],
        ['prose-size-input', 'editor'],
        ['explorer-open-selector', 'files'],
        ['large-file-threshold', 'files'],
        ['grep-max-matches', 'files'],
        ['terminal-scrollback-input', 'tools'],
        ['folder-jump-enabled', 'tools'],
        ['about-version', 'about'],
    ])('keeps %s in the %s section', (id, section) => {
        expect(sectionOf(id)).toBe(section);
    });

    it('keeps every section inside the general pane', () => {
        const sections = [...doc.querySelectorAll('.settings-section')];
        expect(sections.map((s) => s.dataset.section)).toEqual(['appearance', 'editor', 'files', 'tools', 'about']);
        for (const s of sections) expect(s.closest('.settings-pane').id).toBe('settings-general');
    });

    it('does not hide the translator behind a loop variable', () => {
        // `all.forEach(t => … t('Delete'))` called a template as a function, and
        // the templates tab stopped drawing at the first one it could delete.
        expect(read('src/modules/ui/SettingsModal.js')).not.toMatch(/forEach\(t =>/);
    });

    it('has no save button: settings take effect as they change', () => {
        expect(doc.getElementById('save-all-settings-btn')).toBeNull();
        // The one setting that relied on it.
        expect(read('src/modules/ui/SettingsModal.js')).toContain('agentUrlInput.onchange = saveAgentSettings');
    });

    it('is closed like any tab, with no button or Esc of its own', () => {
        expect(doc.getElementById('close-settings-btn')).toBeNull();
        expect(read('src/modules/ui/SettingsModal.js')).not.toContain("e.key === 'Escape' && modal");
    });

    it('is not brought back as a tab by the next session', () => {
        expect(read('src/modules/core/Session.js')).toContain('search|ai|settings');
    });
});

describe('the settings folding sections', () => {
    const page = () => {
        document.body.innerHTML = ['appearance', 'editor', 'files']
            .map((s) => `<details class="settings-section" data-section="${s}"></details>`).join('');
        return [...document.querySelectorAll('.settings-section')];
    };
    const flushToggle = (el) => el.dispatchEvent(new Event('toggle'));

    beforeEach(() => localStorage.clear());
    afterEach(() => { document.body.innerHTML = ''; });

    it('starts with the first one open', () => {
        const [appearance, editor] = page();
        initSettingsSections();
        expect(appearance.open).toBe(true);
        expect(editor.open).toBe(false);
    });

    it('opens as they were left', () => {
        const [appearance, editor] = page();
        initSettingsSections();
        appearance.open = false;
        editor.open = true;
        flushToggle(editor);

        const [a2, e2, f2] = page();
        initSettingsSections();
        expect([a2.open, e2.open, f2.open]).toEqual([false, true, false]);
    });

    it('survives something unreadable having been stored', () => {
        localStorage.setItem('settings_openSections', '{not json');
        const [appearance] = page();
        initSettingsSections();
        expect(appearance.open).toBe(true);
    });
});

describe('the settings tab', () => {
    let home;
    let content;
    let pane;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="settings-modal" style="display:none"><div class="settings-content"><input id="inside"></div></div>
            <div id="pane"></div>`;
        home = document.getElementById('settings-modal');
        pane = document.getElementById('pane');
        content = document.querySelector('.settings-content');
    });

    it('lends the elements to the pane and gives them back', () => {
        const input = document.getElementById('inside');
        input.value = 'kept';
        const view = new SettingsView(pane);
        expect(pane.contains(input)).toBe(true);
        view.destroy();
        expect(home.contains(input)).toBe(true);
        // In the document either way, for the code that finds them by id.
        expect(document.getElementById('inside').value).toBe('kept');
    });

    it('stays with the newer view when redrawn in place', () => {
        const first = new SettingsView(pane);
        const second = new SettingsView(pane);
        first.destroy();
        expect(pane.querySelector('#inside')).not.toBeNull();
        second.destroy();
        expect(home.querySelector('#inside')).not.toBeNull();
        expect(content).toBeTruthy();
    });
});
