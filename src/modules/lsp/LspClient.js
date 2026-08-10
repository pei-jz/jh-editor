/**
 * LspClient.js — Frontend LSP client wrapper.
 * Manages communication with the Rust LSP backend and caches diagnostics.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { State } from '../core/Store.js';

// Per-window diagnostics event so a window only gets its own LSP diagnostics
// (Tauri v2 global `listen` receives events regardless of emit target).
const LSP_DIAGNOSTICS_EVENT = (() => {
    try { return `lsp-diagnostics::${getCurrentWindow().label}`; } catch (_) { return 'lsp-diagnostics::main'; }
})();

class LspClient {
    constructor() {
        this.diagnosticsCache = new Map(); // path -> LspDiagnostic[]
        this.onDiagnosticsUpdate = null; // Callback: (path, diagnostics) => void
        this.activeLanguages = new Set();
        this.documentVersions = new Map(); // path -> version number
        this._unlisten = null;
        this._initialized = false;
        this._debounceTimers = new Map();
        // serverLang -> 'running' | 'unavailable'. Drives the status-bar warning.
        this.serverStatus = new Map();
        this.onServerStatusChange = null; // Callback: (serverLang, status) => void
    }

    _setServerStatus(serverLang, status) {
        this.serverStatus.set(serverLang, status);
        if (this.onServerStatusChange) {
            try { this.onServerStatusChange(serverLang, status); } catch (_) {}
        }
    }

    /** Status of the server that would handle `filePath`: {language, status} or null. */
    getServerStatusForFile(filePath) {
        const language = this.getLanguageForFile(filePath);
        if (!language) return null;
        const serverLang = language === 'javascript' ? 'typescript' : language;
        return { language: serverLang, status: this.serverStatus.get(serverLang) || null };
    }

    /** Human-readable install guidance for a server language. */
    getInstallInfo(serverLang) {
        switch (serverLang) {
            case 'typescript':
                return { name: 'typescript-language-server',
                    command: 'npm install -g typescript-language-server typescript',
                    url: 'https://github.com/typescript-language-server/typescript-language-server' };
            case 'rust':
                return { name: 'rust-analyzer',
                    command: 'rustup component add rust-analyzer',
                    url: 'https://rust-analyzer.github.io/' };
            case 'python':
                return { name: 'pyright',
                    command: 'npm install -g pyright',
                    url: 'https://github.com/microsoft/pyright' };
            default:
                return { name: serverLang, command: '', url: '' };
        }
    }

    /**
     * Initialize the LSP client and start listening for diagnostics events.
     */
    async init() {
        if (this._initialized) return;
        this._initialized = true;

        this._unlisten = await listen(LSP_DIAGNOSTICS_EVENT, (event) => {
            const { path, diagnostics } = event.payload;
            this.diagnosticsCache.set(path, diagnostics);
            
            // Notify UI
            if (this.onDiagnosticsUpdate) {
                this.onDiagnosticsUpdate(path, diagnostics);
            }
        });
    }

    /**
     * Start an LSP server for the given language.
     * @param {string} language - 'typescript', 'javascript', or 'rust'
     */
    async startServer(language) {
        if (!State.currentDir) return;
        if (this.activeLanguages.has(language)) return;

        try {
            const result = await invoke('start_lsp', {
                language,
                workspaceRoot: State.currentDir
            });
            this.activeLanguages.add(language);
            this._setServerStatus(language, 'running');
        } catch (e) {
            // Most commonly the server binary isn't installed. Surface it (the
            // status bar shows a warning); we don't auto-install.
            this._setServerStatus(language, 'unavailable');
            console.warn(`LSP Client: Failed to start ${language} server:`, e);
        }
    }

    /**
     * Stop an LSP server.
     * @param {string} language
     */
    async stopServer(language) {
        try {
            await invoke('stop_lsp', { language });
            this.activeLanguages.delete(language);
            // Clear diagnostics for this language
            for (const [path, _] of this.diagnosticsCache) {
                this.diagnosticsCache.delete(path);
            }
        } catch (e) {
            console.warn(`LSP Client: Failed to stop ${language} server:`, e);
        }
    }

    /**
     * Stop all active LSP servers.
     */
    async stopAll() {
        for (const lang of this.activeLanguages) {
            await this.stopServer(lang);
        }
    }

    /**
     * Determine the LSP language for a file based on its extension.
     * @param {string} filePath
     * @returns {string|null}
     */
    getLanguageForFile(filePath) {
        if (!filePath) return null;
        const ext = filePath.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'ts':
            case 'tsx':
                return 'typescript';
            case 'js':
            case 'jsx':
            case 'mjs':
            case 'cjs':
                return 'javascript';  // Uses typescript-language-server too
            case 'rs':
                return 'rust';
            case 'py':
                return 'python';
            default:
                return null;
        }
    }

    /**
     * Notify the LSP server that a file was opened.
     * Automatically starts the server if needed.
     * @param {string} filePath
     * @param {string} content
     */
    async didOpen(filePath, content) {
        const language = this.getLanguageForFile(filePath);
        if (!language) return;

        // Auto-start server
        if (!this.activeLanguages.has(language)) {
            // For JS files, use typescript server (it handles both)
            const serverLang = language === 'javascript' ? 'typescript' : language;
            if (!this.activeLanguages.has(serverLang)) {
                await this.startServer(serverLang);
            }
        }

        const serverLang = language === 'javascript' ? 'typescript' : language;
        this.documentVersions.set(filePath, 1);

        try {
            await invoke('lsp_did_open', {
                language: serverLang,
                path: filePath,
                content
            });
        } catch (e) {
            console.warn('LSP Client: didOpen failed:', e);
        }
    }

    /**
     * Notify the LSP server that a file's content changed.
     * Debounced to avoid flooding the server.
     * @param {string} filePath
     * @param {string} content
     */
    didChange(filePath, content) {
        const language = this.getLanguageForFile(filePath);
        if (!language) return;

        // Debounce: wait 500ms after last change
        if (this._debounceTimers.has(filePath)) {
            clearTimeout(this._debounceTimers.get(filePath));
        }

        this._debounceTimers.set(filePath, setTimeout(async () => {
            this._debounceTimers.delete(filePath);

            const version = (this.documentVersions.get(filePath) || 1) + 1;
            this.documentVersions.set(filePath, version);

            const serverLang = language === 'javascript' ? 'typescript' : language;

            try {
                await invoke('lsp_did_change', {
                    language: serverLang,
                    path: filePath,
                    content,
                    version
                });
            } catch (e) {
                // Server might not be running, ignore
            }
        }, 500));
    }

    /**
     * Notify the LSP server that a file was closed.
     * @param {string} filePath
     */
    async didClose(filePath) {
        const language = this.getLanguageForFile(filePath);
        if (!language) return;

        const serverLang = language === 'javascript' ? 'typescript' : language;
        this.documentVersions.delete(filePath);

        try {
            await invoke('lsp_did_close', {
                language: serverLang,
                path: filePath
            });
        } catch (e) {
            // Ignore
        }

        // Clear diagnostics for this file
        this.diagnosticsCache.delete(filePath);
    }

    /**
     * Get cached diagnostics for a file.
     * @param {string} filePath
     * @returns {Array} Array of LspDiagnostic objects
     */
    getDiagnostics(filePath) {
        return this.diagnosticsCache.get(filePath) || [];
    }

    /**
     * Get all diagnostics across all files.
     * Useful for the AI Agent's getDiagnostics() function.
     * @returns {Array}
     */
    getAllDiagnostics() {
        const all = [];
        for (const [path, diags] of this.diagnosticsCache) {
            diags.forEach(d => all.push({ ...d, path }));
        }
        return all;
    }

    /**
     * Get completions at the given position.
     * @param {string} filePath
     * @param {number} line - 0-based
     * @param {number} character - 0-based
     */
    async getCompletion(filePath, line, character) {
        const language = this.getLanguageForFile(filePath);
        if (!language) return [];

        const serverLang = language === 'javascript' ? 'typescript' : language;
        const uri = `file:///${filePath.replace(/\\/g, '/').replace(/^\//, '')}`;

        try {
            const result = await invoke('lsp_request', {
                language: serverLang,
                method: 'textDocument/completion',
                params: {
                    textDocument: { uri },
                    position: { line, character }
                }
            });
            
            // Completion can return CompletionItem[] or CompletionList
            const items = Array.isArray(result) ? result : (result?.items || []);
            return items;
        } catch (e) {
            console.warn('LSP Client: completion failed:', e);
            return [];
        }
    }

    /**
     * Get definition at the given position.
     * @param {string} filePath
     * @param {number} line
     * @param {number} character
     */
    async getDefinition(filePath, line, character) {
        const language = this.getLanguageForFile(filePath);
        if (!language) return null;

        const serverLang = language === 'javascript' ? 'typescript' : language;
        const uri = `file:///${filePath.replace(/\\/g, '/').replace(/^\//, '')}`;

        try {
            const result = await invoke('lsp_request', {
                language: serverLang,
                method: 'textDocument/definition',
                params: {
                    textDocument: { uri },
                    position: { line, character }
                }
            });
            
            // Definition can return Location | Location[] | LocationLink[]
            return result;
        } catch (e) {
            console.warn('LSP Client: definition failed:', e);
            return null;
        }
    }

    /**
     * Get hover info at the given position.
     * @param {string} filePath
     * @param {number} line
     * @param {number} character
     */
    async getHover(filePath, line, character) {
        const language = this.getLanguageForFile(filePath);
        if (!language) return null;

        const serverLang = language === 'javascript' ? 'typescript' : language;
        const uri = `file:///${filePath.replace(/\\/g, '/').replace(/^\//, '')}`;

        try {
            const result = await invoke('lsp_request', {
                language: serverLang,
                method: 'textDocument/hover',
                params: {
                    textDocument: { uri },
                    position: { line, character }
                }
            });
            return result;
        } catch (e) {
            console.warn('LSP Client: hover failed:', e);
            return null;
        }
    }

    /**
     * Get references for a symbol at the given position.
     * @param {string} filePath
     * @param {number} line
     * @param {number} character
     */
    async getReferences(filePath, line, character) {
        const language = this.getLanguageForFile(filePath);
        if (!language) return [];

        const serverLang = language === 'javascript' ? 'typescript' : language;
        const uri = `file:///${filePath.replace(/\\/g, '/').replace(/^\//, '')}`;

        try {
            const result = await invoke('lsp_request', {
                language: serverLang,
                method: 'textDocument/references',
                params: {
                    textDocument: { uri },
                    position: { line, character },
                    context: { includeDeclaration: true }
                }
            });
            return result || [];
        } catch (e) {
            console.warn('LSP Client: references failed:', e);
            return [];
        }
    }

    /**
     * Dispose: stop all servers and clean up listeners.
     */
    async dispose() {
        await this.stopAll();
        if (this._unlisten) {
            this._unlisten();
            this._unlisten = null;
        }
        for (const timer of this._debounceTimers.values()) {
            clearTimeout(timer);
        }
        this._debounceTimers.clear();
        this._initialized = false;
    }
}

export const lspClient = new LspClient();
