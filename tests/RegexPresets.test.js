import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    RegexPresets, BUILTIN_PRESETS, DEFAULT_CATEGORY, normalizeCategory,
} from '../src/modules/ui/RegexPresets.js';
import { matches, visibleGroups } from '../src/modules/ui/RegexPicker.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('the shipped library', () => {
    beforeEach(() => { localStorage.clear(); });

    // A sample that does not compile fails later, in the search box, where the
    // cause is no longer visible.
    it('is all valid regular expressions', () => {
        for (const p of BUILTIN_PRESETS) {
            expect(() => new RegExp(p.pattern), `${p.id} ${p.pattern}`).not.toThrow();
        }
    });

    it('has unique ids and a category on every entry', () => {
        const ids = BUILTIN_PRESETS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const p of BUILTIN_PRESETS) {
            expect(p.category, p.id).toBeTruthy();
            expect(p.label, p.id).toBeTruthy();
        }
    });

    // Alphabetical would scramble a running order that goes from everyday to
    // obscure; invented categories have no such order to preserve.
    it('keeps the authored category order and appends new ones alphabetically', () => {
        expect(RegexPresets.categories()[0]).toBe('Common');
        RegexPresets.add('Zed', 'z', 'Zebra');
        RegexPresets.add('Alp', 'a', 'Alpha');
        const cats = RegexPresets.categories();
        expect(cats[0]).toBe('Common');
        expect(cats.slice(-2)).toEqual(['Alpha', 'Zebra']);
    });
});

describe('adding a sample', () => {
    beforeEach(() => { localStorage.clear(); });

    it('files it, and defaults the category', () => {
        const p = RegexPresets.add('Order number', 'ORD-\\d{6}');
        expect(p.category).toBe(DEFAULT_CATEGORY);
        expect(normalizeCategory('  ')).toBe(DEFAULT_CATEGORY);
        expect(RegexPresets.getAll().some((x) => x.id === p.id)).toBe(true);
    });

    it('refuses a pattern that cannot compile', () => {
        expect(() => RegexPresets.add('Bad', '([')).toThrow(/valid regular expression/i);
        expect(() => RegexPresets.add('', 'x')).toThrow(/name/i);
        expect(() => RegexPresets.add('Empty', '   ')).toThrow(/empty/i);
    });

    it('groups for display and drops empty categories', () => {
        RegexPresets.add('A', 'a', 'Mine');
        const groups = RegexPresets.grouped();
        expect(groups.every((g) => g.items.length > 0)).toBe(true);
        expect(groups.map((g) => g.category)).toContain('Mine');
    });
});

/* Removing a built-in must not require re-typing it from memory to get it back,
   so it is hidden rather than destroyed. */
describe('removing and restoring', () => {
    beforeEach(() => { localStorage.clear(); });

    it('hides a built-in instead of destroying it', () => {
        expect(RegexPresets.remove('b:uuid')).toBe(true);
        expect(RegexPresets.getAll().some((p) => p.id === 'b:uuid')).toBe(false);
        expect(RegexPresets.hiddenBuiltins().map((p) => p.id)).toContain('b:uuid');

        expect(RegexPresets.restore('b:uuid')).toBe(true);
        expect(RegexPresets.getAll().some((p) => p.id === 'b:uuid')).toBe(true);
        expect(RegexPresets.hiddenBuiltins()).toHaveLength(0);
    });

    it('deletes a user sample outright', () => {
        const p = RegexPresets.add('Mine', 'x');
        expect(RegexPresets.remove(p.id)).toBe(true);
        expect(RegexPresets.getAll().some((x) => x.id === p.id)).toBe(false);
        expect(RegexPresets.hiddenBuiltins()).toHaveLength(0);
        expect(RegexPresets.remove(p.id)).toBe(false);
    });

    it('reports honestly when there is nothing to do', () => {
        expect(RegexPresets.remove('b:nope')).toBe(false);
        expect(RegexPresets.restore('b:uuid')).toBe(false);
    });

    // The shipped array is module state shared by every caller; re-filing a
    // built-in must not reach into it.
    it('re-files a built-in without mutating the shipped array', () => {
        const before = BUILTIN_PRESETS.find((p) => p.id === 'b:uuid').category;
        RegexPresets.setCategory('b:uuid', 'Mine');
        expect(BUILTIN_PRESETS.find((p) => p.id === 'b:uuid').category).toBe(before);

        const moved = RegexPresets.getAll().filter((p) => p.label === 'UUID');
        expect(moved).toHaveLength(1);
        expect(moved[0].category).toBe('Mine');
    });
});

