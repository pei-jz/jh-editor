import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/modules/views/CodeMirrorView.js', () => ({
    languageExtensionFor: () => null,
    syntaxExtensionForTheme: () => [],
}));

const emptyRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
Range.prototype.getClientRects ??= () => [];
Range.prototype.getBoundingClientRect ??= emptyRect;

const { ConflictEditor } = await import('../src/modules/editors/ConflictEditor.js');
const { makeSide, mergeDirty } = await import('../src/modules/utils/MergeSides.js');
const { parseMerged, assemble } = await import('../src/modules/utils/ConflictRegions.js');

const M = (ch, label = '') => ch.repeat(32) + (label ? ` ${label}` : '') + '\n';
const conflict = (o, b, t) => M('<', 'ours') + o + M('|', 'base') + b + M('=') + t + M('>', 'theirs');

// Two conflicts; theirs also changed line "c" cleanly.
const base = 'a\nb\nc\nd\n';
const ours = 'a\nB1\nc\nD1\n';
const theirs = 'a\nB2\nC2\nD2\n';
const merged = 'a\n' + conflict('B1\n', 'b\n', 'B2\n') + 'C2\n' + conflict('D1\n', 'd\n', 'D2\n');
const onDisk = '<<<<<<< HEAD\n...markers...\n';

let host;
let editor;

function open() {
    const regions = parseMerged(merged);
    const { text, ranges } = assemble(regions, (c) => c.base);
    const merge = {
        title: 'Merge', path: 'f.txt', nav: null,
        left: makeSide({ label: 'main', text: ours }),
        right: makeSide({ label: 'f.txt', text, writable: true, target: { kind: 'custom', save: async () => {} } }),
    };
    merge.right.savedText = onDisk;
    const file = {
        type: 'diff', isDirty: true, merge,
        conflict: {
            repo: 'C:/r', path: 'f.txt', labels: { current: 'main', incoming: 'feature-x' },
            regions, base, ours, theirs, spans: ranges.map((r) => ({ ...r, state: 'open' })), current: 0,
        },
    };
    const onDirtyChange = vi.fn();
    editor = new ConflictEditor(host, file, { onDirtyChange, onSave: vi.fn(async () => true) });
    return file;
}

const states = () => editor._state().spans.map((s) => s.state);
const result = () => editor.resultView.state.doc.toString();

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
});

afterEach(() => {
    if (editor) editor.destroy();
    editor = null;
    host.remove();
});

describe('ConflictEditor', () => {
    it('starts from git\'s merge with each conflict holding the ancestor\'s text', () => {
        const file = open();
        expect(result()).toBe('a\nb\nC2\nd\n');
        expect(states()).toEqual(['open', 'open']);
        // Not on disk yet: the file still has git's markers in it.
        expect(mergeDirty(file.merge)).toBe(true);
        expect(host.querySelector('.conflict-status').textContent).toContain('2 of 2');
        expect(host.querySelectorAll('.cm-line.cm-conflict.is-open').length).toBeGreaterThan(0);
    });

    it('takes a side and moves on to the next open conflict', () => {
        const file = open();
        editor.resolve(0, 'ours');
        expect(result()).toBe('a\nB1\nC2\nd\n');
        expect(states()).toEqual(['ours', 'open']);
        expect(editor._state().current).toBe(1);
        editor.resolveCurrent('theirs');
        expect(result()).toBe('a\nB1\nC2\nD2\n');
        expect(states()).toEqual(['ours', 'theirs']);
        // The tab keeps the text, so a redraw or a save sees it.
        expect(file.merge.right.text).toBe('a\nB1\nC2\nD2\n');
        expect(host.querySelector('.conflict-status').classList.contains('is-done')).toBe(true);
    });

    it('keeps both versions in either order', () => {
        open();
        editor.resolve(0, 'theirs-ours');
        expect(result()).toBe('a\nB2\nB1\nC2\nd\n');
        // The second conflict moved down with the extra line and is still found.
        editor.resolve(1, 'ours-theirs');
        expect(result()).toBe('a\nB2\nB1\nC2\nD1\nD2\n');
    });

    it('undo puts a decision back to open', () => {
        open();
        editor.resolve(0, 'ours');
        editor.undo();
        expect(result()).toBe('a\nb\nC2\nd\n');
        expect(states()).toEqual(['open', 'open']);
        editor.redo();
        expect(states()).toEqual(['ours', 'open']);
    });

    it('counts an edit inside a conflict as deciding it by hand', () => {
        open();
        const span = editor._state().spans[1];
        editor.resultView.dispatch({ changes: { from: span.from, to: span.to - 1, insert: 'mine' }, userEvent: 'input.type' });
        expect(states()).toEqual(['open', 'manual']);
        expect(result()).toBe('a\nb\nC2\nmine\n');
    });

    it('Alt+→ takes the incoming version of the current conflict', () => {
        open();
        editor.resultView.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
        expect(result()).toBe('a\nB2\nC2\nd\n');
    });

    it('marks each side\'s conflicts and offers to take them from the gutter', () => {
        open();
        expect(host.querySelectorAll('.cm-conflict-ours .cm-conflict-take').length).toBe(2);
        expect(host.querySelectorAll('.cm-conflict-theirs .cm-conflict-take').length).toBe(2);
    });
});
