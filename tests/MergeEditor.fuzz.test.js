import { describe, it, expect, vi, afterEach } from 'vitest';

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
const { rng, randomPair, checkChunks, copyAll, LINE_POOL } = await import('./helpers/diffInvariants.js');

/*
   The comparison as the user drives it: random typing on both sides, copies,
   keep-both, undo / redo, sync points and the whitespace toggle. After every
   step, what is on screen must agree with the texts: the chunks satisfy every
   invariant for the documents the panes hold, and the tab holds exactly what
   the panes show — that text is what Save writes.
*/

const tick = () => new Promise((r) => setTimeout(r, 0));
let host;
let editor;

afterEach(() => {
    if (editor) editor.destroy();
    editor = null;
    if (host) host.remove();
    localStorage.clear();
});

function open(left, right) {
    host = document.createElement('div');
    document.body.appendChild(host);
    const save = vi.fn(async () => {});
    const file = {
        type: 'diff',
        isDirty: false,
        merge: {
            title: 'T', path: 'a.txt', nav: null,
            left: makeSide({ label: 'L', text: left, writable: true, target: { kind: 'custom', save } }),
            right: makeSide({ label: 'R', text: right, writable: true, target: { kind: 'custom', save } }),
        },
    };
    editor = new MergeEditor(host, file, { onDirtyChange: () => {}, onSave: save });
    return file;
}

function check(file, label) {
    const mv = editor.mergeView;
    const a = mv.a.state.doc.toString();
    const b = mv.b.state.doc.toString();
    expect(file.merge.left.text, `${label}: left text`).toBe(a);
    expect(file.merge.right.text, `${label}: right text`).toBe(b);
    try {
        checkChunks(a, b, mv.chunks, { ignoreWhitespace: editor.ignoreWhitespace, anchored: file.merge.anchors.length > 0 });
    } catch (e) {
        e.message = `${label}: ${e.message}`;
        throw e;
    }
    for (const p of file.merge.anchors) {
        for (const [pos, doc] of [[p.a, mv.a.state.doc], [p.b, mv.b.state.doc]]) {
            expect(pos >= 0 && pos <= doc.length, `${label}: sync point inside the text`).toBe(true);
            expect(doc.lineAt(pos).from, `${label}: sync point at a line start`).toBe(pos);
        }
    }
}

function randomEdit(r, view) {
    const doc = view.state.doc;
    const from = r.int(doc.length + 1);
    const to = Math.min(doc.length, from + r.int(6));
    const insert = r.pick(['', 'x', '\n', ' ', `${r.pick(LINE_POOL)}\n`, '\n\n', '😀']);
    view.dispatch({ changes: { from, to, insert }, userEvent: 'input.type' });
}

const { lineCounterpart } = await import('../src/modules/editors/MergeEditor.js');
const { computeDiff } = await import('../src/modules/utils/LineDiff.js');
const { Text } = await import('@codemirror/state');
const { Chunk, Change } = await import('@codemirror/merge');

describe('lineCounterpart fuzz', () => {
    it('agrees with the chunks for every line of random comparisons, both ways', () => {
        for (let seed = 1; seed <= 1500; seed++) {
            const r = rng(seed + 1200000);
            const [a, b] = randomPair(r);
            const ignoreWhitespace = r() < 0.3;
            const docA = Text.of(a.split('\n'));
            const docB = Text.of(b.split('\n'));
            const chunks = computeDiff(a, b, { ignoreWhitespace });
            for (const [side, doc] of [['a', docA], ['b', docB]]) {
                for (let n = 1; n <= doc.lines; n++) {
                    const at = lineCounterpart(chunks, docA, docB, side, n);
                    const label = `seed ${seed} side ${side} line ${n}`;
                    expect(at[side], label).toBe(n);
                    const other = side === 'a' ? 'b' : 'a';
                    if (at.chunk < 0) {
                        // Unchanged: the partner exists and holds the same text.
                        expect(at[other], label).not.toBeNull();
                        expect(docA.line(at.a).text, label).toBe(docB.line(at.b).text);
                    }
                    if (at[other] != null) {
                        // And the partner's partner is this line.
                        const back = lineCounterpart(chunks, docA, docB, other, at[other]);
                        expect(back[side], label).toBe(n);
                        expect(back.chunk, label).toBe(at.chunk);
                    }
                }
            }
        }
    });

    it('counts the empty line after a final line break as part of a chunk that runs to the end', () => {
        // The chunk ends one past the document; "to - 1" used to stop a line short.
        const chunks = computeDiff('x', 'x\n');
        const at = lineCounterpart(chunks, Text.of(['x']), Text.of(['x', '']), 'b', 2);
        expect(at).toEqual({ a: null, b: 2, chunk: 0 });
    });

    it('pairs by position inside the package’s own chunks (very large files)', () => {
        const docA = Text.of(['x', 'p', 'q', 'y']);
        const docB = Text.of(['x', 'P', 'y']);
        const chunk = new Chunk([new Change(0, 3, 0, 1)], 2, 6, 2, 4);
        expect(lineCounterpart([chunk], docA, docB, 'a', 2)).toEqual({ a: 2, b: 2, chunk: 0 });
        expect(lineCounterpart([chunk], docA, docB, 'a', 3)).toEqual({ a: 3, b: null, chunk: 0 });
        expect(lineCounterpart([chunk], docA, docB, 'a', 4)).toEqual({ a: 4, b: 3, chunk: -1 });
    });
});

