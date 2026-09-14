import { describe, it, expect } from 'vitest';
import { markSaved, isAtSavedState, rememberSavedForm, savedForm } from '../src/modules/utils/DirtyState.js';

const buffer = (content, eol = '\n') => ({ path: 'C:/proj/a.txt', content, eol });

describe('DirtyState', () => {
    it('a freshly loaded buffer is at its saved state', () => {
        const f = buffer('hello');
        markSaved(f);
        expect(isAtSavedState(f)).toBe(true);
    });

    it('editing and then reverting the text returns to the saved state', () => {
        const f = buffer('hello');
        markSaved(f);
        f.content = 'hello!';
        expect(isAtSavedState(f)).toBe(false);
        f.content = 'hello';
        expect(isAtSavedState(f)).toBe(true);
    });

    it('a line-ending change is a change, and changing it back is not', () => {
        const f = buffer('a\nb', '\r\n');
        markSaved(f);
        f.eol = '\n';
        expect(isAtSavedState(f)).toBe(false);
        f.eol = '\r\n';
        expect(isAtSavedState(f)).toBe(true);
    });

    it('a buffer with no baseline is never reported clean', () => {
        // Untitled drafts, AI output: nothing on disk to compare against.
        expect(isAtSavedState({ path: null, content: '' })).toBe(false);
        expect(isAtSavedState(null)).toBe(false);
    });

    it('saving moves the baseline to the new text', () => {
        const f = buffer('v1');
        markSaved(f);
        f.content = 'v2';
        markSaved(f);
        expect(isAtSavedState(f)).toBe(true);
        f.content = 'v1';
        expect(isAtSavedState(f)).toBe(false);
    });

    it('ignores a buffer whose content is not held in memory', () => {
        const f = { path: 'C:/huge.log', content: undefined };
        markSaved(f);
        expect(f.savedContent).toBeUndefined();
        expect(isAtSavedState(f)).toBe(false);
    });
});

describe('DirtyState saved forms', () => {
    // A view that rewrites the document (Markdown blocks, CSV grid) turns the
    // saved text '# T\n\n\npara\n' into '# T\n\npara' without changing it.
    it("matching the view's form of the saved text counts as clean", () => {
        const f = buffer('# T\n\n\npara\n');
        markSaved(f);
        rememberSavedForm(f, 'blocks', '# T\n\npara');
        f.content = '# T\n\npara changed';
        expect(isAtSavedState(f, 'blocks')).toBe(false);
        f.content = '# T\n\npara';
        expect(isAtSavedState(f, 'blocks')).toBe(true);
    });

    it('only for the key it was remembered under', () => {
        const f = buffer('a,b\n');
        markSaved(f);
        rememberSavedForm(f, 'csv', 'a,b');
        f.content = 'a,b';
        expect(isAtSavedState(f)).toBe(false);
        expect(isAtSavedState(f, 'other')).toBe(false);
        expect(isAtSavedState(f, 'csv')).toBe(true);
    });

    it('goes stale when the file is saved again', () => {
        const f = buffer('one\n');
        markSaved(f);
        rememberSavedForm(f, 'k', 'one');
        f.content = 'two';
        markSaved(f);
        expect(savedForm(f, 'k')).toBeUndefined();
        f.content = 'one';
        expect(isAtSavedState(f, 'k')).toBe(false);
    });

    it('is not remembered for a buffer with no baseline', () => {
        const f = { path: null, content: 'x' };
        rememberSavedForm(f, 'k', 'x');
        expect(savedForm(f, 'k')).toBeUndefined();
        expect(isAtSavedState(f, 'k')).toBe(false);
    });
});
