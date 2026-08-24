import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { EL } from '../core/Constants.js';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { ContextMenu } from './ContextMenu.js';

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

class TerminalManager {
    constructor() {
        this.term = null;
        this.fitAddon = null;
        this.isOpen = false;
        this.ptyReady = false;
        this.unlisteners = [];
        this.resizing = false;
        this.isExecuting = false;
        this.startY = 0;
        this.startHeight = 0;
    }

    async init() {
        if (!EL.terminal.container) return;

        this.term = new Terminal({
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

        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);

        this.term.open(EL.terminal.container);
        this.fitAddon.fit();

        // Handle terminal input -> send to backend
        this.term.onData(async (data) => {
            if (this.ptyReady) {
                await invoke('write_to_pty', { data });
            } else if (data === '\r') {
                this.term.write('\r\n\x1b[32mRestarting terminal...\x1b[0m\r\n');
                await this.spawnPty();
            }
        });

        // Clipboard + selection keys. Everything goes through the Tauri
        // clipboard plugin: document.execCommand('copy') does nothing here
        // because xterm draws to a canvas and keeps no DOM selection to copy.
        this.term.attachCustomKeyEventHandler((arg) => {
            if (arg.type !== 'keydown') return true;
            const ctrl = arg.ctrlKey || arg.metaKey;
            if (!ctrl) return true;

            // Ctrl+Shift+C always copies; plain Ctrl+C copies only when there is
            // a selection and otherwise falls through as SIGINT, which is what
            // every terminal does.
            if (arg.code === 'KeyC' && (arg.shiftKey || this.term.hasSelection())) {
                arg.preventDefault();
                this.copySelection();
                return false;
            }
            // Ctrl+V and Ctrl+Shift+V paste. preventDefault stops the webview's
            // own paste from ALSO reaching xterm's hidden textarea (double text).
            if (arg.code === 'KeyV') {
                arg.preventDefault();
                this.pasteFromClipboard();
                return false;
            }
            if (arg.shiftKey && arg.code === 'KeyA') {
                arg.preventDefault();
                this.term.selectAll();
                return false;
            }
            return true;
        });

        this.bindClipboardAndDrop();

        // Listen for data from backend -> write to terminal
        const unlistenOutput = await listen(PTY_OUTPUT_EVENT, (event) => {
            if (event.payload) {
                this.term.write(event.payload);
            }
        });
        this.unlisteners.push(unlistenOutput);

        const unlistenClosed = await listen(PTY_CLOSED_EVENT, () => {
            this.ptyReady = false;
            // A workspace switch stops/respawns the PTY itself — don't close for that.
            if (this._restarting) return;
            // The shell exited (e.g. the user typed `exit`): close the terminal
            // panel. Reopening spawns a fresh terminal (show() resets + respawns
            // because ptyReady is now false).
            if (this.isOpen) this.hide();
        });
        this.unlisteners.push(unlistenClosed);

        // Bind UI events
        this.bindEvents();

        // Apply initial theme
        this.applyTheme();
    }

    applyTheme() {
        if (!this.term) return;

        // Extract colors from CSS variables - use document.body where theme classes are applied
        const style = getComputedStyle(document.body);
        
        // Detailed theme check
        const isSolarizedDark = document.body.classList.contains('theme-solarized-dark');
        const isMidnight = document.body.classList.contains('theme-midnight');
        const isDarkTheme = document.body.classList.contains('theme-dark') || document.body.classList.contains('dark-mode');
        const isLatte = document.body.classList.contains('theme-latte');
        const isSolarizedLight = document.body.classList.contains('theme-solarized-light');
        const isPaper = document.body.classList.contains('theme-paper');
        const isBamboo = document.body.classList.contains('theme-bamboo-ancient');

        let bg = style.getPropertyValue('--bg-color').trim();
        let fg = style.getPropertyValue('--text-color').trim();
        let accent = style.getPropertyValue('--primary-color').trim();
        let selection = style.getPropertyValue('--hover-color').trim();

        // Hardcoded fallbacks for known themes if variables fail to resolve correctly
        if (isSolarizedDark) {
            bg = bg || '#002b36';
            fg = fg || '#839496';
        } else if (isMidnight) {
            bg = bg || '#0f111a';
            fg = fg || '#c5cbe0';
        } else if (isDarkTheme) {
            bg = bg || '#1e1e1e';
            fg = fg || '#d4d4d4';
        } else if (isLatte) {
            bg = bg || '#eff1f5';
            fg = fg || '#4c4f69';
        } else if (isSolarizedLight) {
            bg = bg || '#fdf6e3';
            fg = fg || '#657b83';
        } else if (isPaper) {
            bg = bg || '#f3e9d0';
            fg = fg || '#243049';
        } else if (isBamboo) {
            bg = bg || '#3a2e1e';
            fg = fg || '#e8e0cc';
        }

        const finalBg = bg || '#1e1e1e';
        const finalFg = fg || '#d4d4d4';

        this.term.options.theme = {
            background: finalBg,
            foreground: finalFg,
            cursor: accent || '#0078d7',
            cursorAccent: finalBg,
            selectionBackground: selection || 'rgba(255, 255, 255, 0.1)',
            black: finalBg,
            // Brighten up the colors for dark themes to ensure visibility
            brightBlack: isDarkTheme || isSolarizedDark || isMidnight ? '#666666' : '#888888',
        };

        // Sync terminal container background to prevent white flashes or borders
        if (EL.terminal.container) {
            EL.terminal.container.style.backgroundColor = finalBg;
        }
        if (EL.terminal.panel) {
            EL.terminal.panel.style.backgroundColor = finalBg;
        }

        // Redraw to ensure changes are visible
        this.term.refresh(0, this.term.rows - 1);
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
                { label: 'Copy  (Ctrl+Shift+C)', action: () => this.copySelection() },
                { label: 'Paste  (Ctrl+V)', action: () => this.pasteFromClipboard() },
                { type: 'separator' },
                { label: 'Select All  (Ctrl+Shift+A)', action: () => this.term?.selectAll() },
                { label: 'Clear', action: () => this.term?.clear() },
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
        EL.terminal.closeBtn?.addEventListener('click', () => this.hide());
        EL.terminal.clearBtn?.addEventListener('click', () => this.term?.clear());

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

    async toggle() {
        this.isOpen ? this.hide() : await this.show();
    }

    async show() {
        EL.terminal.panel.style.display = 'flex';
        EL.terminal.resizer.style.display = 'block';
        this.isOpen = true;
        
        // Wait for DOM to update then fit
        setTimeout(async () => {
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

    async spawnPty() {
        try {
            await invoke('spawn_pty');
            this.ptyReady = true;
            this.notifyResize();
            return true;
        } catch (e) {
            console.error('Failed to spawn PTY', e);
            this.term?.write(`\r\n\x1b[31m[Error] Failed to start terminal: ${e}\x1b[0m\r\n`);
            return false;
        }
    }

    async restart() {
        try {
            this._restarting = true; // suppress the pty_closed → close-panel handler
            this.ptyReady = false;
            await invoke('stop_pty');
            if (this.term) {
                this.term.write('\r\n\x1b[32mRestarting terminal for new workspace...\x1b[0m\r\n');
            }
            await this.spawnPty();
        } catch (e) {
            console.error('Failed to restart PTY', e);
        } finally {
            // Keep the guard up briefly so the old PTY's (async) pty_closed event
            // is caught here and doesn't close the freshly-restarted panel.
            setTimeout(() => { this._restarting = false; }, 600);
        }
    }

    async notifyResize() {
        if (!this.ptyReady || !this.term) return;
        const cols = this.term.cols;
        const rows = this.term.rows;
        try {
            await invoke('resize_pty', { cols, rows });
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
                await invoke('write_to_pty', { data: fullCommand });
            });
        } catch (e) {
            this.isExecuting = false;
            throw e;
        }
    }

    async destroy() {
        for (const unlisten of this.unlisteners) {
            unlisten();
        }
        this.unlisteners = [];
        this.term?.dispose();
    }
}

export const terminalManager = new TerminalManager();
