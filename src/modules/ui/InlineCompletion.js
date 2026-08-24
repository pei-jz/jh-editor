/**
 * InlineCompletion.js — AI ghost-text completion (Phase 2).
 *
 * Copilot-style inline completion for CodeMirror 6: after the user pauses
 * typing (or presses the trigger), the prefix/suffix around the cursor is sent
 * to J.H AI Agent via the lightweight single-shot path, and the returned
 * continuation is drawn as dim "ghost text" after the caret. Tab accepts,
 * Esc / any edit dismisses.
 *
 * Because the external agent's single-shot call is not a true FIM model, this
 * sends the surrounding context and asks for a continuation; results are
 * debounced, cancellable, and clamped to a few lines. It never writes to disk
 * and never silently edits the buffer — acceptance is always an explicit Tab.
 *
 * Wired in CodeMirrorView via createInlineCompletionExtension().
 */

import { StateEffect, StateField, RangeSet } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import AIAgent from '../ai/AIAgent.js';

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

const ghostField = StateField.define({
    create() { return Decoration.none; },
    update(deco, tr) {
        deco = deco.map(tr.changes);
        for (const e of tr.effects) {
            if (e.is(setGhost)) deco = e.value;
            else if (e.is(clearGhost)) deco = Decoration.none;
        }
        return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
});

const INLINE_TRIGGER_DELAY_MS = 700;
const MAX_SUGGESTION_LINES = 6;

/**
 * @param {object} opts
 * @param {function(): {path:string|null, view:CodeMirrorView}} opts.getFile
 *        Returns the current file path (or null) and the owning view.
 * @param {function(): boolean} [opts.isEnabled]   gate (default: true when Agent reachable)
 */
export function createInlineCompletionExtension({ getFile, isEnabled } = {}) {
    let timer = null;
    let controller = null;
    let activeView = null;

    const cancel = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (controller) { try { controller.abort(); } catch (_) {} controller = null; }
    };

    const show = (view, pos, text) => {
        if (!view || view !== activeView || !text) return;
        const deco = Decoration.set([Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(pos)]);
        view.dispatch({ effects: setGhost.of(deco) });
    };

    const dismiss = (view) => {
        if (view && view.state.field(ghostField, false)) {
            view.dispatch({ effects: clearGhost.of(null) });
        }
    };

    const request = async (view) => {
        if (view.state.selection.main.from !== view.state.selection.main.to) {
            dismiss(view);
            return;
        }
        const pos = view.state.selection.main.head;
        const doc = view.state.doc;
        // Gather a bounded window: prefix (up to 4 KB) and suffix (up to 1 KB).
        const prefixStart = Math.max(0, pos - 4096);
        const suffixEnd = Math.min(doc.length, pos + 1024);
        const prefix = doc.sliceString(prefixStart, pos);
        const suffix = doc.sliceString(pos, suffixEnd);

        if (prefix.trim().length < 2) { dismiss(view); return; }

        controller = new AbortController();
        const my = controller;
        const info = getFile ? getFile() : {};
        const lang = (info.path || info.name || '').split('.').pop() || 'text';
        const prompt =
            `You are an inline code completion assistant. Continue the code/text directly after the cursor ` +
            `in a ${lang} file. Return ONLY the continuation text (no explanation, no code fences). ` +
            `Do not repeat the existing prefix/suffix. Keep it short (${MAX_SUGGESTION_LINES} lines or fewer).\n\n` +
            `--- text before cursor ---\n${prefix}\n--- text after cursor ---\n${suffix}\n`;

        try {
            const result = await AIAgent.runSingleShot({
                prompt,
                systemPrompt: 'You output ONLY the continuation of the given text.',
                context: { app: 'jheditor', file: info.path || null, language: lang },
                abortSignal: my.signal,
            });
            if (controller !== my || view !== activeView) return;
            let suggestion = (result || '').replace(/\r\n/g, '\n');
            // Strip markdown code fences if the model wrapped it anyway.
            const fenced = suggestion.match(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/);
            if (fenced) suggestion = fenced[1];
            // Trim leading whitespace/newlines that would double the indent.
            suggestion = suggestion.replace(/^\n+/, '');
            if (!suggestion.trim()) return;
            // Clamp to the configured number of lines.
            const lines = suggestion.split('\n');
            if (lines.length > MAX_SUGGESTION_LINES) suggestion = lines.slice(0, MAX_SUGGESTION_LINES).join('\n');
            // Don't suggest something that already equals the following text.
            if (suffix.startsWith(suggestion)) { dismiss(view); return; }
            show(view, pos, suggestion);
        } catch (e) {
            if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) return;
            // Reachability errors etc. → stay silent; ghost text is best-effort.
        } finally {
            if (controller === my) controller = null;
        }
    };

    const schedule = (view) => {
        cancel();
        if (isEnabled && !isEnabled()) { dismiss(view); return; }
        activeView = view;
        timer = setTimeout(() => request(view), INLINE_TRIGGER_DELAY_MS);
    };

    return [
        ghostField,
        ViewPlugin.fromClass(
            class {
                constructor(view) {
                    this.view = view;
                    this.update = this.update.bind(this);
                    view.scrollDOM.addEventListener('scroll', this.update);
                }
                update(u) {
                    if (u.docChanged || u.selectionSet) {
                        // Any edit/caret move invalidates the pending suggestion.
                        if (this.view.state.field(ghostField, false) !== Decoration.none) {
                            dismiss(this.view);
                        }
                        if (u.docChanged) {
                            // Only re-trigger on real typing (not pure cursor moves).
                            const changed = u.transactions.some((tr) => tr.docChanged);
                            if (changed) schedule(this.view);
                        }
                    }
                }
                destroy() {
                    this.view.scrollDOM.removeEventListener('scroll', this.update);
                }
            },
            { eventHandlers: {
                keydown: (event, view) => {
                    const deco = view.state.field(ghostField, false);
                    if (deco === Decoration.none) return false;
                    if (event.key === 'Tab' && !event.shiftKey) {
                        // Accept: replace the range after the caret with the ghost text.
                        event.preventDefault();
                        let accepted = '';
                        const iter = deco.iter();
                        while (iter.value) {
                            if (iter.value.widget && iter.value.widget instanceof GhostWidget) {
                                accepted = iter.value.widget.text;
                            }
                            iter.next();
                        }
                        if (accepted) {
                            const pos = view.state.selection.main.head;
                            view.dispatch({ changes: { from: pos, to: pos, insert: accepted } });
                        }
                        view.dispatch({ effects: clearGhost.of(null) });
                        return true;
                    }
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        view.dispatch({ effects: clearGhost.of(null) });
                        return true;
                    }
                    return false;
                },
            } }
        ),
        EditorView.updateListener.of(() => {}),
    ];
}
