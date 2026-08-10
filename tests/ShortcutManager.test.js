import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ShortcutManager } from '../src/modules/core/ShortcutManager.js';

describe('ShortcutManager', () => {
    let manager;

    beforeEach(() => {
        // Mock loadShortcuts to prevent default shortcuts from polluting unit tests
        vi.spyOn(ShortcutManager.prototype, 'loadShortcuts').mockImplementation(function() {
            this.shortcuts = [];
        });
        manager = new ShortcutManager();
    });

    it('should initialize with GLOBAL scope', () => {
        expect(manager.currentScope).toBe('GLOBAL');
        expect(manager.shortcuts.length).toBe(0);
    });

    it('should register shortcuts correctly', () => {
        const actionSpy = vi.fn();
        manager.register({
            key: 's',
            ctrl: true,
            cmd: 'app:save',
            description: 'Save File',
            action: actionSpy
        });

        expect(manager.shortcuts.length).toBe(1);
        expect(manager.shortcuts[0].key).toBe('s');
        expect(manager.shortcuts[0].ctrl).toBe(true);
        expect(manager.shortcuts[0].scope).toBe('GLOBAL'); // Defaults to GLOBAL
    });

    it('should change scope if scope is valid', () => {
        manager.setScope('EDITOR');
        expect(manager.currentScope).toBe('EDITOR');

        manager.setScope('INVALID_SCOPE'); // Should not change
        expect(manager.currentScope).toBe('EDITOR');
    });

    it('should trigger correctly matched shortcuts in handleKeyDown', () => {
        const actionSpy = vi.fn();
        manager.register({
            key: 's',
            ctrl: true,
            scope: 'GLOBAL',
            action: actionSpy
        });

        const mockEvent = {
            key: 's',
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn()
        };

        manager.handleKeyDown(mockEvent);

        expect(actionSpy).toHaveBeenCalledTimes(1);
        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(mockEvent.stopPropagation).toHaveBeenCalled();
    });

    it('should prioritize scoped shortcuts over global ones', () => {
        const globalSpy = vi.fn();
        const editorSpy = vi.fn();

        manager.register({ key: 'p', ctrl: true, scope: 'GLOBAL', action: globalSpy });
        manager.register({ key: 'p', ctrl: true, scope: 'EDITOR', action: editorSpy });

        manager.setScope('EDITOR');

        const mockEvent = {
            key: 'p',
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn()
        };

        manager.handleKeyDown(mockEvent);

        // Only the editor shortcut should fire
        expect(editorSpy).toHaveBeenCalledTimes(1);
        expect(globalSpy).not.toHaveBeenCalled();
    });

    it('should not trigger shortcut if modifiers do not match precisely', () => {
        const actionSpy = vi.fn();
        manager.register({
            key: 'k',
            ctrl: true,
            shift: false, // Explicitly false or undefined implies false
            scope: 'GLOBAL',
            action: actionSpy
        });

        const mockEvent = {
            key: 'k',
            ctrlKey: true,
            shiftKey: true, // Shift is pressed but not required by shortcut
            altKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn()
        };

        manager.handleKeyDown(mockEvent);

        expect(actionSpy).not.toHaveBeenCalled();
    });
});
