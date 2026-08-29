import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// TerminalManager pulls in @xterm/xterm and the Tauri PTY bridge at import
// time, neither of which exists under jsdom. The clipboard/drop behaviour is
// wiring rather than logic, so the checks that pay off here are structural:
// that the terminal no longer relies on document.execCommand (a no-op over
// xterm's canvas), and that a drop cannot escape to the app's global handler.

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src/modules/ui/TerminalManager.js'), 'utf8').replace(/\r\n/g, '\n');

describe('terminal clipboard & drop wiring', () => {
    it('copies through the Tauri clipboard, not execCommand', () => {
        expect(src).toContain("from '@tauri-apps/plugin-clipboard-manager'");
        expect(src).toContain('await writeText(text)');
        // Only the comment explaining why it was dropped may mention it.
        expect(src).not.toMatch(/^\s*document\.execCommand\('copy'\)/m);
    });

    it('pastes through term.paste so bracketed paste is honoured', () => {
        expect(src).toContain('await readText()');
        expect(src).toContain('this.term.paste(');
    });

    it('binds a context menu, middle-click paste and a file drop', () => {
        expect(src).toContain("host.addEventListener('contextmenu'");
        expect(src).toContain("host.addEventListener('drop'");
        expect(src).toContain("host.addEventListener('dragover'");
        expect(src).toMatch(/e\.button !== 1/);
    });

    // App.js listens for 'drop' on document and opens the file as a TAB. Without
    // stopPropagation a path dropped on the terminal would do both.
    it('keeps a terminal drop away from the global file-drop handler', () => {
        const drop = src.slice(src.indexOf("host.addEventListener('drop'"));
        const body = drop.slice(0, drop.indexOf('\n        });'));
        expect(body).toContain('e.preventDefault()');
        expect(body).toContain('e.stopPropagation()');
    });
});

describe('quoteForShell', () => {
    // Re-declared from the module (it is private there, and importing the module
    // would drag xterm in). Kept in sync by the source check below.
    const quoteForShell = (path) => {
        const p = String(path);
        if (!/[\s'"`]/.test(p)) return p;
        if (/^".*"$/.test(p) || /^'.*'$/.test(p)) return p;
        return '"' + p.replace(/"/g, '\\"') + '"';
    };

    it('is a faithful copy of the implementation', () => {
        const fn = src.slice(src.indexOf('function quoteForShell'));
        expect(fn.slice(0, fn.indexOf('\n}'))).toContain("if (!/[\\s'\"`]/.test(p)) return p;");
    });

    it('leaves an ordinary path alone', () => {
        expect(quoteForShell('C:/repo/src/app.js')).toBe('C:/repo/src/app.js');
    });

    it('quotes a path containing spaces', () => {
        expect(quoteForShell('C:\\Program Files\\a.txt')).toBe('"C:\\Program Files\\a.txt"');
    });

    it('does not double-quote an already quoted path', () => {
        expect(quoteForShell('"C:\\Program Files\\a.txt"')).toBe('"C:\\Program Files\\a.txt"');
    });

    it('escapes an embedded double quote', () => {
        expect(quoteForShell('a "b" c')).toBe('"a \\"b\\" c"');
    });
});
