import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

// A vertical split left the window in a state that looked broken: a stray
// "select a file" message stacked above the real editor, an empty tab strip,
// and the whole layout pushed sideways into horizontal overflow. Three separate
// causes, all of them in code added with the vertical split.

describe('split layout', () => {
    const editor = read('src/modules/core/Editor.js');

    const orientation = () => {
        const i = editor.indexOf('function applySplitOrientation(');
        expect(i).toBeGreaterThan(-1);
        return editor.slice(i, editor.indexOf('\nfunction ', i + 10));
    };

    // A flex item defaults to min-width/min-height:auto and refuses to shrink
    // below its content, so a wide line blew the pane out and the window
    // overflowed. Releasing one floor because the split turned was the bug.
    it('keeps both size floors on both panes, whichever way they stack', () => {
        const fn = orientation();
        expect(fn).toContain("pane.style.minWidth = '0';");
        expect(fn).toContain("pane.style.minHeight = '0';");
        // The conditional form is what caused the overflow.
        expect(fn).not.toMatch(/minWidth = vertical \?/);
        expect(fn).not.toMatch(/minHeight = vertical \?/);
    });

    // The session stores the DIRECTION; treating it as a boolean silently
    // reopened a vertical split as a horizontal one.
    it('restores a session split in the direction it was saved', () => {
        const i = editor.indexOf('splitEditor({');
        const restore = editor.slice(editor.indexOf('export async function restoreSession'));
        expect(restore).toContain("session.splitMode === 'vertical' ? 'vertical' : 'horizontal'");
        expect(i).toBeGreaterThan(-1);
    });

    // An empty PRIMARY pane above a full secondary one is the state the user
    // got stuck in, and nothing folded it back.
    it('folds the split when either pane runs out of tabs', () => {
        const i = editor.indexOf('if (openFiles.length === 0 && State.splitMode)');
        expect(i, 'the fold is not restricted to the right pane').toBeGreaterThan(-1);
        expect(editor).not.toContain('if (!isLeft && openFiles.length === 0 && State.splitMode)');
    });
});

