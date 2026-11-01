import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Toast } from '../src/modules/ui/Toast.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

describe('window.showToast', () => {
    it('exists and reaches the toast', () => {
        const show = vi.spyOn(Toast, 'show').mockImplementation(() => {});
        window.showToast('Disk full', 'error');
        expect(show).toHaveBeenCalledWith('Disk full', 'error');
        show.mockRestore();
    });

    it('draws a message on screen', () => {
        window.showToast('Visible now');
        expect(document.getElementById('toast-container').textContent).toContain('Visible now');
    });

    it('is only ever handed translated text', () => {
        // Untranslated strings went unnoticed here for as long as nothing was
        // shown. A plain literal or template is English in every language.
        const raw = [];
        for (const file of walk(src)) {
            const text = readFileSync(file, 'utf8');
            for (const m of text.matchAll(/window\.showToast\(\s*['"`]([^'"`]*)/g)) {
                raw.push(`${relative(src, file)}: ${m[1]}`);
            }
        }
        expect(raw).toEqual([]);
    });
});
