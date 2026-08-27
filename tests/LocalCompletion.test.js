import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    lineCompletion, wordCompletion, wordPrefixAt, localSuggestion, _limits,
} from '../src/modules/ui/LocalCompletion.js';
import { EditorState } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import {
    isLocalSuggestEnabled, setLocalSuggestEnabled, _internals,
} from '../src/modules/ui/InlineCompletion.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8');

/** Build the context object the engine takes, from a doc and a caret marker. */
function at(doc, marker = '|') {
    const offset = doc.indexOf(marker);
    const text = doc.replace(marker, '');
    const before = text.slice(0, offset);
    const lineIndex = before.split('\n').length - 1;
    const lineStart = before.lastIndexOf('\n') + 1;
    const lines = text.split('\n');
    return {
        text,
        lineText: lines[lineIndex],
        lineIndex,
        column: offset - lineStart,
        offset,
    };
}

/* This is what carries repetitive files. The screenshot that started it was a
   run of CSS custom properties where the line above was the obvious template. */
describe('completing a line from the file', () => {
    it('continues from a matching line above', () => {
        const lines = [
            '    --code-color: #d63384;',
            '    --code-bg-color: #f8f9fa;',
            '    --code-b',
        ];
        expect(lineCompletion(lines, 2, '    --code-b')).toBe('g-color: #f8f9fa;');
    });

    // In a run of similar lines the one just above is the template; one three
    // hundred lines away is a coincidence.
    it('prefers the nearest match', () => {
        const lines = [
            'const far = 1;',
            ...Array(20).fill('filler'),
            'const near = 2;',
            'const ',
        ];
        expect(lineCompletion(lines, lines.length - 1, 'const ')).toBe('near = 2;');
    });

    it('will not fire on a prefix too short to mean anything', () => {
        const lines = ['abcdef', 'ab'];
        expect(lineCompletion(lines, 1, 'ab')).toBe('');
        expect(_limits.MIN_LINE_PREFIX).toBeGreaterThanOrEqual(3);
    });

    it('ignores a candidate that only adds whitespace', () => {
        const lines = ['  value   ', '  value'];
        expect(lineCompletion(lines, 1, '  value')).toBe('');
    });

    it('refuses a suggestion long enough to be a paste', () => {
        const lines = [`x${'y'.repeat(400)}`, 'x'.repeat(4)];
        expect(lineCompletion(lines, 1, 'xxxx')).toBe('');
    });
});

describe('completing a word from the file', () => {
    it('finishes an identifier used elsewhere', () => {
        const text = 'renderSessionList();\nrenderS';
        expect(wordCompletion(text, 'renderS', text.length)).toBe('essionList');
    });

    it('reads a CSS custom property as one word', () => {
        expect(wordPrefixAt('  --code-bg', 11)).toBe('--code-bg');
        expect(wordPrefixAt('a $var', 6)).toBe('$var');
    });

    // Three characters meant `im` offered nothing in a file full of `import`,
    // which reads as the feature being broken rather than being careful.
    it('starts guessing at two characters', () => {
        const text = "import { a } from 'b';\nim";
        expect(wordCompletion(text, 'im', text.length)).toBe('port');
        expect(_limits.MIN_WORD_PREFIX).toBe(2);
    });

    it('still says nothing about a single character', () => {
        expect(wordCompletion('abcdefgh', 'a', 8)).toBe('');
    });

    // A name used repeatedly nearby beats one used once at the far end.
    it('weighs frequency against distance', () => {
        const text = `${'zzz '.repeat(200)}counterValue counterValue counterValue count`;
        expect(wordCompletion(text, 'count', text.length)).toBe('erValue');
    });

    it('has nothing to say about a word that appears only once', () => {
        expect(wordCompletion('uniqueWord', 'uniqueW', 7)).toBe('');
    });
});

