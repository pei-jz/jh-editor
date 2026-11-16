import { beforeEach, describe, expect, it } from 'vitest';
import { setTerminalDock, terminalDock } from '../src/modules/utils/TerminalPrefs.js';

describe('where the terminal is shown', () => {
    beforeEach(() => localStorage.clear());

    it('starts at the bottom', () => {
        expect(terminalDock()).toBe('bottom');
    });

    it('remembers the right side and an editor tab', () => {
        setTerminalDock('right');
        expect(terminalDock()).toBe('right');
        setTerminalDock('tab');
        expect(terminalDock()).toBe('tab');
    });

    it('reads anything else as the bottom', () => {
        setTerminalDock('left');
        expect(terminalDock()).toBe('bottom');
        localStorage.setItem('terminal_dock', 'floating');
        expect(terminalDock()).toBe('bottom');
    });
});
