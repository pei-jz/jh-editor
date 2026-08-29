import { Terminal } from '@xterm/xterm';
import { t } from '../utils/I18n.js';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { EL } from '../core/Constants.js';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { ContextMenu } from './ContextMenu.js';
import { themeById, DEFAULT_THEME } from '../utils/Themes.js';

/**
 * ANSI の 16 色。
 *
 * xterm は色を渡さなければ既定値を使う。その既定値は暗い背景を前提にして
 * いるので、明るいテーマでは薄すぎて読めない。テーマは明暗どちらもあるの
 * だから、両方ぶん用意しないと片方が必ず読めなくなる。
 *
 * 値はどのテーマの背景に対しても 4.4:1 以上になるよう選んである。暗い側は
 * nord (#3b4252) が、明るい側は Paper (#e7dab9) が下限を決める。背景が最も
 * 中間に寄っているテーマが通れば、他はそれより楽になる。
 */
const ANSI_DARK = {
    red: '#ff8a80', green: '#5ae6a8', yellow: '#f2e14c', blue: '#8ec4ff',
    magenta: '#eda1ed', cyan: '#69dcf2', white: '#e8e8e8',
    brightRed: '#ffa8a0', brightGreen: '#8bf0c4', brightYellow: '#f7f07a',
    brightBlue: '#aed6ff', brightMagenta: '#f4bdf4', brightCyan: '#96e8fa',
    brightWhite: '#ffffff',
};

const ANSI_LIGHT = {
    red: '#b32222', green: '#006b4a', yellow: '#6b5a00', blue: '#0a4b96',
    magenta: '#8a1f9c', cyan: '#0a5f70', white: '#4a4a4a',
    brightRed: '#8f1a1a', brightGreen: '#005539', brightYellow: '#544700',
    brightBlue: '#073a75', brightMagenta: '#6b1879', brightCyan: '#084a58',
    brightWhite: '#1f1f1f',
};

/** `#rrggbb` を n:1-n で混ぜる。解決できない値が来たら null を返す。 */
function mixHex(a, b, ratio) {
    const parse = (h) => {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
        if (!m) return null;
        const v = parseInt(m[1], 16);
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    };
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return null;
    const c = x.map((n, i) => Math.round(n + (y[i] - n) * ratio));
    return '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
}


// This window's PTY events are named per-window so no other window's terminal
// receives them (Tauri v2 global `listen` sees events regardless of emit target).
const WIN_LABEL = (() => { try { return getCurrentWindow().label; } catch (_) { return 'main'; } })();
const PTY_OUTPUT_EVENT = `pty_output::${WIN_LABEL}`;
const PTY_CLOSED_EVENT = `pty_closed::${WIN_LABEL}`;

/**
 * Quote a dropped path so a shell sees it as one argument. Paths with spaces are
 * the whole point of doing this; anything already quoted is left alone.
 */
