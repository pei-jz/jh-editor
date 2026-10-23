import { describe, it, expect, beforeEach } from 'vitest';
import {
    globalTheme, setGlobalTheme, workspaceTheme, setWorkspaceTheme, effectiveTheme, workspaceKey,
} from '../src/modules/utils/WorkspaceTheme.js';
import { DEFAULT_THEME } from '../src/modules/utils/Themes.js';
import {
    terminalScrollback, setTerminalScrollback, normalizeScrollback,
    SCROLLBACK_DEFAULT, SCROLLBACK_MIN, SCROLLBACK_MAX,
} from '../src/modules/utils/TerminalPrefs.js';

// Windows on different workspaces looked identical. A workspace can carry its
// own theme; one without follows the global setting, as before.

describe('workspace themes', () => {
    beforeEach(() => localStorage.clear());

    it('follows the global theme until a workspace has its own', () => {
        expect(effectiveTheme('C:/proj')).toBe(DEFAULT_THEME);
        setGlobalTheme('nord');
        expect(globalTheme()).toBe('nord');
        expect(effectiveTheme('C:/proj')).toBe('nord');
    });

    it('keeps a theme per workspace without touching the others', () => {
        setGlobalTheme('nord');
        setWorkspaceTheme('C:/proj', 'midnight');
        expect(effectiveTheme('C:/proj')).toBe('midnight');
        expect(effectiveTheme('C:/other')).toBe('nord');
        expect(effectiveTheme('')).toBe('nord');
    });

    it('treats separators, a trailing slash and case as the same workspace', () => {
        setWorkspaceTheme('C:\\Proj\\', 'midnight');
        expect(workspaceKey('c:/proj')).toBe(workspaceKey('C:\\Proj\\'));
        expect(workspaceTheme('c:/proj')).toBe('midnight');
    });

    it('goes back to the global theme when cleared, or when its theme no longer exists', () => {
        setWorkspaceTheme('C:/proj', 'midnight');
        setWorkspaceTheme('C:/proj', null);
        expect(workspaceTheme('C:/proj')).toBeNull();

        localStorage.setItem('workspaceThemes', JSON.stringify({ 'c:/gone': 'a-removed-theme' }));
        expect(workspaceTheme('C:/gone')).toBeNull();
    });

    it('survives a corrupt store', () => {
        localStorage.setItem('workspaceThemes', '{not json');
        expect(effectiveTheme('C:/proj')).toBe(DEFAULT_THEME);
    });
});

describe('terminal scrollback', () => {
    beforeEach(() => localStorage.clear());

    it('keeps far more than xterm\'s 1000 lines by default', () => {
        expect(terminalScrollback()).toBe(SCROLLBACK_DEFAULT);
        expect(SCROLLBACK_DEFAULT).toBeGreaterThan(1000);
    });

    it('stores what is set, clamped to a usable range', () => {
        expect(setTerminalScrollback(50000)).toBe(50000);
        expect(terminalScrollback()).toBe(50000);
        expect(normalizeScrollback(5)).toBe(SCROLLBACK_MIN);
        expect(normalizeScrollback(1e9)).toBe(SCROLLBACK_MAX);
        expect(normalizeScrollback('abc')).toBe(SCROLLBACK_DEFAULT);
    });
});
