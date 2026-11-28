import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn(async () => '') }));
vi.mock('../src/modules/views/CodeMirrorView.js', () => ({
    languageExtensionFor: () => null,
    syntaxExtensionForTheme: () => [],
}));

const emptyRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
Range.prototype.getClientRects ??= () => [];
Range.prototype.getBoundingClientRect ??= emptyRect;

const { MergeEditor } = await import('../src/modules/editors/MergeEditor.js');
const { makeSide } = await import('../src/modules/utils/MergeSides.js');
const { State } = await import('../src/modules/core/Store.js');

const save = vi.fn(async () => {});
let host;
let editor;

function open(left, right) {
    const file = {
        type: 'diff',
        isDirty: false,
        merge: { title: 'T', path: 'a.txt', nav: null, left: makeSide(left), right: makeSide(right) },
    };
    editor = new MergeEditor(host, file, { onSave: save });
    return file;
}

const writable = (text) => ({ label: 'R', text, writable: true, target: { kind: 'custom', save } });
const readOnly = (text) => ({ label: 'L', text });

beforeEach(() => {
    localStorage.clear();
    State.searchMatches = [];
    host = document.createElement('div');
    document.body.appendChild(host);
});

afterEach(() => {
    if (editor) editor.destroy();
    editor = null;
    host.remove();
});

describe('Find in a comparison', () => {
    it('speaks the search protocol the search panel looks for', () => {
        open(readOnly('a\n'), writable('b\n'));
        expect(editor.isCodeMirrorMode()).toBe(true);
    });

    it('searches only the side the cursor was last on', async () => {
        open(readOnly('apple pie\napple\n'), writable('apple\n'));
        editor._lastFocused = editor.mergeView.a;
        await editor.performSearch('apple', false, false, false);
        expect(State.searchMatches.map((m) => m.start)).toEqual([0, 10]);
        expect(editor.editorView).toBe(editor.mergeView.a);
        expect(host.querySelector('.merge-header-left.is-search-target')).not.toBeNull();
        expect(host.querySelector('.merge-header-right.is-search-target')).toBeNull();

        editor._lastFocused = editor.mergeView.b;
        await editor.performSearch('apple', false, false, false);
        expect(State.searchMatches.map((m) => m.start)).toEqual([0]);
        expect(editor.editorView).toBe(editor.mergeView.b);
        expect(host.querySelector('.merge-header-right.is-search-target')).not.toBeNull();
        expect(host.querySelector('.merge-header-left.is-search-target')).toBeNull();
    });

    it('selects the hit it moves to, on the searched side', async () => {
        open(readOnly('x\n'), writable('one two two\n'));
        editor._lastFocused = editor.mergeView.b;
        await editor.performSearch('two', false, false, false);
        editor.scrollToMatch(1);
        const { from, to } = editor.mergeView.b.state.selection.main;
        expect([from, to]).toEqual([8, 11]);
    });

    it('replaces on a writable side and refuses on a read-only one', async () => {
        const file = open(readOnly('cat\n'), writable('cat cat\n'));
        editor._lastFocused = editor.mergeView.b;
        await editor.performSearch('cat', false, false, false);
        expect(editor.replaceNext('cat', 'dog', false, false, false, State.searchMatches[0])).toBe(0);
        expect(file.merge.right.text).toBe('dog cat\n');

        editor._lastFocused = editor.mergeView.a;
        await editor.performSearch('cat', false, false, false);
        expect(editor.replaceNext('cat', 'dog', false, false, false, State.searchMatches[0])).toBe(-1);
        expect(await editor.replaceAll('cat', 'dog', false, false, false)).toBe(0);
        expect(file.merge.left.text).toBe('cat\n');
    });

    it('clearing the search ends it on that side', async () => {
        open(readOnly('a b a\n'), writable('a\n'));
        editor._lastFocused = editor.mergeView.a;
        await editor.performSearch('a', false, false, false);
        editor.renderSearchHighlights([], 0);
        expect(host.querySelector('.is-search-target')).toBeNull();
    });
});