function quoteForShell(path) {
    const p = String(path);
    if (!/[\s'"`]/.test(p)) return p;
    if (/^".*"$/.test(p) || /^'.*'$/.test(p)) return p;
    return '"' + p.replace(/"/g, '\\"') + '"';
}

/**
 * Terminals are cheap but not free: each one is a shell process, a PTY and a
 * full xterm canvas. Five is enough to work with and keeps the list readable
 * without scrolling.
 */
const MAX_SESSIONS = 5;

class TerminalManager {
    constructor() {
        /**
         * Running terminals, newest last.
         * @type {Map<string, {id, term, fitAddon, host, unlisteners, ptyReady, shellId}>}
         */
        this.sessions = new Map();
        this.activeId = null;
        this._nextId = 1;

        this.isOpen = false;
        this.unlisteners = [];   // window-level, not per session
        this.resizing = false;
        this.isExecuting = false;
        this.startY = 0;
        this.startHeight = 0;
    }

    /* The class was written around one terminal. These keep every existing use
       of this.term / this.fitAddon / this.ptyReady pointed at the active
       session instead of at a single global one. */
    get session() { return this.sessions.get(this.activeId) || null; }
    get term() { return this.session ? this.session.term : null; }
    get fitAddon() { return this.session ? this.session.fitAddon : null; }
    get ptyReady() { return this.session ? this.session.ptyReady : false; }
    set ptyReady(v) { if (this.session) this.session.ptyReady = v; }

    async init() {
        if (!EL.terminal.container) return;
        this.bindEvents();
        // Bound to the shared container, so it covers every session: the
        // instances are children and their events bubble up here.
        this.bindClipboardAndDrop();
        await this.bindShellPicker();
        // No terminal is started here. The shell a terminal runs is fixed at
        // creation, so it has to be chosen before there is anything to run:
        // the panel opens empty and you add one with the shell you want.
        this.renderSessionList();
    }

    /**
     * Open another terminal and make it the active one.
     *
     * Each session owns its xterm, its container and its own PTY event
     * listeners — the backend suffixes the event names with the terminal id, so
     * one shell's output can never land in another's screen.
     */
    /**
     * @param {string} [shellId] Which shell to run. Defaults to the one picked
     *   in the header. It is fixed for the life of the terminal: a PTY is bound
     *   to its process, so swapping the program underneath it is not a thing a
     *   running terminal can do.
     */
    async createSession(shellId = this.shellId) {
        if (this.sessions.size >= MAX_SESSIONS) {
            this.renderSessionList();
            return null;
        }
        const id = String(this._nextId++);

        const host = document.createElement('div');
        host.className = 'terminal-instance';
        host.dataset.termId = id;
        host.style.cssText = 'position:absolute; inset:0; display:none;';
        EL.terminal.container.style.position = 'relative';
        EL.terminal.container.appendChild(host);

        const term = new Terminal({
            cursorBlink: true,
            theme: {
                background: '#000000',
                foreground: '#cccccc',
                selectionBackground: '#3a3d41',
            },
            fontFamily: '"Cascadia Code", Consolas, monospace',
            fontSize: 13,
            letterSpacing: 0,
            lineHeight: 1.1,
            rightClickSelectsWord: true,
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(host);

        const session = { id, term, fitAddon, host, unlisteners: [], ptyReady: false,
                          shellId, title: '' };
        this.sessions.set(id, session);

        // Shells announce their working directory (and often the running
        // command) through OSC 0/2. That is what tells one terminal from
        // another in the list, so no numbering is needed.
        term.onTitleChange((title) => {
            session.title = title || '';
            this.renderSessionList();
        });

        term.onData(async (data) => {
            if (session.ptyReady) {
                await invoke('write_to_pty', { data, id });
            } else if (data === '\r') {
                term.write('\r\n\x1b[32mRestarting terminal...\x1b[0m\r\n');
                await this.spawnPty(id);
            }
        });

        term.attachCustomKeyEventHandler((arg) => this.handleTerminalKey(arg, term));

        const out = await listen(`${PTY_OUTPUT_EVENT}::${id}`, (event) => {
            if (event.payload) term.write(event.payload);
        });
        const closed = await listen(`${PTY_CLOSED_EVENT}::${id}`, () => {
            session.ptyReady = false;
            if (this._restarting) return;
            // The shell exited (the user typed `exit`): drop that terminal. The
            // panel only closes when the last one is gone.
            this.closeSession(id);
        });
        session.unlisteners.push(out, closed);

        this.activateSession(id);
        this.applyTheme();
        this.renderSessionList();
        if (this.isOpen) await this.spawnPty(id);
        return id;
    }

    /** Show one terminal and hide the rest. */
    activateSession(id) {
        if (!this.sessions.has(id)) return;
        this.activeId = id;
        for (const s of this.sessions.values()) {
            s.host.style.display = s.id === id ? 'block' : 'none';
        }
        this.renderSessionList();
        setTimeout(() => {
            this.fitAddon?.fit();
            this.notifyResize();
            this.term?.focus();
        }, 0);
    }

    /** Kill one terminal. Closing the last one closes the panel. */
    async closeSession(id) {
        const session = this.sessions.get(id);
        if (!session) return;
        try { await invoke('stop_pty', { id }); } catch (e) { /* already gone */ }
        for (const un of session.unlisteners) { try { un(); } catch (e) { /* ignore */ } }
        try { session.term.dispose(); } catch (e) { /* ignore */ }
        session.host.remove();
        this.sessions.delete(id);

        // An empty panel stays open: the X hides the view, and a shell exiting
        // should not yank the view out from under you either.
        if (this.sessions.size === 0) {
            this.activeId = null;
            this.renderSessionList();
            return;
        }
        if (this.activeId === id) {
            this.activateSession([...this.sessions.keys()].pop());
        } else {
            this.renderSessionList();
        }
    }

    /** The shell's display name, e.g. "Git Bash" — never an index. */
    sessionLabel(session) {
        const shell = (this._shells || []).find((x) => x.id === session.shellId);
        return shell?.name || 'Terminal';
    }

    /**
     * What the shell reports as its title, trimmed to the tail that identifies
     * it — the last path segment is what actually differs between two
     * terminals in the same repository.
     */
    sessionDetail(session) {
        const title = (session.title || '').trim();
        if (!title) return session.ptyReady ? '' : 'exited';
        const parts = title.split(/[/\\]/).filter(Boolean);
        return parts.length > 1 ? parts.slice(-2).join('/') : title;
    }

    /**
     * The running terminals, listed down the right-hand side of the panel.
     *
     * They were a row of numbered chips in the header, which was both hard to
     * hit and meaningless — a number says nothing about which shell it is.
     */
    renderSessionList() {
        const list = EL.terminal.sessionList;
        if (!list) return;
        list.innerHTML = '';

        const full = this.sessions.size >= MAX_SESSIONS;
        // The + lives beside the shell picker in the header, because the picker
        // is what decides which shell it starts — separating them made the pair
        // read as two unrelated controls.
        const add = EL.terminal.newBtn;
        if (add) {
            add.disabled = full;
            if (full) {
                add.title = `Up to ${MAX_SESSIONS} terminals`;
            } else {
                const next = (this._shells || []).find((x) => x.id === this.shellId);
                add.title = next ? `New ${next.name} terminal` : 'New terminal';
            }
        }

        const head = document.createElement('div');
        head.className = 'terminal-list-head';
        const caption = document.createElement('span');
        caption.textContent = `TERMINALS ${this.sessions.size}/${MAX_SESSIONS}`;
        head.appendChild(caption);
        list.appendChild(head);

        for (const s of this.sessions.values()) {
            const item = document.createElement('div');
            item.className = 'terminal-list-item' + (s.id === this.activeId ? ' active' : '');
            item.onclick = () => this.activateSession(s.id);

            const text = document.createElement('div');
            text.className = 'terminal-list-text';

            const name = document.createElement('div');
            name.className = 'terminal-list-name';
            name.textContent = this.sessionLabel(s);
            text.appendChild(name);

            const detail = this.sessionDetail(s);
            if (detail) {
                const sub = document.createElement('div');
                sub.className = 'terminal-list-detail';
                sub.textContent = detail;
                text.appendChild(sub);
            }
            item.appendChild(text);
            item.title = s.title || this.sessionLabel(s);

            // Every terminal is closable, the last one included: the panel's
            // own X no longer kills anything, so this is the only way out.
            const x = document.createElement('button');
            x.className = 'terminal-list-close';
            x.textContent = 'X';
            x.title = t('Close this terminal');
            x.onclick = (e) => { e.stopPropagation(); this.closeSession(s.id); };
            item.appendChild(x);
            list.appendChild(item);
        }
    }

    /** Clipboard and selection keys, shared by every session's xterm. */
    handleTerminalKey(arg, term) {
        if (arg.type !== 'keydown') return true;
        const ctrl = arg.ctrlKey || arg.metaKey;
        if (!ctrl) return true;

        // Ctrl+Shift+C always copies; plain Ctrl+C copies only when there is a
        // selection and otherwise falls through as SIGINT, as every terminal does.
        if (arg.code === 'KeyC' && (arg.shiftKey || term.hasSelection())) {
            arg.preventDefault();
            this.copySelection();
            return false;
        }
        // preventDefault stops the webview's own paste from ALSO reaching
        // xterm's hidden textarea (which would double the text).
        if (arg.code === 'KeyV') {
            arg.preventDefault();
            this.pasteFromClipboard();
            return false;
        }
        if (arg.shiftKey && arg.code === 'KeyA') {
            arg.preventDefault();
            term.selectAll();
            return false;
        }
        return true;
    }

    applyTheme() {
        if (!this.term) return;
        // Computed once below, then handed to every session.

        // Extract colors from CSS variables - use document.body where theme classes are applied
        const style = getComputedStyle(document.body);
        
        // どのテーマかはレジストリに聞く。ここでクラス名を並べていると、
        // テーマを足すたびにこの関数へ if が増え、足し忘れたテーマだけ
        // 配色が崩れる。
        let themeId = DEFAULT_THEME;
        try {
            themeId = localStorage.getItem('theme') || DEFAULT_THEME;
        } catch (_) { /* localStorage が無くても既定で動く */ }
        const entry = themeById(themeId);
        const isDark = entry ? entry.dark : true;

        const bg = style.getPropertyValue('--bg-color').trim();
        const fg = style.getPropertyValue('--text-color').trim();
        const accent = style.getPropertyValue('--primary-color').trim();
        const selection = style.getPropertyValue('--hover-color').trim();

        // 変数が解決できないときの逃げ道。レジストリの bootBg があればそれ、
        // 無ければ明暗だけ合わせる。テーマごとの分岐は持たない。
        const finalBg = bg || (entry && entry.bootBg) || (isDark ? '#1e1e22' : '#ffffff');
        const finalFg = fg || (isDark ? '#d4d4d4' : '#1f1f1f');

        // black / brightBlack は背景と前景から作る。固定値にすると、背景が
        // 明るい暗テーマ (nord) や暗い明テーマで沈む。以前は black に背景色
        // をそのまま入れていたので、明るいテーマでは黒い文字が消えていた。
        const black = mixHex(finalBg, finalFg, 0.45) || (isDark ? '#5a5a5a' : '#000000');
        const brightBlack = mixHex(finalBg, finalFg, 0.65) || (isDark ? '#8a8a8a' : '#4a4a4a');

        const theme = {
            background: finalBg,
            foreground: finalFg,
            cursor: accent || (isDark ? '#8ec4ff' : '#0a4b96'),
            cursorAccent: finalBg,
            selectionBackground: selection
                || (isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.12)'),
            black,
            brightBlack,
            ...(isDark ? ANSI_DARK : ANSI_LIGHT),
        };
        for (const session of this.sessions.values()) session.term.options.theme = theme;

        // Sync terminal container background to prevent white flashes or borders
        if (EL.terminal.container) {
            EL.terminal.container.style.backgroundColor = finalBg;
        }
        if (EL.terminal.panel) {
            EL.terminal.panel.style.backgroundColor = finalBg;
        }

        // Redraw to ensure changes are visible
        for (const session of this.sessions.values()) {
            session.term.refresh(0, session.term.rows - 1);
        }
    }

    /** Copy the current selection. No-op when nothing is selected. */
    async copySelection() {
        if (!this.term || !this.term.hasSelection()) return;
        const text = this.term.getSelection();
        if (!text) return;
        try {
            await writeText(text);
        } catch (e) {
            console.warn('Terminal copy failed:', e);
        }
    }

    /** Paste the clipboard into the shell. */
    async pasteFromClipboard() {
        if (!this.term) return;
        let text = '';
        try {
            text = await readText();
        } catch (e) {
            console.warn('Terminal paste failed:', e);
            return;
        }
        if (text) this.pasteText(text);
    }

    /**
     * Send text to the shell as if it had been pasted.
     *
     * term.paste() (rather than write_to_pty directly) is deliberate: it applies
     * bracketed-paste when the shell asked for it and normalises CRLF, so a
     * multi-line paste doesn't fire a stray extra Enter.
     */
    pasteText(text) {
        if (!this.term || !text) return;
        this.term.paste(String(text).replace(/\r\n/g, '\n'));
    }

    /**
     * Clipboard/selection UI that isn't a key: the right-click menu, middle-click
     * paste, and dropping files to insert their full paths.
     */
    bindClipboardAndDrop() {
        const host = EL.terminal.container;
        if (!host) return;

        host.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            ContextMenu.show(e, [
                { label: t('Copy  (Ctrl+Shift+C)'), action: () => this.copySelection() },
                { label: t('Paste  (Ctrl+V)'), action: () => this.pasteFromClipboard() },
                { type: 'separator' },
                { label: t('Select All  (Ctrl+Shift+A)'), action: () => this.term?.selectAll() },
                { label: t('Clear'), action: () => this.term?.clear() },
            ]);
        });

        // Middle-click paste, the X11 convention people reach for out of habit.
        host.addEventListener('mousedown', (e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            this.pasteFromClipboard();
        });

        // Dropping a file types its full path — the terminal is where you want
        // the path, not the contents. stopPropagation keeps App.js's global
        // file-drop handler from opening the file as a tab instead.
        host.addEventListener('dragover', (e) => {
            if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
        });

        host.addEventListener('drop', (e) => {
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
            if (!files.length) return;
            e.preventDefault();
            e.stopPropagation();
            // WebView2 exposes the real path on File.path (non-standard but
            // reliable there); elsewhere only the name is available.
            const text = files
                .map((f) => f.path || f.name)
                .filter(Boolean)
                .map(quoteForShell)
                .join(' ');
            if (text) this.pasteText(text);
            this.term?.focus();
        });
    }

    bindEvents() {
        // Toggle terminal
        EL.terminal.toggleBtn?.addEventListener('click', () => this.toggle());
        // Hiding only: the terminals keep running behind the closed panel, so
        // reopening it puts you back where you were instead of at a new shell.
        EL.terminal.closeBtn?.addEventListener('click', () => this.hide());
        EL.terminal.clearBtn?.addEventListener('click', () => this.term?.clear());
        // The shell picker is bound by init(), not here: two unsynchronised
        // calls raced and bound the change listener twice.
        EL.terminal.newBtn?.addEventListener('click', () => this.createSession());

        window.addEventListener('resize', () => {
            if (this.isOpen) {
                this.fitAddon?.fit();
                this.notifyResize();
            }
        });

        // Resizer Logic
        EL.terminal.resizer?.addEventListener('mousedown', (e) => {
            this.resizing = true;
            this.startY = e.clientY;
            this.startHeight = EL.terminal.panel.getBoundingClientRect().height;
            EL.terminal.resizer.classList.add('resizing');
            document.body.style.cursor = 'row-resize';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.resizing) return;
            // For bottom docked terminal: 
            // Dragging UP (smaller Y) should increase height.
            // Dragging DOWN (larger Y) should decrease height.
            const deltaY = this.startY - e.clientY;
            let newHeight = this.startHeight + deltaY;
            
            // Constrain height
            newHeight = Math.max(100, Math.min(newHeight, window.innerHeight * 0.8));
            
            EL.terminal.panel.style.height = `${newHeight}px`;
            
            // Force redraw/reflow for xterm before fit
            if (this.term) {
                this.fitAddon?.fit();
                this.notifyResize();
            }
        });

        window.addEventListener('mouseup', () => {
            if (this.resizing) {
                this.resizing = false;
                EL.terminal.resizer.classList.remove('resizing');
                document.body.style.cursor = 'default';
            }
        });
    }

    /**
     * Fill the shell dropdown with what is installed and wire the change.
     *
     * Populated once, lazily: probing the filesystem on every terminal toggle
     * would be wasted work, and a shell does not appear mid-session.
     */
    async bindShellPicker() {
        const sel = EL.terminal.shellSelect;
        if (!sel || sel.dataset.ready === '1') return;

        const shells = await this.listShells();
        // Kept so the session list can name a terminal by its shell.
        this._shells = shells;
        if (!shells.length) { sel.style.display = 'none'; return; }

        sel.innerHTML = shells
            .map((s) => `<option value="${s.id}">${s.name}</option>`)
            .join('');
        // An unknown or uninstalled saved shell falls back to the first one, so
        // a machine that lost Git Bash still opens a terminal.
        const saved = this.shellId;
        sel.value = shells.some((s) => s.id === saved) ? saved : shells[0].id;
        if (sel.value !== saved) localStorage.setItem('terminal_shell', sel.value);

        sel.title = shells.find((s) => s.id === sel.value)?.path || 'Shell';
        sel.addEventListener('change', () => {
            sel.title = shells.find((s) => s.id === sel.value)?.path || 'Shell';
            this.setShell(sel.value);
        });
        sel.dataset.ready = '1';
    }

    async toggle() {
        this.isOpen ? this.hide() : await this.show();
    }

    async show() {
        EL.terminal.panel.style.display = 'flex';
        EL.terminal.resizer.style.display = 'block';
        this.isOpen = true;
        
        this.renderSessionList();
        // Wait for DOM to update then fit
        setTimeout(async () => {
            if (this.sessions.size === 0) return;   // the empty state is showing
            this.fitAddon?.fit();
            if (!this.ptyReady) {
                // Fresh terminal on (re)open — clear any leftover output from a
                // previous, exited session.
                this.term?.reset();
                await this.spawnPty();
            }
        }, 50);
    }

    hide() {
        EL.terminal.panel.style.display = 'none';
        EL.terminal.resizer.style.display = 'none';
        this.isOpen = false;
    }

    /** The shell the user picked, or '' for the platform default. */
    get shellId() {
        return localStorage.getItem('terminal_shell') || '';
    }

    /**
     * Switch shells and restart. The running shell has to go: a PTY is bound to
     * its process, so there is no way to swap the program underneath it.
     */
    setShell(id) {
        localStorage.setItem('terminal_shell', id || '');
        this.renderSessionList();
    }

    /** Shells actually installed on this machine, as the backend found them. */
    async listShells() {
        try {
            return await invoke('list_shells');
        } catch (e) {
            console.warn('Could not list shells:', e);
            return [];
        }
    }

    async spawnPty(id = this.activeId) {
        const session = this.sessions.get(id);
        if (!session) return false;
        try {
            // session.shellId, not the header's current pick: an existing
            // terminal keeps its own shell across a workspace restart.
            await invoke('spawn_pty', { shell: session.shellId, id });
            session.ptyReady = true;
            this.notifyResize(id);
            this.renderSessionList();
            return true;
        } catch (e) {
            console.error('Failed to spawn PTY', e);
            session.term.write(`\r\n\x1b[31m[Error] Failed to start terminal: ${e}\x1b[0m\r\n`);
            return false;
        }
    }

    async restart() {
        try {
            this._restarting = true; // suppress the pty_closed → close-panel handler
            // Every terminal follows the workspace, not just the visible one.
            for (const session of this.sessions.values()) {
                session.ptyReady = false;
                try { await invoke('stop_pty', { id: session.id }); } catch (e) { /* gone */ }
                session.term.write('\r\n\x1b[32mRestarting terminal for new workspace...\x1b[0m\r\n');
                await this.spawnPty(session.id);
            }
        } catch (e) {
            console.error('Failed to restart PTY', e);
        } finally {
            // Keep the guard up briefly so the old PTY's (async) pty_closed event
            // is caught here and doesn't close the freshly-restarted panel.
            setTimeout(() => { this._restarting = false; }, 600);
        }
    }

    async notifyResize(id = this.activeId) {
        const session = this.sessions.get(id);
        if (!session || !session.ptyReady) return;
        try {
            await invoke('resize_pty', {
                cols: session.term.cols, rows: session.term.rows, id,
            });
        } catch (e) {
            console.warn('Failed to resize PTY', e);
        }
    }

    /**
     * Forcefully clears the execution lock.
     */
    abortCommand() {
        this.isExecuting = false;
        this.term?.write('\x1b[31m\r\n[AI] Command execution aborted/cleared.\x1b[0m\r\n');
    }

    /**
     * Executes a command in the active PTY and returns the output.
     * This allows the AI to run commands that are visible to the user in the terminal panel.
     */
    async executeCommand(command) {
        if (this.isExecuting) {
            throw new Error("Terminal is busy executing another command. If a process is hanging, please wait for timeout or restart the terminal.");
        }
        
        if (!this.isOpen) {
            await this.show();
        }
        // The panel no longer opens a shell by itself, so the AI has to ask for
        // one rather than assume the active session exists.
        if (this.sessions.size === 0) {
            if (!await this.createSession()) {
                throw new Error('Could not open a terminal.');
            }
        }

        this.isExecuting = true;

        try {
            // If PTY is not ready, attempt to spawn it
            if (!this.ptyReady) {
                this.term?.write('\x1b[36m[AI] Starting new terminal session...\x1b[0m\r\n');
                const success = await this.spawnPty();
                if (!success) {
                    this.isExecuting = false;
                    throw new Error("Could not spawn terminal process.");
                }
                // Wait for shell prompt to settle and check if it's still alive
                await new Promise(r => setTimeout(r, 2000));
            }

            // Check if the terminal seems busy (e.g. running dev server)
            const lastLines = this.term?.buffer.active.getLine(this.term.buffer.active.cursorY)?.translateToString() || '';
            const isLikelyPrompt = lastLines.trim().endsWith('>') || lastLines.trim().endsWith('$') || lastLines.trim().endsWith('%');
            
            if (!isLikelyPrompt && lastLines.trim().length > 0) {
                this.term?.write('\x1b[33m[AI Warning] Terminal seems busy (already running a process). Commands may time out if the shell prompt doesn\'t return.\x1b[0m\r\n');
            }

            // Visual feedback for the user
            this.term?.write(`\x1b[35m[AI Executing] ${command}\x1b[0m\r\n`);

            return await new Promise(async (resolve, reject) => {
                const sentinel = `__DONE_${Math.random().toString(36).substring(7)}__`;
                let output = '';
                let timer = null;

                const cleanup = () => {
                    this.isExecuting = false;
                    if (unlisten) unlisten();
                    if (timer) clearTimeout(timer);
                };

                const unlisten = await listen(PTY_OUTPUT_EVENT, (event) => {
                    const data = event.payload;
                    output += data;

                    if (output.includes(sentinel)) {
                        cleanup();
                        // Extract output before the sentinel
                        const parts = output.split(command);
                        let actualOutput = parts.length > 1 ? parts.slice(1).join(command) : output;
                        actualOutput = actualOutput.split(sentinel)[0];
                        
                        // Basic ANSI escape code stripping (optional but helpful for AI)
                        const cleanText = actualOutput.replace(/\x1B\[[0-9;]*[JKmsu]/g, '').trim();
                        resolve(cleanText);
                    }
                });

                // Fallback timeout
                timer = setTimeout(() => {
                    cleanup();
                    const timeoutMsg = "\n[Timeout: Command exceeded 10 minutes. It may still be running in the terminal.]";
                    this.term?.write(`\x1b[33m${timeoutMsg}\x1b[0m\r\n`);
                    resolve(output.replace(/\x1B\[[0-9;]*[JKmsu]/g, '').trim() + timeoutMsg);
                }, 600000); // 10 minutes timeout

                // Send command + sentinel
                // Using \r\n for Windows/Universal compatibility
                const fullCommand = `${command} ; echo ${sentinel}\r\n`;
                await invoke('write_to_pty', { data: fullCommand, id: this.activeId });
            });
        } catch (e) {
            this.isExecuting = false;
            throw e;
        }
    }

    async destroy() {
        for (const unlisten of this.unlisteners) unlisten();
        this.unlisteners = [];
        for (const session of this.sessions.values()) {
            for (const un of session.unlisteners) { try { un(); } catch (e) { /* ignore */ } }
            try { session.term.dispose(); } catch (e) { /* ignore */ }
        }
        this.sessions.clear();
        this.activeId = null;
    }
}

export const terminalManager = new TerminalManager();
