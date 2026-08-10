import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external Tauri plugins & windows
vi.mock('@tauri-apps/plugin-shell', () => ({
    open: vi.fn()
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: vi.fn(() => ({
        setFocus: vi.fn()
    }))
}));

vi.mock('../src/modules/lsp/LspClient.js', () => ({
    lspClient: {
        getLanguageForFile: vi.fn(),
        getDefinition: vi.fn()
    }
}));

vi.mock('../src/modules/utils/FileSystem.js', () => ({
    joinPath: vi.fn((dir, file) => `${dir}/${file}`)
}));

import { Navigation } from '../src/modules/utils/Navigation.js';
import { open } from '@tauri-apps/plugin-shell';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { lspClient } from '../src/modules/lsp/LspClient.js';

describe('Navigation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.app = undefined;
    });

    describe('resolveToken', () => {
        it('should resolve a URL inside quotes', () => {
            const text = 'const url = "https://example.com";';
            const offset = text.indexOf('example.com');
            const token = Navigation.resolveToken(text, offset, '/src/main.js');

            expect(token).toEqual({
                type: 'url',
                value: 'https://example.com',
                start: text.indexOf('https:'),
                end: text.indexOf('";')
            });
        });

        it('should resolve a relative path inside quotes', () => {
            const text = 'import { foo } from "./utils/helper.js";';
            const offset = text.indexOf('helper.js');
            const token = Navigation.resolveToken(text, offset, '/src/main.js');

            expect(token).toEqual({
                type: 'path',
                value: './utils/helper.js',
                basePath: '/src/main.js',
                start: text.indexOf('./utils/'),
                end: text.indexOf('";')
            });
        });

        it('should resolve a symbol word outside quotes', () => {
            const text = 'function calculateTotal(price) { return price; }';
            const offset = text.indexOf('calculateTotal') + 3;
            const token = Navigation.resolveToken(text, offset, '/src/main.js');

            expect(token).toEqual({
                type: 'symbol',
                value: 'calculateTotal',
                filePath: '/src/main.js',
                offset: offset,
                start: text.indexOf('calculateTotal'),
                end: text.indexOf('(price)')
            });
        });

        it('should return null if no token is resolvable at offset', () => {
            const text = '   ';
            const token = Navigation.resolveToken(text, 1, '/src/main.js');
            expect(token).toBeNull();
        });
    });

    describe('handleNavigation', () => {
        it('should open URL using Tauri open', async () => {
            const tokenInfo = { type: 'url', value: 'https://google.com' };
            await Navigation.handleNavigation(tokenInfo);
            expect(open).toHaveBeenCalledWith('https://google.com');
        });

        it('should open paths via window.app.openFile', async () => {
            const mockOpenFile = vi.fn();
            window.app = { openFile: mockOpenFile };

            const tokenInfo = { type: 'path', value: './utils/helper.js', basePath: '/src/main.js' };
            await Navigation.handleNavigation(tokenInfo);
            expect(mockOpenFile).toHaveBeenCalledWith('/src/./utils/helper.js');
        });

        it('should jump to symbol definition in current file using regex fallback', async () => {
            const mockTextarea = {
                value: 'const myVar = 10;\nfunction mySymbol() {\n  return 20;\n}',
                focus: vi.fn(),
                setSelectionRange: vi.fn(),
                dispatchEvent: vi.fn()
            };
            const mockView = {
                textarea: mockTextarea,
                lineHeight: 18,
                _getLineIndexFromOffset: vi.fn(() => 1)
            };
            window.app = {
                getCurrentView: () => mockView
            };

            const tokenInfo = { type: 'symbol', value: 'mySymbol', filePath: '/src/main.js', offset: 0 };
            await Navigation.handleNavigation(tokenInfo);

            expect(mockTextarea.focus).toHaveBeenCalled();
            expect(mockTextarea.setSelectionRange).toHaveBeenCalledWith(18, 35);
        });

        it('should use LSP definition if available', async () => {
            vi.mocked(lspClient.getLanguageForFile).mockReturnValue('javascript');
            vi.mocked(lspClient.getDefinition).mockResolvedValue({
                uri: 'file:///src/helper.js',
                range: { start: { line: 5 } }
            });

            const mockOpenFile = vi.fn();
            window.app = {
                getCurrentView: () => ({ textarea: { value: 'test' } }),
                openFile: mockOpenFile
            };

            const tokenInfo = { type: 'symbol', value: 'mySymbol', filePath: '/src/main.js', offset: 2 };
            await Navigation.handleNavigation(tokenInfo);

            expect(lspClient.getDefinition).toHaveBeenCalled();
            expect(mockOpenFile).toHaveBeenCalledWith('src/helper.js', 5);
        });
    });
});
