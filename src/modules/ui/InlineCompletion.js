/**
 * InlineCompletion.js — AI ghost-text completion (Phase 2).
 *
 * Copilot-style inline completion for CodeMirror 6: after the user pauses
 * typing, the text around the cursor is sent to J.H AI Agent via the lightweight
 * single-shot path, and the returned continuation is drawn as dim "ghost text"
 * after the caret. Tab accepts, Esc or any edit dismisses.
 *
 * ── This feature TYPES YOUR FILE INTO A MODEL ─────────────────────────────
 * It is the one thing in the editor that talks to a model with no user action
 * at all — a pause in typing is the trigger. So:
 *
 *   • it is OFF by default and must be switched on (Settings → Agent),
 *   • it obeys the AI context scope, because the ~5 KB it sends around the
 *     caret is file content by any definition, and
 *   • it never runs in a personal note.
 *
 * It never writes to disk and never silently edits the buffer — acceptance is
 * always an explicit Tab.
 *
 * Wired in CodeMirrorView via createInlineCompletionExtension().
 */

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import AIAgent from '../ai/AIAgent.js';
import { allows, isPrivatePath } from '../ai/ContextScope.js';

const SETTING_KEY = 'settings_aiInlineCompletion';

/**
 * Is ghost-text completion switched on?
 *
 * Absent means OFF. A feature that sends the file you are editing to a model
 * every time you pause is not something to enable on someone's behalf.
 */
export function isInlineCompletionEnabled() {
    try { return localStorage.getItem(SETTING_KEY) === '1'; } catch (_) { return false; }
}

export function setInlineCompletionEnabled(on) {
    try { localStorage.setItem(SETTING_KEY, on ? '1' : '0'); } catch (_) { /* ignore */ }
}

class GhostWidget extends WidgetType {
    constructor(text) { super(); this.text = text; }
    eq(other) { return other.text === this.text; }
    toDOM() {
        const span = document.createElement('span');
        span.className = 'cm-ghost-text';
        span.textContent = this.text;
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
 * ended up stuck on screen with Esc and Tab no longer answering. A state field
 * cannot get into that state, because it never dispatches.
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

const INLINE_TRIGGER_DELAY_MS = 700;
const MAX_SUGGESTION_LINES = 6;

/**
 * @param {object} opts
 * @param {function(): {path:string|null, name:string|null}} opts.getFile
 * @param {function(): boolean} [opts.isEnabled] Override the stored setting
 *        (used by tests; production reads the setting).
 */
export function createInlineCompletionExtension({ getFile, isEnabled } = {}) {
    let timer = null;
    let controller = null;
    let activeView = null;

    const cancel = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (controller) { try { controller.abort(); } catch (_) { /* ignore */ } controller = null; }
    };

    /**
     * May we ask a model to continue this file, right now?
     *
     * Three separate answers, all of which must be yes: the user switched the
     * feature on, the context scope permits the file to be read, and the file is
     * not one of the user's personal notes.
     */
    const permitted = () => {
        if (isEnabled ? !isEnabled() : !isInlineCompletionEnabled()) return false;
        if (!allows('activeBuffer')) return false;
        const info = getFile ? getFile() : {};
        return !isPrivatePath(info && (info.path || info.name));
    };

    const dismiss = (view) => {
        if (!view) return;
        // `Decoration.none` is a truthy object, so the old presence check was
        // always true and dispatched a pointless transaction every keystroke.
        if (ghostTextOf(view.state)) {
            view.dispatch({ effects: clearGhost.of(null) });
        }
    };

    const request = async (view) => {
        if (!permitted()) return;
        if (view.state.selection.main.from !== view.state.selection.main.to) return;

        const pos = view.state.selection.main.head;
        const doc = view.state.doc;
        // A bounded window: prefix (up to 4 KB) and suffix (up to 1 KB).
        const prefix = doc.sliceString(Math.max(0, pos - 4096), pos);
        const suffix = doc.sliceString(pos, Math.min(doc.length, pos + 1024));
        if (prefix.trim().length < 2) return;

        controller = new AbortController();
        const my = controller;
        const info = getFile ? getFile() : {};
        const lang = (info.path || info.name || '').split('.').pop() || 'text';
        const prompt =
            `You are an inline code completion assistant. Continue the code/text directly after the cursor `
            + `in a ${lang} file. Return ONLY the continuation text (no explanation, no code fences). `
            + `Do not repeat the existing prefix/suffix. Keep it short (${MAX_SUGGESTION_LINES} lines or fewer).\n\n`
            + `--- text before cursor ---\n${prefix}\n--- text after cursor ---\n${suffix}\n`;

        try {
            const result = await AIAgent.runSingleShot({
                prompt,
                systemPrompt: 'You output ONLY the continuation of the given text.',
                context: { app: 'jheditor', file: info.path || null, language: lang },
                abortSignal: my.signal,
            });
            if (controller !== my || view !== activeView) return;
            // The answer may arrive seconds later. Painting it against a caret
            // that has since moved is where a suggestion for the wrong place
            // came from, so a late reply is simply dropped.
            if (view.state.selection.main.head !== pos || view.state.doc !== doc) return;

            let suggestion = String(result || '').replace(/\r\n/g, '\n');
            const fenced = suggestion.match(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/);
            if (fenced) suggestion = fenced[1];
            suggestion = suggestion.replace(/^\n+/, '');
            if (!suggestion.trim()) return;
            const lines = suggestion.split('\n');
            if (lines.length > MAX_SUGGESTION_LINES) {
                suggestion = lines.slice(0, MAX_SUGGESTION_LINES).join('\n');
            }
            // Nothing to offer if it just repeats what already follows.
            if (suffix.startsWith(suggestion)) return;

            const deco = Decoration.set([
                Decoration.widget({ widget: new GhostWidget(suggestion), side: 1 }).range(pos),
            ]);
            view.dispatch({ effects: setGhost.of(deco) });
        } catch (e) {
            if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) return;
            // Reachability errors etc. → stay silent; ghost text is best-effort.
        } finally {
            if (controller === my) controller = null;
        }
    };

    const schedule = (view) => {
        cancel();
        if (!permitted()) return;
        activeView = view;
        timer = setTimeout(() => request(view), INLINE_TRIGGER_DELAY_MS);
    };

    return [
        ghostField,
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

                destroy() { cancel(); activeView = null; }
            },
            { eventHandlers: {
                keydown: (event, view) => {
                    const accepted = ghostTextOf(view.state);
                    if (!accepted) return false;

                    if (event.key === 'Tab' && !event.shiftKey) {
                        event.preventDefault();
                        const pos = view.state.selection.main.head;
                        view.dispatch({
                            changes: { from: pos, to: pos, insert: accepted },
                            selection: { anchor: pos + accepted.length },
                            effects: clearGhost.of(null),
                        });
                        return true;
                    }
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        cancel();   // and do not immediately ask again
                        view.dispatch({ effects: clearGhost.of(null) });
                        return true;
                    }
                    return false;
                },
            } }
        ),
    ];
}

/** Exported for tests: the field and the reader over it. */
export const _internals = { ghostField, ghostTextOf, setGhost, clearGhost, GhostWidget };
