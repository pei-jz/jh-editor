import { open } from '@tauri-apps/plugin-shell';
import * as FS from './FileSystem.js';
import { State } from '../core/Store.js';
import { loadExplorer, focusExplorer } from '../core/Explorer.js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { lspClient } from '../lsp/LspClient.js';

let hasOpenedURLInSession = false;

/**
 * Utility for editor navigation (Ctrl+Click)
 */
export const Navigation = {
    /**
     * Extracts token at the given offset and determines its type.
     */
    resolveToken(text, offset, currentFilePath = '') {
        if (!text) return null;

        // 1. Try to find if it's a URL or Path (look for quotes first)
        const quoteInfo = this._getTokenInQuotes(text, offset);
        if (quoteInfo) {
            const val = quoteInfo.value;
            if (val.startsWith('http://') || val.startsWith('https://')) {
                return { type: 'url', value: val, start: quoteInfo.start, end: quoteInfo.end };
            }
            // If it looks like a path (has slash, or dot)
            if (val.includes('/') || val.includes('\\') || val.includes('.')) {
                return { type: 'path', value: val, basePath: currentFilePath, start: quoteInfo.start, end: quoteInfo.end };
            }
        }

        // 2. Fallback to word extraction for symbols (Methods, Classes)
        const wordInfo = this._getWordAt(text, offset);
        if (wordInfo && wordInfo.word) {
            return { type: 'symbol', value: wordInfo.word, filePath: currentFilePath, offset: offset, start: wordInfo.start, end: wordInfo.end };
        }

        return null;
    },

    /**
     * Executes the appropriate navigation action.
     */
    async handleNavigation(tokenInfo) {
        if (!tokenInfo) return;

        try {
            if (tokenInfo.type === 'url') {
                await open(tokenInfo.value);

                // Focus behavior: 1st time stays on browser, 
                // 2nd+ time focus back to editor.
                if (hasOpenedURLInSession) {
                    setTimeout(() => {
                        getCurrentWindow().setFocus();
                    }, 500); // Small delay to let browser handle the new tab
                }
                hasOpenedURLInSession = true;
            } else if (tokenInfo.type === 'path') {
                await this._openPath(tokenInfo.value, tokenInfo.basePath);
            } else if (tokenInfo.type === 'symbol') {
                // Get full text for LSP coordinate calculation if possible
                let fullText = undefined;
                if (window.app && window.app.getCurrentView) {
                    const view = window.app.getCurrentView();
                    if (view && view.textarea) fullText = view.textarea.value;
                }
                await this._jumpToSymbol(tokenInfo.value, tokenInfo.filePath, tokenInfo.offset, fullText);
            }
        } catch (err) {
            console.error('Navigation error:', err);
        }
    },

    _getTokenInQuotes(text, offset) {
        let start = offset;
        let end = offset;
        const quotes = ['"', "'"]; // Standard quotes only

        // Look back for opening quote
        while (start >= 0 && !quotes.includes(text[start])) {
            start--;
        }
        if (start < 0) return null;

        // Look ahead for closing quote
        while (end < text.length && !quotes.includes(text[end])) {
            end++;
        }
        if (end >= text.length) return null;

        return {
            value: text.substring(start + 1, end),
            start: start + 1,
            end: end
        };
    },

    _getWordAt(text, offset) {
        const wordRegex = /[a-zA-Z0-9_$@]/;
        let start = offset;
        let end = offset;

        while (start > 0 && wordRegex.test(text[start - 1])) {
            start--;
        }
        while (end < text.length && wordRegex.test(text[end])) {
            end++;
        }

        return {
            word: text.substring(start, end),
            start,
            end
        };
    },

    async _openPath(pathStr, basePath) {
        let fullPath = pathStr;
        
        // Resolve relative path
        if (basePath && (pathStr.startsWith('.') || (!pathStr.startsWith('/') && !pathStr.match(/^[a-zA-Z]:/)))) {
            const baseDir = basePath.substring(0, Math.max(basePath.lastIndexOf('/'), basePath.lastIndexOf('\\')));
            fullPath = FS.joinPath(baseDir, pathStr);
        }

        // Check if file exists (optional, Editor.openFile will handle error)
        if (window.app && window.app.openFile) {
            try {
                // We use a custom flag or just ignore error here
                await window.app.openFile(fullPath);
            } catch (err) {
                // Silently ignore navigation errors for things that aren't files or URLs
                console.warn('Navigation: Could not open path:', fullPath, err);
            }
        }
    },

    async _jumpToSymbol(symbolName, currentFilePath, offset, fullText) {
        if (!window.app || !window.app.getCurrentView) return;

        // 0. Try LSP Definition first
        const language = lspClient.getLanguageForFile(currentFilePath);
        if (language && offset !== undefined && fullText !== undefined) {
            const lines = fullText.slice(0, offset).split('\n');
            const line = lines.length - 1;
            const character = lines[lines.length - 1].length;

            try {
                const result = await lspClient.getDefinition(currentFilePath, line, character);
                if (result) {
                    const location = Array.isArray(result) ? result[0] : result;
                    if (location) {
                        const uri = location.uri || location.targetUri;
                        const range = location.range || location.targetSelectionRange;
                        if (uri && range) {
                            const path = decodeURIComponent(uri.replace('file:///', '').replace('file://', ''));
                            if (window.app.openFile) {
                                await window.app.openFile(path, range.start.line);
                                return;
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn('Navigation: LSP Jump failed, falling back to regex:', err);
            }
        }

        // 1. Search in current file first (Regex Fallback)
        const view = window.app.getCurrentView();
        if (view && view.textarea) {
            const content = view.textarea.value;
            // Basic regex to find definition: function name, class name, name(...), etc.
            const patterns = [
                new RegExp(`(function|class|const|let|var|interface|enum)\\s+${symbolName}\\b`),
                new RegExp(`public|private|protected|static\\s+.*${symbolName}\\s*\\(`), // Java/TS method
                new RegExp(`${symbolName}\\s*[:=]\\s*(function|class|\\()`), // JS property = function
                new RegExp(`\\b${symbolName}\\s*\\([^)]*\\)\\s*{`) // method() {
            ];

            for (const pattern of patterns) {
                const match = content.match(pattern);
                if (match) {
                    const index = match.index;
                    // Jump to matching index in the current view
                    const textarea = view.textarea;
                    textarea.focus();
                    textarea.setSelectionRange(index, index + match[0].length);
                    // Trigger scroll sync if needed
                    const lineIdx = view._getLineIndexFromOffset(index);
                    const scrollY = lineIdx * view.lineHeight;
                    textarea.scrollTop = Math.max(0, scrollY - (textarea.clientHeight / 2));
                    textarea.dispatchEvent(new Event('scroll'));
                    return;
                }
            }
        }

        // 2. Search in workspace if not found in current file (Feature Removed as requested)
    }
};