describe('choosing a suggestion', () => {
    it('prefers a whole line to a single word', () => {
        const ctx = at('const total = sum(a, b);\nconst tot|');
        expect(localSuggestion(ctx)).toEqual({ text: 'al = sum(a, b);', source: 'line' });
    });

    it('falls back to the word when no line matches', () => {
        const ctx = at('sessionStrip = 1;\nfoo(sessionS|');
        expect(localSuggestion(ctx)).toEqual({ text: 'trip', source: 'word' });
    });

    // The completion would be inserted in front of characters already there.
    it('says nothing in the middle of a word', () => {
        expect(localSuggestion(at('valueOf\nval|ue'))).toBeNull();
    });

    it('says nothing on an empty line', () => {
        expect(localSuggestion(at('something\n   |'))).toBeNull();
    });
});

/* The suggestions used to come from a single-shot agent task: a POST, a
   WebSocket and a provider round trip. Seconds, where an inline completion has
   a fraction of a second to be worth reading — so answers arrived after the
   caret had moved and were discarded, having already cost a task that cannot be
   recalled. A toggle for that mostly advertises something that does not work. */
describe('there is no model behind this any more', () => {
    beforeEach(() => { localStorage.clear(); });

    const src = read('src/modules/ui/InlineCompletion.js');

    it('is on by default, because it costs nothing', () => {
        expect(isLocalSuggestEnabled()).toBe(true);
        setLocalSuggestEnabled(false);
        expect(isLocalSuggestEnabled()).toBe(false);
        setLocalSuggestEnabled(true);
        expect(isLocalSuggestEnabled()).toBe(true);
    });

    it('does not reach the agent at all', () => {
        expect(src).not.toContain('AIAgent');
        expect(src).not.toContain('runSingleShot');
        expect(src).not.toContain('AbortController');
        expect(src).not.toContain('ContextScope');
    });

    it('leaves no switch for it in Settings', () => {
        const settings = read('src/modules/ui/SettingsModal.js');
        expect(settings).not.toContain('ai-inline-completion');
        expect(settings).not.toContain('isInlineCompletionEnabled');
        // ...and says where AI help actually lives.
        expect(settings).toContain('Inline AI');
    });

    it('answers within a frame or two of the keystroke', () => {
        expect(_internals.LOCAL_DELAY_MS).toBeLessThanOrEqual(200);
    });

    it('retires a stale suggestion in the state field, never by dispatching', () => {
        const i = src.indexOf('const ghostField = StateField.define({');
        const field = src.slice(i, src.indexOf('/** The text of the visible', i));
        expect(field).toContain('if (tr.docChanged || tr.selection) return Decoration.none;');

        const j = src.indexOf('update(u) {');
        const update = src.slice(j, src.indexOf('destroy()', j));
        expect(update).not.toContain('.dispatch(');
    });

    // Tab was handled in a ViewPlugin's eventHandlers, and the editor binds
    // `{ key: 'Tab', run: insertTab }` in a keymap added EARLIER in the
    // extension array — which outranks a plugin handler. CodeMirror stopped
    // dispatching as soon as insertTab returned true, so accepting never ran:
    // a tab was inserted, and the edit retired the suggestion.
    it('takes Tab at the highest precedence, ahead of insertTab', () => {
        expect(src).toContain('Prec.highest(keymap.of([');
        const i = src.indexOf('Prec.highest(keymap.of([');
        const block = src.slice(i, src.indexOf(']))', i));
        expect(block).toContain("{ key: 'Tab', run: accept }");
        expect(block).toContain("{ key: 'Escape', run: dismiss }");
        // Not a plugin event handler any more.
        expect(src).not.toContain('eventHandlers');
    });

    // A binding that returns false falls through, so Tab keeps indenting and
    // Esc keeps doing whatever it did when there is nothing to accept.
    it('gets out of the way when there is no suggestion', () => {
        const i = src.indexOf('const accept = (view) => {');
        expect(src.slice(i, src.indexOf('};', i))).toContain('if (!text) return false;');
        const j = src.indexOf('const dismiss = (view) => {');
        expect(src.slice(j, src.indexOf('};', j))).toContain('return false;');
    });

    it('accepts and clears in a single transaction', () => {
        const i = src.indexOf('const accept = (view) => {');
        const fn = src.slice(i, src.indexOf('\n    };', i));
        expect(fn).toContain('changes: { from: pos, to: pos, insert: text }');
        expect(fn).toContain('effects: clearGhost.of(null)');
        expect((fn.match(/view\.dispatch\(/g) || []).length).toBe(1);
        // The caret belongs after what was just inserted.
        expect(fn).toContain('anchor: pos + text.length');
    });
});

describe('the ghost decoration', () => {
    const { ghostField, ghostTextOf, setGhost, clearGhost, GhostWidget } = _internals;

    const withGhost = (doc = 'hello', at = 5) => {
        const state = EditorState.create({ doc, extensions: [ghostField] });
        return state.update({
            effects: setGhost.of(Decoration.set([
                Decoration.widget({ widget: new GhostWidget(' world', 'line'), side: 1 }).range(at),
            ])),
        }).state;
    };

    it('clears itself on an edit', () => {
        const state = withGhost();
        expect(ghostTextOf(state)).toBe(' world');
        expect(ghostTextOf(state.update({ changes: { from: 5, insert: '!' } }).state)).toBe('');
    });

    it('clears itself when the caret moves', () => {
        expect(ghostTextOf(withGhost().update({ selection: { anchor: 0 } }).state)).toBe('');
    });

    it('clears on the explicit effect', () => {
        expect(ghostTextOf(withGhost().update({ effects: clearGhost.of(null) }).state)).toBe('');
    });
});

describe('the ghost text itself', () => {
    it('shows the key that accepts it', () => {
        const src = read('src/modules/ui/InlineCompletion.js');
        expect(src).toContain("hint.textContent = '⇥';");
        expect(read('src/styles/features.css')).toContain('.cm-ghost-hint');
    });

    it('records which engine produced it', () => {
        const src = read('src/modules/ui/InlineCompletion.js');
        expect(src).toContain('span.dataset.source = this.source;');
    });
});

/* The precedence bug above was invisible to source-reading tests: the code all
   looked right. This mounts a real editor with the app's own Tab binding in
   front of the extension and presses the key. */
describe('pressing Tab in a real editor', () => {
    const mount = async () => {
        const { EditorView: View, keymap } = await import('@codemirror/view');
        const { EditorState: State } = await import('@codemirror/state');
        const { insertTab } = await import('@codemirror/commands');
        const { createInlineCompletionExtension } = await import('../src/modules/ui/InlineCompletion.js');

        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const view = new View({
            parent,
            state: State.create({
                doc: 'renderSessionList();\nrender',
                extensions: [
                    // The app adds its keymap BEFORE the completion extension,
                    // which is exactly what made a plugin handler unreachable.
                    keymap.of([{ key: 'Tab', run: insertTab }]),
                    createInlineCompletionExtension({ isEnabled: () => true }),
                ],
            }),
        });
        // A suggestion is scheduled by an EDIT, not by moving the caret, so the
        // test types the last character rather than jumping the cursor there.
        const end = view.state.doc.length;
        view.dispatch({ changes: { from: end, insert: 'S' }, selection: { anchor: end + 1 } });
        return view;
    };

    const pressTab = (view) => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', code: 'Tab', bubbles: true, cancelable: true,
    }));

    /** Poll rather than sleep a fixed time: jsdom's first layout is slow. */
    const waitForGhost = async (view) => {
        for (let i = 0; i < 40; i++) {
            const t = _internals.ghostTextOf(view.state);
            if (t) return t;
            await new Promise((r) => setTimeout(r, 25));
        }
        return '';
    };

    it('inserts the suggestion, not a tab', async () => {
        const view = await mount();
        // The line above is the better template, so this is the line engine.
        expect(await waitForGhost(view)).toBe('essionList();');

        pressTab(view);
        expect(view.state.doc.toString()).toContain('renderSessionList();');
        expect(view.state.doc.toString()).not.toContain('\t');
        expect(_internals.ghostTextOf(view.state)).toBe('');
        // ...and the caret sits after what was inserted.
        expect(view.state.selection.main.head).toBe(view.state.doc.length);
        view.destroy();
    });

    // Falling through is what keeps Tab usable the rest of the time.
    it('still indents when there is nothing to accept', async () => {
        const view = await mount();
        await waitForGhost(view);
        view.dispatch({ effects: _internals.clearGhost.of(null) });
        expect(_internals.ghostTextOf(view.state)).toBe('');
        pressTab(view);
        expect(view.state.doc.toString()).toContain('\t');
        view.destroy();
    });
});
