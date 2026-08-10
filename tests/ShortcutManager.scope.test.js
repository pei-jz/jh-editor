import { describe, it, expect, beforeEach } from 'vitest';
import { ShortcutManager } from '../src/modules/core/ShortcutManager.js';

/** Build `outer > … > inner` and return the innermost element. */
function nest(chain) {
    let root = null, parent = null;
    for (const spec of chain) {
        const el = document.createElement(spec.tag || 'div');
        if (spec.cls) el.className = spec.cls;
        if (spec.id) el.id = spec.id;
        // jsdom does not implement `isContentEditable`, so define it explicitly
        // (the production code reads that property, as browsers provide it).
        if (spec.contentEditable) {
            el.contentEditable = 'true';
            Object.defineProperty(el, 'isContentEditable', { value: true });
        }
        if (parent) parent.appendChild(el); else root = el;
        parent = el;
    }
    document.body.appendChild(root);
    return parent;
}

describe('ShortcutManager.resolveScope', () => {
    let sm;
    beforeEach(() => {
        document.body.innerHTML = '';
        sm = new ShortcutManager();
        sm.setScope('GLOBAL');
    });

    it('defaults to GLOBAL for unrelated elements', () => {
        expect(sm.resolveScope(nest([{ cls: 'random' }]))).toBe('GLOBAL');
    });

    it('returns null for a non-element', () => {
        expect(sm.resolveScope(null)).toBeNull();
        expect(sm.resolveScope({})).toBeNull();
    });

    it('detects the markdown table editor', () => {
        expect(sm.resolveScope(nest([{ cls: 'visual-table-editor' }, { tag: 'td' }]))).toBe('MARKDOWN_TABLE');
    });

    it('detects the explorer', () => {
        expect(sm.resolveScope(nest([{ id: 'explorer-list-container' }, { cls: 'row' }]))).toBe('EXPLORER');
    });

    // The virtualized explorer renders its rows inside #file-list; F2 (rename)
    // must resolve to EXPLORER scope there, not fall back to GLOBAL's
    // md-block:edit.
    it('detects the explorer by its real container id (#file-list)', () => {
        expect(sm.resolveScope(nest([{ id: 'file-list' }, { cls: 'tree-item' }]))).toBe('EXPLORER');
    });

    describe('CSV', () => {
        it('is CSV for the grid body', () => {
            expect(sm.resolveScope(nest([{ cls: 'csv-grid-virtual-container' }, { tag: 'td' }]))).toBe('CSV');
        });

        it('is CSV for the row-number strip (a sibling of the grid)', () => {
            expect(sm.resolveScope(nest([{ cls: 'csv-row-strip' }, { tag: 'th' }]))).toBe('CSV');
        });

        it('is CSV_EDIT while a cell input has focus', () => {
            expect(sm.resolveScope(nest([{ cls: 'csv-grid-virtual-container' }, { tag: 'input' }]))).toBe('CSV_EDIT');
            expect(sm.resolveScope(nest([{ cls: 'csv-row-strip' }, { tag: 'textarea' }]))).toBe('CSV_EDIT');
        });
    });

    describe('markdown blocks', () => {
        it('is MARKDOWN_BLOCK when a rendered block is selected', () => {
            expect(sm.resolveScope(nest([{ cls: 'md-block' }, { tag: 'p' }]))).toBe('MARKDOWN_BLOCK');
        });

        it('keeps MARKDOWN while editing inside a block', () => {
            const el = nest([{ cls: 'md-block' }, { tag: 'div', contentEditable: true }]);
            sm.setScope('MARKDOWN');
            expect(sm.resolveScope(el)).toBeNull(); // null = don't change
        });

        it('keeps MARKDOWN_TABLE while editing inside a block', () => {
            const el = nest([{ cls: 'md-block' }, { tag: 'textarea' }]);
            sm.setScope('MARKDOWN_TABLE');
            expect(sm.resolveScope(el)).toBeNull();
        });

        it('falls back to EDITOR when the block editor is focused from another scope', () => {
            const el = nest([{ cls: 'md-block' }, { tag: 'textarea' }]);
            sm.setScope('GLOBAL');
            expect(sm.resolveScope(el)).toBe('EDITOR');
        });
    });

    describe('plain/block editor', () => {
        it('switches to EDITOR from a neutral scope', () => {
            expect(sm.resolveScope(nest([{ cls: 'plain-text-editor' }]))).toBe('EDITOR');
            expect(sm.resolveScope(nest([{ cls: 'block-editor' }]))).toBe('EDITOR');
        });

        it.each(['AI_REVIEW', 'MARKDOWN', 'MARKDOWN_TABLE'])('does not steal the %s scope', (scope) => {
            const el = nest([{ cls: 'plain-text-editor' }]);
            sm.setScope(scope);
            expect(sm.resolveScope(el)).toBeNull();
        });
    });

    it('detects the search panel', () => {
        expect(sm.resolveScope(nest([{ id: 'search-panel' }, { tag: 'input' }]))).toBe('SEARCH');
    });

    it('detects the AI review overlay', () => {
        expect(sm.resolveScope(nest([{ cls: 'ai-review-overlay' }, { tag: 'button' }]))).toBe('AI_REVIEW');
    });

    it('detects the structure editor', () => {
        expect(sm.resolveScope(nest([{ cls: 'structure-editor' }, { tag: 'div' }]))).toBe('STRUCTURE_EDIT');
        expect(sm.resolveScope(nest([{ cls: 'node-source-editor' }]))).toBe('STRUCTURE_EDIT');
    });

    it('detects the CodeMirror editor (regression: EDITOR used to be unreachable)', () => {
        expect(sm.resolveScope(nest([{ cls: 'cm-editor-wrapper' }, { cls: 'cm-content' }]))).toBe('EDITOR');
    });

    it('lets an open AI review keep the keyboard', () => {
        sm.setScope('AI_REVIEW');
        expect(sm.resolveScope(nest([{ cls: 'somewhere-else' }]))).toBeNull();
    });

    it('prioritises the table editor over an enclosing md-block', () => {
        const el = nest([{ cls: 'md-block' }, { cls: 'visual-table-editor' }, { tag: 'td' }]);
        expect(sm.resolveScope(el)).toBe('MARKDOWN_TABLE');
    });
});
