import { describe, it, expect, beforeEach } from 'vitest';
import { State } from '../src/modules/core/Store.js';

describe('Store/State', () => {
    // Note: Store is a singleton object in the current architecture.
    // We test its initial state.
    it('should initialize with default state properties', () => {
        expect(State.currentDir).toBeDefined();
        expect(Array.isArray(State.openFiles)).toBe(true);
        expect(State.activeTabIndex).toBe(-1);
        expect(State.isExplorerVisible).toBeDefined();
        expect(State.vimState).toBeDefined();
        expect(State.vimState.mode).toBe('normal');
    });

    it('should correctly store updates to properties', () => {
        State.currentDir = '/test/dir';
        State.isExplorerVisible = false;

        expect(State.currentDir).toBe('/test/dir');
        expect(State.isExplorerVisible).toBe(false);

        // Reset
        State.currentDir = '.';
        State.isExplorerVisible = true;
    });

    it('should be able to add open files', () => {
        const fileObj = { path: '/test.txt', content: 'hello', isDirty: false };
        State.openFiles.push(fileObj);
        State.activeTabIndex = 0;

        expect(State.openFiles.length).toBeGreaterThan(0);
        expect(State.openFiles[State.openFiles.length - 1]).toEqual(fileObj);
        expect(State.activeTabIndex).toBe(0);

        // Reset
        State.openFiles.pop();
        State.activeTabIndex = -1;
    });
});
