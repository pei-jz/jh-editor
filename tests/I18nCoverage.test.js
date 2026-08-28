import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ja from '../src/locales/ja.js';
import zh from '../src/locales/zh.js';
import ko from '../src/locales/ko.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const read = (...p) => readFileSync(join(repo, ...p), 'utf8');

/*
   The app claimed four languages while only its static chrome was translated:
   the title bar was Japanese and every dialog, toast and menu underneath it was
   English. Runtime strings go through t() now, which is only half the fix — the
   other half is noticing when a NEW string is added and the dictionaries are
   not. That is what this file is for.

   English needs no dictionary: keys ARE the English text, so an untranslated
   key renders as readable English rather than as a key or a blank. That makes a
   gap survivable, and makes it invisible without a test.
*/

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

/** Every key the app actually asks for. */
function keysInUse() {
    const keys = new Set();

    for (const file of walk(join(repo, 'src'))) {
        const rel = relative(repo, file).replace(/\\/g, '/');
        // The locale files hold translations; I18n.js documents t() with
        // examples that are not real keys.
        if (rel.startsWith('src/locales/') || rel.endsWith('utils/I18n.js')) continue;
        const src = readFileSync(file, 'utf8');
        // `tr(` is the translator under a different name in CodeMirrorView,
        // where `t` is already bound to Lezer's highlight tags.
        for (const m of src.matchAll(/\btr?\(\s*'((?:[^'\\]|\\.)+)'/g)) {
            keys.add(m[1].replace(/\\'/g, "'"));
        }
        for (const m of src.matchAll(/\btr?\(\s*"((?:[^"\\]|\\.)+)"/g)) {
            keys.add(m[1].replace(/\\"/g, '"'));
        }
    }

    // Static markup declares its own keys.
    const html = read('index.html');
    for (const m of html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) {
        keys.add(m[1]);
    }

    // Data tables stay plain data and are translated where they are drawn, so
    // their labels are keys even though no t() call sits next to them.
    for (const f of [
        'src/modules/utils/MermaidRecipes.js',
        'src/modules/ui/RegexPresets.js',
        'src/modules/core/CommandRegistry.js',
    ]) {
        const table = read(f);
        for (const m of table.matchAll(/label: '((?:[^'\\]|\\.)+)'/g)) {
            keys.add(m[1].replace(/\\'/g, "'"));
        }
        // A label containing an apostrophe is written with double quotes.
        for (const m of table.matchAll(/label: "((?:[^"\\]|\\.)+)"/g)) {
            keys.add(m[1].replace(/\\"/g, '"'));
        }
    }
    // CommandRegistry translates its category names too.
    for (const c of ['File', 'Edit', 'Search', 'Go', 'View', 'Compare', 'Git', 'AI', 'Help']) {
        keys.add(c);
    }

    keys.delete('');
    return keys;
}

const USED = keysInUse();
const DICTS = { ja, zh, ko };

describe('translation coverage', () => {
    it('finds the keys the app uses', () => {
        // A sanity floor: if the scan silently matched nothing, every
        // assertion below would pass for the wrong reason.
        expect(USED.size).toBeGreaterThan(300);
        expect(USED.has('Save')).toBe(true);
        expect(USED.has('Command Palette')).toBe(true);
    });

    for (const [lang, dict] of Object.entries(DICTS)) {
        it(`${lang} translates every key in use`, () => {
            const missing = [...USED].filter((k) => !(k in dict)).sort();
            expect(missing, `${lang} is missing ${missing.length} key(s)`).toEqual([]);
        });

        it(`${lang} has no blank translations`, () => {
            const blank = Object.entries(dict)
                .filter(([, v]) => typeof v !== 'string' || !v.trim())
                .map(([k]) => k);
            expect(blank).toEqual([]);
        });

        it(`${lang} keeps every {placeholder} the key declares`, () => {
            // A translation that drops {n} silently loses the number — the
            // sentence still reads, so nothing else would catch it.
            const broken = [];
            for (const [key, value] of Object.entries(dict)) {
                const want = (key.match(/\{[a-zA-Z_]+\}/g) || []).sort();
                const got = (String(value).match(/\{[a-zA-Z_]+\}/g) || []).sort();
                if (want.join(',') !== got.join(',')) broken.push(`${key} → ${value}`);
            }
            expect(broken).toEqual([]);
        });
    }

    it('the three dictionaries cover the same keys', () => {
        const jaKeys = Object.keys(ja).sort();
        expect(Object.keys(zh).sort()).toEqual(jaKeys);
        expect(Object.keys(ko).sort()).toEqual(jaKeys);
    });

    it('carries no entries nothing asks for', () => {
        // Not fatal in itself, but a dictionary that only grows becomes a
        // dictionary nobody trusts.
        const orphans = Object.keys(ja).filter((k) => !USED.has(k)).sort();
        expect(orphans, `unused keys: ${orphans.join(' | ')}`).toEqual([]);
    });
});

describe('the UI reaches the translator', () => {
    it('routes dialogs, toasts and menus through t()', () => {
        const app = read('src/modules/core/App.js');
        expect(app).toContain("t('Unsaved Changes')");
        expect(read('src/modules/core/Editor.js')).toContain("t('Close Others')");
        expect(read('src/modules/editors/CsvEditor.js')).toContain("t('Sort Ascending')");
        expect(read('src/modules/ui/GitPanel.js')).toContain('t(');
    });

    it('translates data-table labels where they are drawn, not in the table', () => {
        // Keeping the tables as plain data means a language change re-renders
        // rather than needing the table rebuilt.
        expect(read('src/modules/ui/MermaidHelper.js')).toContain('t(s.label)');
        expect(read('src/modules/ui/RegexPicker.js')).toContain('t(preset.label)');
        expect(read('src/modules/core/CommandRegistry.js')).toContain('translate(c.label)');
        expect(read('src/modules/utils/MermaidRecipes.js')).not.toContain("from '../utils/I18n.js'");
    });

    it('does not translate things that are not prose', () => {
        // A CSS keyframe and a font-metric probe both got swept up when the
        // call sites were converted in bulk.
        expect(read('src/modules/ai/JhAiActivityPanel.js')).not.toContain("t('@keyframes");
        expect(read('src/modules/views/LargeFileView.js')).not.toContain("t('Mg')");
        // An example filename is not a label.
        expect(read('src/modules/ui/Modal.js')).not.toContain("t('file_name')");
    });
});