describe('backslash key matching', () => {
    const sm = read('src/modules/core/ShortcutManager.js');

    // Matching on e.code alone fired the split on ANY key at those physical
    // positions — which on a JIS layout is how the editor ended up split
    // without anyone asking, and the session then restored it every launch.
    it('requires the code AND the character to agree', () => {
        expect(sm).toContain('BACKSLASH_CODES.includes(e.code) && BACKSLASH_CHARS.includes(eventKey)');
        expect(sm).not.toMatch(/\|\|\s*\(e\.code === 'Backslash' \|\| e\.code === 'IntlYen'/);
    });

    it('still accepts what a JIS keyboard actually reports', () => {
        const i = sm.indexOf('const BACKSLASH_CHARS');
        const line = sm.slice(i, sm.indexOf('\n', i));
        for (const ch of ['|', '¥', '_']) expect(line, ch).toContain(ch);
    });
});

// One window used to host exactly one terminal: sessions were keyed by the
// window label alone. They are keyed by "label::id" now, and each session's PTY
// events carry the same suffix so one shell's output cannot land in another's
// screen.
describe('multiple terminals', () => {
    const pty = read('src-tauri/src/commands/pty.rs');
    const tm = read('src/modules/ui/TerminalManager.js');

    it('keys backend sessions by window AND terminal', () => {
        expect(pty).toContain('fn session_key(label: &str, id: &Option<String>)');
        expect(pty).toContain('format!("{}::{}", label, id)');
        // Omitting the id still addresses the one terminal a single-terminal
        // frontend would have opened.
        expect(pty).toContain('unwrap_or("1")');
    });

    it('scopes the PTY events to one terminal', () => {
        expect(pty).toContain('format!("pty_output::{}", key)');
        expect(pty).toContain('format!("pty_closed::{}", key)');
        expect(tm).toContain('${PTY_OUTPUT_EVENT}::${id}');
    });

    // A window closing must take every terminal with it, not only the first.
    it('tears down all of a window\'s terminals when it closes', () => {
        const i = pty.indexOf('pub fn stop_pty_for_label');
        const fn = pty.slice(i, pty.indexOf('\n}', i));
        expect(fn).toContain('starts_with(&prefix)');
    });

    it('keeps the existing single-terminal API pointed at the active session', () => {
        for (const accessor of ['get term()', 'get fitAddon()', 'get ptyReady()',
            'set ptyReady(']) {
            expect(tm, accessor).toContain(accessor);
        }
    });

    /* The panel's X used to kill every terminal in it. Hiding a view and
       throwing away the shells running in it are different intentions, and only
       one of them is what an X means. */
    it('hides the panel without killing anything', () => {
        const i = tm.indexOf('bindEvents() {');
        const fn = tm.slice(i, tm.indexOf('// Resizer Logic', i));
        expect(fn).toContain("closeBtn?.addEventListener('click', () => this.hide())");
        expect(fn).not.toContain('this.closeSession(id)');

        // ...and an exiting shell leaves an empty panel rather than closing it.
        const j = tm.indexOf('async closeSession(');
        const close = tm.slice(j, tm.indexOf('\n    }', j));
        expect(close).toContain('this.sessions.size === 0');
        expect(close).not.toContain('this.hide()');
    });

    // Every terminal needs its own way out now that the panel's X is not one.
    it('gives every terminal a close button, the last one included', () => {
        const i = tm.indexOf('renderSessionList() {');
        const fn = tm.slice(i, tm.indexOf('\n    }', i));
        expect(fn).toContain('terminal-list-close');
        expect(fn).not.toContain('this.sessions.size > 1');
    });

    // A numbered chip in the header was a tiny target that said nothing about
    // which shell it switched to.
    it('lists terminals by their shell and title, not by index', () => {
        expect(tm).toContain('sessionLabel(session)');
        expect(tm).toContain('renderSessionList()');
        expect(tm).not.toContain('renderSessionStrip');
        // The label comes from the shell list and the shell's own OSC title.
        expect(tm).toContain('term.onTitleChange(');
        const i = tm.indexOf('sessionLabel(session) {');
        const fn = tm.slice(i, tm.indexOf('\n    }', i));
        expect(fn).toContain('x.id === session.shellId');
        expect(fn).not.toMatch(/session\.id/);
    });

    it('caps the number of terminals and disables the + at the cap', () => {
        expect(tm).toMatch(/const MAX_SESSIONS = 5;/);
        const i = tm.indexOf('async createSession(shellId');
        const guard = tm.slice(i, i + 220);
        expect(guard).toContain('this.sessions.size >= MAX_SESSIONS');
        expect(guard).toContain('return null;');
        const j = tm.indexOf('renderSessionList() {');
        const render = tm.slice(j, tm.indexOf('\n    }', j));
        expect(render).toContain('add.disabled = full;');
    });

    it('puts the list beside the terminal rather than in the header', () => {
        const html = read('index.html');
        expect(html).toContain('id="terminal-session-list"');
        expect(html).not.toContain('terminal-session-strip');
        // The terminal itself must still be free to shrink next to it.
        expect(html).toContain('id="terminal-body"');
        // The + and the shell picker are one control in use, so they sit
        // together — and an empty panel is simply empty.
        expect(html).toMatch(/id="new-terminal-btn"[^]*?id="terminal-shell-select"/);
        expect(html).not.toContain('terminal-empty');
        expect(html).toMatch(/id="terminal-container"[^>]*min-width: 0/);
        expect(read('src/styles/terminal.css')).toContain('.terminal-list {');
    });

    it('restarts every terminal on a workspace switch, not just the visible one', () => {
        const i = tm.indexOf('async restart()');
        const fn = tm.slice(i, tm.indexOf('\n    }', i));
        expect(fn).toContain('for (const session of this.sessions.values())');
    });
});

describe('terminal shell selection', () => {
    const pty = read('src-tauri/src/commands/pty.rs');
    const tm = read('src/modules/ui/TerminalManager.js');

    it('discovers shells in the backend rather than guessing', () => {
        expect(pty).toContain('pub async fn list_shells()');
        for (const id of ['git-bash', 'powershell', 'pwsh', 'cmd', 'wsl']) {
            expect(pty, id).toContain(`"${id}"`);
        }
        expect(read('src-tauri/src/lib.rs')).toContain('commands::pty::list_shells');
    });

    // An older frontend, or a first run with nothing saved, must still work.
    it('keeps the platform default when no shell is chosen', () => {
        expect(pty).toContain('shell: Option<String>');
        expect(pty).toContain('let chosen = match shell.as_deref()');
    });

    it('passes the saved shell when spawning', () => {
        expect(tm).toContain("invoke('spawn_pty', { shell: session.shellId, id })");
        expect(tm).toContain("localStorage.getItem('terminal_shell')");
    });

    /* A PTY is bound to its process, so the shell cannot be swapped underneath a
       running terminal. The picker used to restart EVERY terminal to apply a
       change, which turned "I want a cmd terminal too" into "all my terminals
       are now cmd". It picks the shell for the NEXT one instead. */
    it('leaves running terminals alone when the shell picker changes', () => {
        const i = tm.indexOf('setShell(id) {');
        const fn = tm.slice(i, tm.indexOf('\n    }', i));
        expect(fn).toContain("localStorage.setItem('terminal_shell'");
        expect(fn).not.toContain('restart()');
    });

    it('pins a terminal to the shell it was created with', () => {
        expect(tm).toContain('async createSession(shellId = this.shellId)');
        // Respawning after a workspace switch must reuse the session's own
        // shell, not whatever the picker happens to say now.
        const i = tm.indexOf('async spawnPty(');
        const fn = tm.slice(i, tm.indexOf('\n    }', i));
        expect(fn).toContain('shell: session.shellId');
        expect(fn).not.toContain('session.shellId = this.shellId');
    });

    // Choosing a shell only means something before the terminal exists, so the
    // panel opens empty rather than starting one you did not ask for.
    it('opens the panel without starting a shell', () => {
        const i = tm.indexOf('async init() {');
        const fn = tm.slice(i, tm.indexOf('\n    }', i));
        expect(fn).not.toContain('createSession');
        expect(fn).toContain('this.renderSessionList()');

        const j = tm.indexOf('async show() {');
        const show = tm.slice(j, tm.indexOf('\n    }', j));
        expect(show).not.toContain('createSession');
    });

    // The AI runner used to rely on the panel always having a live terminal.
    it('opens a terminal on demand for an AI command', () => {
        const i = tm.indexOf('async executeCommand(');
        const fn = tm.slice(i, i + 800);
        expect(fn).toContain('this.sessions.size === 0');
        expect(fn).toContain('await this.createSession()');
    });

    it('falls back when the saved shell is no longer installed', () => {
        expect(tm).toContain('shells.some((s) => s.id === saved) ? saved : shells[0].id');
    });
});
