import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn(async () => '') }));
// The real module drags in the whole editor tab (LSP, vim, Tauri). The
// comparison only borrows its language and colour choices.
vi.mock('../src/modules/views/CodeMirrorView.js', () => ({
    languageExtensionFor: () => null,
    syntaxExtensionForTheme: () => [],
}));

// jsdom has no layout. CodeMirror measures text ranges; zero boxes are enough.
const emptyRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
Range.prototype.getClientRects ??= () => [];
Range.prototype.getBoundingClientRect ??= emptyRect;

const { MergeEditor, mergeKeyAction } = await import('../src/modules/editors/MergeEditor.js');
const { makeSide } = await import('../src/modules/utils/MergeSides.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
const save = vi.fn(async () => {});

let host;
let editor;

function open(left, right) {
    const file = {
        type: 'diff',
        isDirty: false,
        merge: { title: 'T', path: 'a.txt', nav: null, left: makeSide(left), right: makeSide(right) },
    };
    const onDirtyChange = vi.fn();
    editor = new MergeEditor(host, file, { onDirtyChange, onSave: save });
    return { file, onDirtyChange };
}

const writable = (text) => ({ label: 'R', text, writable: true, target: { kind: 'custom', save } });
const readOnly = (text) => ({ label: 'L', text });
const selected = (view) => {
    const { from, to } = view.state.selection.main;
    return view.state.sliceDoc(from, to);
};

beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
});

afterEach(() => {
    if (editor) editor.destroy();
    editor = null;
    host.remove();
});

