import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn(), watch: vi.fn(async () => () => {}) }));

const { handleStillInUse } = await import('../src/modules/core/Panes.js');
const { State } = await import('../src/modules/core/Store.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

const editor = read('src/modules/core/Editor.js');
const cm = read('src/modules/views/CodeMirrorView.js');

/* Splitting duplicates the current file — what VS Code and JetBrains both do —
   but it seeded the new pane with a shallow COPY of the buffer. From the first
   keystroke there were two texts for one path, `file.content` was whichever
   pane wrote last, and saving picked one of them arbitrarily. */

describe('a split shares the buffer', () => {
    it('puts the same object in both panes', () => {
        const i = editor.indexOf('if (seed && State.rightOpenFiles.length === 0');
        const block = editor.slice(i, editor.indexOf('State.activePane', i));
        expect(block).toContain('State.rightOpenFiles.push(State.openFiles[State.activeTabIndex]);');
        // The comment above it quotes the old clone, so match the CODE.
        expect(block).not.toContain('const cloned =');
    });

    // One object in two lists must be saved once, not twice — and the old
    // path-based dedup silently dropped whichever copy came second.
    it('is saved once, deduped by identity', () => {
        const i = editor.indexOf('const seen = new Set();');
        const block = editor.slice(i, editor.indexOf('\n        }', i));
        expect(block).toContain('if (seen.has(file)) continue;');
        expect(block).toContain('seen.add(file);');
        expect(block).not.toContain('seen.has(file.path)');

        const app = read('src/modules/core/App.js');
        expect(app).toContain('[...new Set([...(State.openFiles || []), ...(State.rightOpenFiles || [])])]');
    });
});

/* `handleStillInUse` excluded one file by object identity — "everyone except
   the tab I am closing". Once the object is shared, the other pane's entry IS
   that object, so it was excluded too and the mmap handle was freed underneath
   a pane still reading from it. */
describe('backend handles survive closing one pane', () => {
    beforeEach(() => { State.openFiles = []; State.rightOpenFiles = []; });

    it('sees the other pane still holding the id', () => {
        State.rightOpenFiles = [{ path: '/ws/huge.log', largeId: 7 }];
        expect(handleStillInUse('largeId', 7)).toBe(true);
    });

    it('frees it once nobody holds it', () => {
        expect(handleStillInUse('largeId', 7)).toBe(false);
    });

    it('takes no exclude argument any more', () => {
        expect(read('src/modules/core/Panes.js'))
            .toContain('export function handleStillInUse(key, id) {');
        // The release must run AFTER the tab is removed, or the lists lie.
        const i = editor.indexOf('function releaseFileHandles(file)');
        expect(editor.slice(i, i + 500)).toContain("handleStillInUse('largeId', file.largeId)");
    });
});

/* Sharing the object is not enough on its own: each pane has its own
   CodeMirror document. The idle pane kept the text it was rendered with, and
   typing in it later wrote that stale document back over the other pane's
   work — the same divergence, one level down. */
describe('the two views stay the same document', () => {
    const mirror = () => {
        const i = editor.indexOf('function mirrorToSibling(');
        return editor.slice(i, editor.indexOf('\n}', i));
    };
    const applyRemote = () => {
        const i = cm.indexOf('applyRemoteChanges(changes) {');
        return cm.slice(i, cm.indexOf('\n    _mapLspCompletionKind', i));
    };

    it('sends the changes to the sibling, not the whole text', () => {
        const fn = mirror();
        expect(fn).toContain('if (!State.splitMode) return;');
        // Only a view on the same buffer OBJECT: two tabs opened separately on
        // one path are separate buffers, and always were.
        expect(fn).toContain('if (sibling.file !== file) return;');
        expect(fn).toContain('sibling.applyRemoteChanges(changes)');
    });

    it('applies them without disturbing the other pane', () => {
        const fn = applyRemote();
        expect(fn).toContain('scrollIntoView: false');
        // Replacing the document would reset the sibling's cursor, scroll and
        // undo history on every keystroke typed next door.
        expect(fn).toContain('this.editorView.dispatch({');
        expect(fn).toContain('changes,');
    });

    // The dispatch fires the sibling's own listener, which would mirror it back.
    it('does not echo', () => {
        expect(cm).toContain('if (!this.editorView || this._applyingRemote) return;');
        expect(cm).toContain('if (this.options.onDocChanged && !this._applyingRemote)');
    });

    it('falls back to the buffer text if the two ever drift', () => {
        const fn = applyRemote();
        expect(fn).toContain('from: 0, to: doc.length');
        expect(fn).toContain('this.file ? this.file.content');
    });
});

/* Cursor, scroll and undo history are per VIEW, not per buffer. They were
   single slots on the file object, so with one buffer in two panes each pane
   overwrote the other's — leaving one restored the other's viewport. */
describe('view state is kept per pane', () => {
    it('is keyed by the pane the view belongs to', () => {
        expect(cm).toContain('readViewState(this.file, this.options.pane)');
        expect(cm).toContain('readViewScroll(this.file, this.options.pane)');
        expect(cm).toContain('writeViewState(this._stateOwnerFile, this.options.pane, {');
        expect(editor).toMatch(/new CodeMirrorView\(container, \{\s*\n\s*pane,/);
    });

    it('still restores a session saved by the old single-slot build', () => {
        const i = cm.indexOf('function readViewState(file, pane)');
        expect(cm.slice(i, cm.indexOf('\n}', i))).toContain('file._cmStateJSON');
    });

    // ...and drops that legacy slot once a real one exists, so a stale copy
    // cannot come back and overrule the per-pane state.
    it('clears the legacy slot on the first real write', () => {
        const i = cm.indexOf('function writeViewState(file, pane, value)');
        const fn = cm.slice(i, cm.indexOf('\n}', i));
        expect(fn).toContain('file._cmStateJSON = null');
        expect(fn).toContain('file._cmScrollTop = 0');
    });
});