/* Thirty-eight rows in one column ran past the bottom of the window, and the
   category headings scrolled away before the rows under them arrived. */
describe('the picker', () => {
    const grouped = () => [
        { category: 'Common', items: [
            { label: 'Email address', pattern: '[\\w.+-]+@', category: 'Common' },
            { label: 'URL', pattern: 'https?://', category: 'Common' },
        ] },
        { category: 'Numbers', items: [
            { label: 'UUID', pattern: '[0-9a-f]{8}', category: 'Numbers' },
        ] },
    ];

    it('matches on the name, the pattern and the category', () => {
        const p = { label: 'Email address', pattern: 'https?://', category: 'Common' };
        expect(matches(p, 'email')).toBe(true);
        expect(matches(p, 'HTTPS')).toBe(true);
        expect(matches(p, 'common')).toBe(true);
        expect(matches(p, 'zzz')).toBe(false);
        expect(matches(p, '')).toBe(true);
    });

    it('honours the folded state when nothing is typed', () => {
        const { groups, total } = visibleGroups(grouped(), '', new Set(['Numbers']));
        expect(total).toBe(3);
        expect(groups.find((g) => g.category === 'Common').open).toBe(true);
        expect(groups.find((g) => g.category === 'Numbers').open).toBe(false);
    });

    // A hit hidden inside a folded section reads as no hit at all.
    it('forces every section open while filtering', () => {
        const { groups, total } = visibleGroups(grouped(), 'uuid', new Set(['Numbers']));
        expect(total).toBe(1);
        expect(groups).toHaveLength(1);
        expect(groups[0].open).toBe(true);
    });

    it('drops categories with no hit rather than showing empty headings', () => {
        const { groups } = visibleGroups(grouped(), 'email', new Set());
        expect(groups.map((g) => g.category)).toEqual(['Common']);
    });

    it('says nothing matched instead of showing a blank panel', () => {
        expect(visibleGroups(grouped(), 'zzz', new Set()).total).toBe(0);
        expect(read('src/modules/ui/RegexPicker.js')).toContain('No sample matches that.');
    });
});

/* Two things were wrong on screen: the first sections were squeezed to a sliver
   and the open ones lost half their rows, and nothing answered the arrow keys. */
describe('the panel itself', () => {
    const css = read('src/styles/features.css');
    const src = read('src/modules/ui/RegexPicker.js');

    // Flex children shrink by default, so in a column taller than the panel the
    // groups were compressed instead of the list scrolling.
    it('lets the list scroll instead of crushing the groups', () => {
        const group = css.slice(css.indexOf('.regex-group {'));
        expect(group.slice(0, group.indexOf('}'))).toContain('flex: none');

        const list = css.slice(css.indexOf('.regex-picker-list {'));
        expect(list.slice(0, list.indexOf('}'))).toContain('min-height: 0');
    });

    // Everything open is thirty-eight rows: a panel the height of the screen
    // that has to be scrolled before you can even see the category names.
    it('opens with one section expanded, not all of them', () => {
        const i = src.indexOf('function readCollapsed()');
        const fn = src.slice(i, src.indexOf('\n}', i));
        expect(fn).toContain('RegexPresets.categories().slice(1)');
        // Written down on first use, so changing the default later cannot
        // re-fold sections somebody has opened.
        expect(fn).toContain('writeCollapsed(');
    });

    // The keyboard is driven for real in RegexPicker.dom.test.js — reading the
    // source for `case 'ArrowDown':` passed while Down did nothing at all.
    // What is left here is the part vitest cannot execute: the stylesheet.
    it('shows where the keyboard is', () => {
        expect(css).toContain('.regex-group-head:focus-visible');
        expect(css).toContain('.regex-item:focus-visible');
    });
});

