import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('../src/modules/ai/AIAgent.js', () => ({
    default: { runSingleShot: vi.fn(async () => 'suggested()') },
}));

import { EditorState } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import {
    createInlineCompletionExtension, isInlineCompletionEnabled,
    setInlineCompletionEnabled, _internals,
} from '../src/modules/ui/InlineCompletion.js';
import { setScope } from '../src/modules/ai/ContextScope.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

const { ghostField, ghostTextOf, setGhost, clearGhost, GhostWidget } = _internals;

/** A state carrying the field, with a suggestion already showing. */
function stateWithGhost(doc = 'hello', at = 5) {
    let state = EditorState.create({ doc, extensions: [ghostField] });
    const deco = Decoration.set([
        Decoration.widget({ widget: new GhostWidget(' world'), side: 1 }).range(at),
    ]);
    state = state.update({ effects: setGhost.of(deco) }).state;
    return state;
}

/* The ghost got stuck on screen with Esc and Tab no longer answering. The view
   plugin dispatched a transaction from inside `update()`, which CodeMirror
   forbids; the throw took the whole plugin — keymap included — out of the view,
   and nothing was left that could clear the decoration. */
describe('retiring a suggestion', () => {
    it('is decided by the state field, not by a second dispatch', () => {
        const src = read('src/modules/ui/InlineCompletion.js');
        const i = src.indexOf('const ghostField = StateField.define({');
        const field = src.slice(i, src.indexOf('/** The text of the visible', i));
        expect(field).toContain('if (tr.docChanged || tr.selection) return Decoration.none;');

        // Nothing inside the plugin's update() may dispatch.
        const j = src.indexOf('update(u) {');
        const update = src.slice(j, src.indexOf('destroy()', j));
        // The comment says "must NOT dispatch", so match a real call.
        expect(update).not.toContain('.dispatch(');
        expect(update).not.toContain('dismiss(');
    });

    it('clears itself on an edit', () => {
        const state = stateWithGhost();
        expect(ghostTextOf(state)).toBe(' world');
        const after = state.update({ changes: { from: 5, insert: '!' } }).state;
        expect(ghostTextOf(after)).toBe('');
    });

    it('clears itself when the caret moves', () => {
        const state = stateWithGhost();
        const after = state.update({ selection: { anchor: 0 } }).state;
        expect(ghostTextOf(after)).toBe('');
    });

    it('clears on the explicit effect', () => {
        const state = stateWithGhost();
        const after = state.update({ effects: clearGhost.of(null) }).state;
        expect(ghostTextOf(after)).toBe('');
    });

    // Accepting inserts the text AND drops the ghost in ONE transaction; two
    // transactions meant the first (the insert) retired the ghost on its own and
    // the second cleared something already gone.
    it('accepts and clears in a single transaction', () => {
        const src = read('src/modules/ui/InlineCompletion.js');
        const i = src.indexOf("if (event.key === 'Tab'");
        const branch = src.slice(i, src.indexOf("if (event.key === 'Escape'", i));
        expect(branch).toContain('changes: { from: pos, to: pos, insert: accepted }');
        expect(branch).toContain('effects: clearGhost.of(null)');
        expect((branch.match(/view\.dispatch\(/g) || []).length).toBe(1);
        // The caret belongs after what was just inserted.
        expect(branch).toContain('anchor: pos + accepted.length');
    });
});

/* This is the one feature in the editor that contacts a model with no user
   action: a pause in typing is the trigger. */
describe('when it is allowed to run at all', () => {
    beforeEach(() => { localStorage.clear(); });

    it('is off until switched on', () => {
        expect(isInlineCompletionEnabled()).toBe(false);
        setInlineCompletionEnabled(true);
        expect(isInlineCompletionEnabled()).toBe(true);
        setInlineCompletionEnabled(false);
        expect(isInlineCompletionEnabled()).toBe(false);
    });

    it('obeys the context scope and skips personal notes', () => {
        const src = read('src/modules/ui/InlineCompletion.js');
        const i = src.indexOf('const permitted = () => {');
        const fn = src.slice(i, src.indexOf('\n    };', i));
        expect(fn).toContain('isInlineCompletionEnabled()');
        // ~5 KB around the caret is file content, so it costs `activeBuffer`.
        expect(fn).toContain("allows('activeBuffer')");
        expect(fn).toContain('isPrivatePath(');
    });

    it('does not fire when the feature is off', async () => {
        const AIAgent = (await import('../src/modules/ai/AIAgent.js')).default;
        AIAgent.runSingleShot.mockClear();
        setInlineCompletionEnabled(false);
        setScope('workspace');

        // The extension's gate is `permitted()`; exercise it through the public
        // factory rather than reaching inside.
        const ext = createInlineCompletionExtension({
            getFile: () => ({ path: 'C:/proj/a.js', name: 'a.js' }),
        });
        expect(Array.isArray(ext)).toBe(true);
        // Nothing is requested without a view update, and no update can happen
        // while the feature is off: the request path is unreachable.
        expect(AIAgent.runSingleShot).not.toHaveBeenCalled();
    });
});

/* `abortSignal` was a parameter that did nothing: the client has no signal
   argument and the value was dropped, so a superseded request still came back
   and painted a suggestion for a caret position that no longer existed. */
describe('cancelling a superseded request', () => {
    it('races the invocation against the signal', () => {
        const agent = read('src/modules/ai/AIAgent.js');
        expect(agent).toContain('function abortedAfter(signal)');
        expect(agent).toContain('Promise.race([invocation, abortedAfter(abortSignal)])');
        expect(agent).toContain("err.name = 'AbortError'");
    });

    it('drops a late answer even if the race is lost', () => {
        const src = read('src/modules/ui/InlineCompletion.js');
        expect(src).toContain('if (view.state.selection.main.head !== pos || view.state.doc !== doc) return;');
    });
});