describe('MergeEditor fuzz', () => {
    it('keeps the screen and the texts consistent through random sessions', async () => {
        for (let seed = 1; seed <= 60; seed++) {
            const r = rng(seed + 900000);
            const [left, right] = randomPair(r);
            const file = open(left, right);
            await tick();
            check(file, `seed ${seed} start`);
            for (let step = 0; step < 25; step++) {
                const mv = editor.mergeView;
                const label = `seed ${seed} step ${step}`;
                const n = mv.chunks.length;
                switch (r.int(9)) {
                    case 0: case 1: randomEdit(r, r() < 0.5 ? mv.a : mv.b); break;
                    case 2: if (n) editor.copyChunk(r.int(n), r() < 0.5 ? 'left' : 'right'); break;
                    case 3: if (n) editor.combineChunk(r.int(n), r() < 0.5 ? 'left' : 'right', r() < 0.5 ? 'left-first' : 'right-first'); break;
                    case 4: editor.undo(); break;
                    case 5: editor.redo(); break;
                    case 6: {
                        const pick = (v) => v.state.doc.line(1 + r.int(v.state.doc.lines)).from;
                        mv.a.dispatch({ selection: { anchor: pick(mv.a) } });
                        mv.b.dispatch({ selection: { anchor: pick(mv.b) } });
                        editor.toggleSyncPoint();
                        break;
                    }
                    case 7: if (r() < 0.3) editor.toggleIgnoreWhitespace(); else editor.navigateInline(r() < 0.5 ? 1 : -1); break;
                    default: editor.navigate(r() < 0.5 ? 1 : -1); break;
                }
                await tick();
                check(file, label);
            }
            // Whatever happened, "copy all" still lands exactly on the other side.
            if (!editor.ignoreWhitespace && !file.merge.anchors.length) {
                const a = editor.mergeView.a.state.doc.toString();
                const b = editor.mergeView.b.state.doc.toString();
                expect(copyAll(a, b, editor.mergeView.chunks, 'right'), `seed ${seed} copy all`).toBe(a);
                editor.copyAll('right');
                await tick();
                expect(file.merge.right.text, `seed ${seed} copy all in the editor`).toBe(a);
                expect(editor.mergeView.chunks, `seed ${seed} nothing left`).toHaveLength(0);
            }
            editor.destroy();
            editor = null;
            host.remove();
            host = null;
        }
    }, 120000);

    it('undo after a copy, keep-both or sync point brings the exact text back', async () => {
        for (let seed = 1; seed <= 40; seed++) {
            const r = rng(seed + 950000);
            const [left, right] = randomPair(r);
            const file = open(left, right);
            await tick();
            const n = editor.mergeView.chunks.length;
            if (n) {
                const k = r.int(n);
                if (r() < 0.5) editor.copyChunk(k, 'right'); else editor.combineChunk(k, 'right', 'left-first');
                await tick();
                editor.toggleSyncPoint();
                await tick();
                editor.mergeView.b.focus();
                editor.undo();
                await tick();
                expect(file.merge.right.text, `seed ${seed}`).toBe(right);
                expect(file.merge.left.text, `seed ${seed}`).toBe(left);
                check(file, `seed ${seed} after undo`);
            }
            editor.destroy();
            editor = null;
            host.remove();
            host = null;
        }
    }, 60000);
});
