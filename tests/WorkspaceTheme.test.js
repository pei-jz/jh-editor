import { describe, it, expect, beforeEach } from 'vitest';
import {
    globalTheme, setGlobalTheme, workspaceTheme, setWorkspaceTheme, effectiveTheme, workspaceKey,
    globalFamily, setGlobalFamily, themeMode, setThemeMode, followSystem,
    workspaceMode, setWorkspaceMode,
} from '../src/modules/utils/WorkspaceTheme.js';
import { DEFAULT_THEME } from '../src/modules/utils/Themes.js';
import {
    terminalScrollback, setTerminalScrollback, normalizeScrollback,
    SCROLLBACK_DEFAULT, SCROLLBACK_MIN, SCROLLBACK_MAX,
} from '../src/modules/utils/TerminalPrefs.js';

// Windows on different workspaces looked identical. A workspace can carry its
// own theme; one without follows the global setting, as before.

// The mode is fixed here so the OS, which the test environment cannot set,
// does not decide the answer.
describe('workspace themes', () => {
    beforeEach(() => {
        localStorage.clear();
        localStorage.setItem('themeFollowSystem', 'false');
    });

    it('follows the global theme until a workspace has its own', () => {
        expect(effectiveTheme('C:/proj')).toBe(DEFAULT_THEME);
        setGlobalTheme('nord');
        expect(globalTheme()).toBe('nord');
        expect(effectiveTheme('C:/proj')).toBe('nord');
    });

    it('keeps a family per workspace without touching the others', () => {
        setGlobalTheme('nord');
        setWorkspaceTheme('C:/proj', 'coffee');
        expect(effectiveTheme('C:/proj')).toBe('latte-dark');
        expect(effectiveTheme('C:/other')).toBe('nord');
        expect(effectiveTheme('')).toBe('nord');
    });

    // A workspace that sets only its family takes the global mode.
    it('shows the workspace family in the global mode', () => {
        setWorkspaceTheme('C:/proj', 'kakejiku');
        setThemeMode('dark');
        expect(effectiveTheme('C:/proj')).toBe('kakejiku-dark');
        setThemeMode('light');
        expect(effectiveTheme('C:/proj')).toBe('kakejiku');
    });

    it('keeps a mode per workspace, apart from its family', () => {
        setGlobalTheme('nord');                          // global: Nord, dark
        setWorkspaceMode('C:/proj', 'light');
        expect(effectiveTheme('C:/proj')).toBe('nord-light');
        expect(effectiveTheme('C:/other')).toBe('nord');

        setWorkspaceTheme('C:/proj', 'kakejiku');
        expect(effectiveTheme('C:/proj')).toBe('kakejiku');
        setWorkspaceMode('C:/proj', 'dark');
        expect(effectiveTheme('C:/proj')).toBe('kakejiku-dark');
    });

    it('lets a workspace follow the OS while the global mode is fixed', () => {
        setWorkspaceMode('C:/proj', 'system');
        expect(workspaceMode('C:/proj')).toBe('system');
        const dark = !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        expect(effectiveTheme('C:/proj')).toBe(dark ? 'kakejiku-dark' : 'kakejiku');
    });

    it('goes back to the global mode when cleared, or when the value is unknown', () => {
        setWorkspaceMode('C:/proj', 'dark');
        setWorkspaceMode('C:/proj', null);
        expect(workspaceMode('C:/proj')).toBeNull();

        localStorage.setItem('workspaceThemeModes', JSON.stringify({ 'c:/proj': 'dusk' }));
        expect(workspaceMode('C:/proj')).toBeNull();
        expect(workspaceMode('')).toBeNull();
    });

    it("reads a workspace saved as a theme id as that theme's family", () => {
        localStorage.setItem('workspaceThemes', JSON.stringify({ 'c:/proj': 'sumi-e-dark' }));
        expect(workspaceTheme('C:/proj')).toBe('sumi-e');
        expect(effectiveTheme('C:/proj')).toBe('sumi-e');
    });

    it('treats separators, a trailing slash and case as the same workspace', () => {
        setWorkspaceTheme('C:\\Proj\\', 'nord');
        expect(workspaceKey('c:/proj')).toBe(workspaceKey('C:\\Proj\\'));
        expect(workspaceTheme('c:/proj')).toBe('nord');
    });

    it('goes back to the global theme when cleared, or when its theme no longer exists', () => {
        setWorkspaceTheme('C:/proj', 'nord');
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

describe('theme mode', () => {
    beforeEach(() => localStorage.clear());

    it('follows the OS on a new install', () => {
        expect(followSystem()).toBe(true);
        expect(themeMode()).toBe('system');
    });

    // Someone who chose a theme before the mode existed keeps what they chose.
    it('stays fixed on an install that already saved a theme', () => {
        localStorage.setItem('theme', 'kakejiku-dark');
        expect(themeMode()).toBe('dark');
        expect(effectiveTheme('')).toBe('kakejiku-dark');
    });

    it('keeps following the OS after the first family is picked', () => {
        setGlobalFamily('nord');
        expect(themeMode()).toBe('system');
        expect(globalFamily()).toBe('nord');
    });

    it('switches the half, not the family, when the mode is fixed', () => {
        setThemeMode('dark');
        setGlobalFamily('paper');
        expect(globalTheme()).toBe('paper-dark');
        setThemeMode('light');
        expect(globalTheme()).toBe('paper');
        expect(themeMode()).toBe('light');
    });

    it("picks the OS's half while following it", () => {
        setThemeMode('system');
        setGlobalFamily('solarized');
        const dark = !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        expect(effectiveTheme('')).toBe(dark ? 'solarized-dark' : 'solarized-light');
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
