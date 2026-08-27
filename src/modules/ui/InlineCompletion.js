/**
 * InlineCompletion.js — ghost text after the caret. Tab accepts, Esc dismisses.
 *
 * ── There used to be a model behind this, and it has been removed ──────────
 *
 * The suggestions came from a single-shot agent task: a POST, a WebSocket
 * subscribe and a provider round trip. Seconds, where an inline completion has
 * a fraction of a second to be worth reading — by the time an answer arrived
 * the caret had usually moved, so it was discarded. The request had already
 * been made, and could not be recalled: aborting stops the editor waiting, but
 * the task exists on the agent either way. A pause every couple of seconds is
 * how seven of them appeared in half a minute, none of them used.
 *
 * Rate limits made that less bad without making it good, and a toggle for a
 * feature that cannot meet its own bar mostly advertises something that does
 * not work. AI on demand is what Inline AI is for, where the user asks and is
 * willing to wait. So this is local only:
 *
 *   • LINE  — the line you are typing shares a prefix with a line already in
 *     the file, so the rest of that line is the obvious continuation.
 *   • WORD  — the token under the caret starts a word used elsewhere in it.
 *
 * Both answer in well under a frame, cost nothing, and send nothing anywhere.
 * See LocalCompletion.js for the engines themselves.
 */

import { Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import { localSuggestion } from './LocalCompletion.js';

const LOCAL_KEY = 'settings_inlineSuggestLocal';

/**
 * Inline suggestions: on unless switched off.
 *
 * Nothing leaves the machine and nothing is billed, so the default is the
 * useful one.
 */
export function isLocalSuggestEnabled() {
    try { return localStorage.getItem(LOCAL_KEY) !== '0'; } catch (_) { return true; }
}

export function setLocalSuggestEnabled(on) {
    try { localStorage.setItem(LOCAL_KEY, on ? '1' : '0'); } catch (_) { /* ignore */ }
}

class GhostWidget extends WidgetType {
    constructor(text, source) {
        super();
        this.text = text;
        this.source = source;   // 'line' | 'word'
    }

    eq(other) { return other.text === this.text && other.source === this.source; }

    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-ghost-text';
        span.dataset.source = this.source;
        span.textContent = this.text;
        // Nothing said Tab accepts it. One dim glyph is cheaper than a tooltip
        // and disappears with the suggestion.
        const hint = document.createElement('span');
        hint.className = 'cm-ghost-hint';
        hint.textContent = '⇥';
        span.appendChild(hint);
        return span;
    }

    ignoreEvent() { return false; }
}

const setGhost = StateEffect.define();
const clearGhost = StateEffect.define();

/**
 * The suggestion currently on screen.
 *
 * Retiring it is decided HERE, from the transaction, rather than by a view
 * plugin dispatching a second transaction when it sees a change. CodeMirror
 * forbids dispatching while an update is in progress: doing it anyway threw,
 * and a plugin that throws is torn out of the view — which is how the ghost
 * ended up stuck on screen with Esc and Tab no longer answering.
 */
const ghostField = StateField.define({
    create() { return Decoration.none; },
    update(deco, tr) {
        for (const e of tr.effects) {
            if (e.is(setGhost)) return e.value;
            if (e.is(clearGhost)) return Decoration.none;
        }
        // Any edit or caret move makes the suggestion stale. Dropping it beats
        // mapping it: a continuation computed for one caret position is not a
        // continuation for the next one.
        if (tr.docChanged || tr.selection) return Decoration.none;
        return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
});

/** The text of the visible suggestion, or '' when there is none. */
function ghostTextOf(state) {
    const deco = state.field(ghostField, false);
    if (!deco || deco.size === 0) return '';
    let text = '';
    const iter = deco.iter();
    while (iter.value) {
        if (iter.value.widget instanceof GhostWidget) text = iter.value.widget.text;
        iter.next();
    }
    return text;
}

/** Short enough to feel like part of typing, long enough not to run per key. */
const LOCAL_DELAY_MS = 120;

/**
 * @param {object} opts
 * @param {function(): boolean} [opts.isEnabled] override for tests
 */
export function createInlineCompletionExtension({ isEnabled } = {}) {
    let timer = null;

    const cancel = () => {
        if (timer) { clearTimeout(timer); timer = null; }
    };

    const enabled = () => (isEnabled ? isEnabled() : isLocalSuggestEnabled());

    const run = (view) => {
        if (!enabled()) return;
        const { state } = view;
        if (state.selection.main.from !== state.selection.main.to) return;

        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        const hit = localSuggestion({
            text: state.doc.toString(),
            lineText: line.text,
            lineIndex: line.number - 1,
            column: pos - line.from,
            offset: pos,
        });
        if (!hit) return;

        view.dispatch({
            effects: setGhost.of(Decoration.set([
                Decoration.widget({ widget: new GhostWidget(hit.text, hit.source), side: 1 })
                    .range(pos),
            ])),
        });
    };

    const schedule = (view) => {
        cancel();
        if (!enabled()) return;
        timer = setTimeout(() => run(view), LOCAL_DELAY_MS);
    };

    /**
     * Take the suggestion. Returns false when there is none, so Tab falls
     * through to whatever it normally does.
     */
    const accept = (view) => {
        const text = ghostTextOf(view.state);
        if (!text) return false;
        const pos = view.state.selection.main.head;
        view.dispatch({
            changes: { from: pos, to: pos, insert: text },
            selection: { anchor: pos + text.length },
            effects: clearGhost.of(null),
        });
        return true;
    };

    const dismiss = (view) => {
        if (!ghostTextOf(view.state)) return false;
        cancel();   // and do not immediately suggest again
        view.dispatch({ effects: clearGhost.of(null) });
        return true;
    };

    return [
        ghostField,

        // A KEYMAP, at the highest precedence — not a plugin event handler.
        //
        // The editor binds `{ key: 'Tab', run: insertTab }` in a keymap added
        // earlier in the extension array, which therefore outranks a plugin's
        // handler: CodeMirror stopped dispatching as soon as insertTab returned
        // true, so this never ran. Tab inserted a tab, the edit retired the
        // ghost, and accepting a suggestion was impossible.
        //
        // Returning false when there is no suggestion is what keeps Tab and Esc
        // behaving normally the rest of the time: a keymap binding that returns
        // false falls through to the next one.
        Prec.highest(keymap.of([
            { key: 'Tab', run: accept },
            { key: 'Escape', run: dismiss },
        ])),

        ViewPlugin.fromClass(
            class {
                constructor(view) { this.view = view; }

                update(u) {
                    // The field has already retired any stale suggestion; all
                    // this has to decide is whether to ask for a new one. It
                    // must NOT dispatch — see the note on ghostField.
                    if (u.docChanged) schedule(this.view);
                    else if (u.selectionSet) cancel();
                }

                destroy() { cancel(); }
            },
        ),
    ];
}

/** Exported for tests. */
export const _internals = {
    ghostField, ghostTextOf, setGhost, clearGhost, GhostWidget, LOCAL_DELAY_MS,
};