describe('the wiring', () => {
    it('replaced the context menu with the panel', () => {
        const search = read('src/modules/ui/Search.js');
        expect(search).toContain("import { showRegexPicker } from './RegexPicker.js';");
        expect(search).toContain('showRegexPicker(anchorEvent, _applyPreset)');
        // The library moved out of Search.js entirely.
        expect(search).not.toContain('_regexPresets');
        expect(search).not.toContain("group: 'Common'");
    });

    it('has a Settings tab that can add and remove', () => {
        const html = read('index.html');
        expect(html).toContain('data-tab="regex"');
        expect(html).toContain('id="settings-regex"');
        expect(read('src/modules/core/Constants.js')).toContain("getElementById('settings-regex')");

        const settings = read('src/modules/ui/SettingsModal.js');
        expect(settings).toContain('const renderRegexSettings = () => {');
        expect(settings).toContain("if (target === 'regex') renderRegexSettings();");
        expect(settings).toContain('RegexPresets.add(');
        expect(settings).toContain('RegexPresets.remove(');
        expect(settings).toContain('RegexPresets.restore(');
    });

    // Telling the user the pattern is broken in the search box, where the sample
    // looks fine and the search simply finds nothing, is too late.
    it('validates the pattern as it is typed', () => {
        const settings = read('src/modules/ui/SettingsModal.js');
        const i = settings.indexOf('const check = () => {');
        const fn = settings.slice(i, settings.indexOf('\n        };', i));
        expect(fn).toContain('new RegExp(src)');
        expect(fn).toContain('valid');
    });
});

/* Down did nothing while any section above the caret was folded, and Tab left
   the panel entirely and started toggling the explorer behind it. */
describe('keyboard, once sections are folded', () => {
    const src = read('src/modules/ui/RegexPicker.js');

    // display:none left the rows in the document, so the arrow keys stepped
    // onto buttons that cannot take focus and focus went nowhere.
    it('builds no rows at all for a folded group', () => {
        expect(src).toContain('for (const preset of (open ? items : []))');
        const i = src.indexOf("body.className = 'regex-group-body'");
        const near = src.slice(i, i + 400);
        expect(near).not.toContain("style.display = 'none'");
    });

    it('keeps Tab inside the panel', () => {
        expect(src).toContain("if (e.key === 'Tab') {");
        const i = src.indexOf("if (e.key === 'Tab') {");
        const branch = src.slice(i, src.indexOf('return;', i));
        expect(branch).toContain('e.preventDefault()');
        expect(branch).toContain('e.shiftKey ? -1 : 1');
        // The filter box is a focus stop too, so Tab cycles rather than
        // trapping the keyboard in the list.
        expect(src).toContain('const focusables = () => [filter, ...rows()];');
    });
});

/* F12 is Go to Definition in the editor, and a matched shortcut calls
   preventDefault() — which also swallows WebView2's own DevTools hotkey. */
describe('getting to DevTools', () => {
    it('has a command of its own rather than relying on the runtime', () => {
        expect(read('src-tauri/src/commands/app.rs')).toContain('pub fn open_devtools(');
        expect(read('src-tauri/src/lib.rs')).toContain('commands::app::open_devtools');
    });

    it('is bound globally, so it works in any scope', () => {
        const defs = read('src/modules/core/ShortcutDefinitions.js');
        const i = defs.indexOf('GLOBAL: [');
        const global = defs.slice(i, defs.indexOf('\n    ],', i));
        expect(global).toContain("cmd: 'app:devtools'");
        expect(global).toContain("key: 'i', ctrl: true, shift: true");
        expect(read('src/modules/core/App.js')).toContain("invoke('open_devtools')");
    });

    // A release build has no DevTools compiled in; say so instead of silently
    // doing nothing.
    it('explains itself when the build has none', () => {
        const rs = read('src-tauri/src/commands/app.rs');
        const i = rs.indexOf('pub fn open_devtools(');
        const fn = rs.slice(i, rs.indexOf('\n}', rs.indexOf('not(debug_assertions)', i)));
        expect(fn).toContain('cfg(debug_assertions)');
        expect(fn).toContain('development build');
    });
});