describe('mergeKeyAction', () => {
    const key = (k, mods = {}) => ({ key: k, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

    it('moves between word-level changes on Alt+Left / Alt+Right, as before', () => {
        expect(mergeKeyAction(key('ArrowLeft', { altKey: true }))).toBe('prev-inline');
        expect(mergeKeyAction(key('ArrowRight', { altKey: true }))).toBe('next-inline');
    });

    it('copies with Alt+Shift+Left / Alt+Shift+Right', () => {
        expect(mergeKeyAction(key('ArrowLeft', { altKey: true, shiftKey: true }))).toBe('copy-left');
        expect(mergeKeyAction(key('ArrowRight', { altKey: true, shiftKey: true }))).toBe('copy-right');
    });

    it('keeps Alt+Up / Alt+Down, Alt+I and Alt+W', () => {
        expect(mergeKeyAction(key('ArrowUp', { altKey: true }))).toBe('prev-change');
        expect(mergeKeyAction(key('ArrowDown', { altKey: true }))).toBe('next-change');
        expect(mergeKeyAction(key('i', { altKey: true }))).toBe('ignore-whitespace');
        expect(mergeKeyAction(key('W', { altKey: true }))).toBe('show-whitespace');
    });

    it('leaves Ctrl+Up / Ctrl+Down to the editor unless there are files to move between', () => {
        expect(mergeKeyAction(key('ArrowDown', { ctrlKey: true }))).toBeNull();
        expect(mergeKeyAction(key('ArrowDown', { ctrlKey: true }), { hasFileNav: true })).toBe('next-file');
    });

    it('ignores plain arrows', () => {
        expect(mergeKeyAction(key('ArrowLeft'))).toBeNull();
    });
});

describe('MergeEditor', () => {
    it('uses the whole pane: the editor area padding is cleared', async () => {
        open(readOnly('a\n'), writable('b\n'));
        await tick();
        expect(host.style.padding).toBe('0px');
    });

    it('says in each header whether that side can be edited', async () => {
        open(readOnly('a\n'), writable('b\n'));
        await tick();
        expect(host.querySelector('.merge-header-left .merge-badge.is-readonly')).not.toBeNull();
        expect(host.querySelector('.merge-header-right .merge-badge.is-writable')).not.toBeNull();
    });

    it('offers copy buttons only toward the writable side', () => {
        open(readOnly('a\n'), writable('b\n'));
        const buttons = [...editor._renderCopyControl().querySelectorAll('button')];
        expect(buttons.map((b) => b.dataset.toward)).toEqual(['right']);
    });

    it('refuses to copy into a read-only side', async () => {
        const { file } = open(readOnly('one\ntwo\nthree\n'), writable('one\nTWO\nthree\n'));
        await tick();
        expect(editor.copyChunk(0, 'left')).toBe(false);
        expect(editor.mergeView.a.state.doc.toString()).toBe('one\ntwo\nthree\n');
        expect(file.merge.left.text).toBe('one\ntwo\nthree\n');
    });

    it('copies a change into the writable side, marks the tab unsaved, and undo clears it', async () => {
        const { file, onDirtyChange } = open(readOnly('one\ntwo\nthree\n'), writable('one\nTWO\nthree\nfour\n'));
        await tick();
        expect(editor.mergeView.chunks).toHaveLength(2);

        expect(editor.copyChunk(0, 'right')).toBe(true);
        await tick();
        expect(file.merge.right.text).toBe('one\ntwo\nthree\nfour\n');
        expect(file.isDirty).toBe(true);
        expect(onDirtyChange).toHaveBeenCalled();
        expect(editor.mergeView.chunks).toHaveLength(1);

        editor.undo();
        await tick();
        expect(file.merge.right.text).toBe('one\nTWO\nthree\nfour\n');
        expect(file.isDirty).toBe(false);
    });

    it('copies both ways when both sides are writable', async () => {
        const { file } = open(writable('a\nb\n'), writable('a\nB\n'));
        await tick();
        const buttons = [...editor._renderCopyControl().querySelectorAll('button')];
        expect(buttons.map((b) => b.dataset.toward)).toEqual(['left', 'right']);

        expect(editor.copyChunk(0, 'left')).toBe(true);
        await tick();
        expect(file.merge.left.text).toBe('a\nB\n');
        expect(editor.mergeView.chunks).toHaveLength(0);
    });

    it('copies every change at once', async () => {
        const { file } = open(readOnly('1\n2\n3\n4\n'), writable('1\nX\n3\nY\n'));
        await tick();
        expect(editor.copyAll('right')).toBe(true);
        await tick();
        expect(file.merge.right.text).toBe('1\n2\n3\n4\n');
        expect(editor.copyAll('left')).toBe(false);
    });

    it('keeps edits across a switch to the unified view and back', async () => {
        const { file } = open(readOnly('a\nb\n'), writable('a\nB\n'));
        await tick();
        editor.copyChunk(0, 'right');
        await tick();
        editor.toggleViewMode();
        await tick();
        expect(editor.unifiedView).not.toBeNull();
        editor.toggleViewMode();
        await tick();
        expect(editor.mergeView.b.state.doc.toString()).toBe('a\nb\n');
        expect(file.merge.right.text).toBe('a\nb\n');
        expect(file.isDirty).toBe(true);
    });

    it('ignoring whitespace hides indentation-only changes without touching the text', async () => {
        const { file } = open(readOnly('a\n  b\n'), writable('a\nb\n'));
        await tick();
        expect(editor.mergeView.chunks).toHaveLength(1);
        editor.toggleIgnoreWhitespace();
        await tick();
        expect(editor.mergeView.chunks).toHaveLength(0);
        expect(file.merge.left.text).toBe('a\n  b\n');
    });

    it('has no Save button and no copy column when nothing can be written', async () => {
        open(readOnly('a\n'), readOnly('b\n'));
        await tick();
        expect(host.querySelector('.diff-primary-btn')).toBeNull();
        expect(host.classList.contains('merge-no-controls')).toBe(true);
    });

    it('keeps scratch text as it is typed, never as unsaved', async () => {
        const onLive = vi.fn();
        const { file } = open(
            { label: 'L', text: 'a\n', writable: true, live: true, onLive },
            { label: 'R', text: 'b\n', writable: true, live: true },
        );
        await tick();
        editor.copyChunk(0, 'left');
        await tick();
        expect(onLive).toHaveBeenCalledWith('b\n');
        expect(file.isDirty).toBe(false);
    });
});

describe('MergeEditor word-level navigation', () => {
    it('steps through the changed words on both sides, and wraps', async () => {
        open(readOnly('a b c\n'), writable('A b C\n'));
        await tick();

        expect(editor.navigateInline(1)).toBe(true);
        expect(selected(editor.mergeView.a)).toBe('a');
        expect(selected(editor.mergeView.b)).toBe('A');

        editor.navigateInline(1);
        expect(selected(editor.mergeView.a)).toBe('c');
        expect(selected(editor.mergeView.b)).toBe('C');

        editor.navigateInline(1);
        expect(selected(editor.mergeView.b)).toBe('A');

        editor.navigateInline(-1);
        expect(selected(editor.mergeView.b)).toBe('C');
    });

    it('crosses from one change to the next', async () => {
        open(readOnly('x\nkeep\ny\n'), writable('X\nkeep\nY\n'));
        await tick();
        editor.navigateInline(1);
        expect(selected(editor.mergeView.b)).toBe('X');
        editor.navigateInline(1);
        expect(selected(editor.mergeView.b)).toBe('Y');
    });

    it('does nothing when there is nothing to move to', async () => {
        open(readOnly('same\n'), writable('same\n'));
        await tick();
        expect(editor.navigateInline(1)).toBe(false);
    });
});

describe('MergeEditor current change', () => {
    const outlined = (view) => view.dom.querySelectorAll('.cm-merge-focus').length;

    it('outlines the change under the cursor on both sides', async () => {
        open(readOnly('one\ntwo\nthree\n'), writable('one\nTWO\nthree\n'));
        await tick();
        expect(outlined(editor.mergeView.a)).toBe(0);

        editor.navigate(1);
        await tick();
        expect(outlined(editor.mergeView.a)).toBe(1);
        expect(outlined(editor.mergeView.b)).toBe(1);
        expect(editor.mergeView.b.dom.querySelector('.cm-merge-focus-top.cm-merge-focus-bottom')).not.toBeNull();
    });

    it('marks the word being looked at', async () => {
        open(readOnly('a b c\n'), writable('A b C\n'));
        await tick();
        editor.navigateInline(1);
        await tick();
        expect(editor.mergeView.a.dom.querySelector('.cm-merge-inline-focus').textContent).toBe('a');
        expect(editor.mergeView.b.dom.querySelector('.cm-merge-inline-focus').textContent).toBe('A');
    });

    it('outlines the change whose copy band the pointer is over', async () => {
        open(readOnly('1\n2\n3\n4\n5\n'), writable('1\nX\n3\n4\nY\n'));
        await tick();
        editor._setHoverChunk(1);
        expect(editor._focusIndex).toBe(1);
        expect(outlined(editor.mergeView.b)).toBe(1);
        editor._setHoverChunk(null);
        expect(outlined(editor.mergeView.b)).toBe(0);
    });

    it('copies the change at the cursor with the keyboard action', async () => {
        const { file } = open(readOnly('one\ntwo\n'), writable('one\nTWO\n'));
        await tick();
        editor.navigate(1);
        await tick();
        expect(editor.runKeyAction('copy-left')).toBe(false); // left is read-only
        expect(editor.runKeyAction('copy-right')).toBe(true);
        await tick();
        expect(file.merge.right.text).toBe('one\ntwo\n');
    });
});
