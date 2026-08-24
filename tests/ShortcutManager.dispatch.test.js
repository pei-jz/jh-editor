import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShortcutManager } from '../src/modules/core/ShortcutManager.js';

const key = (over = {}) => ({
    key: 'k', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    repeat: false, target: document.body,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    ...over,
});

describe('ShortcutManager — registration', () => {
    let sm;
    beforeEach(() => {
        localStorage.clear();
        sm = new ShortcutManager();
    });

    it('loads the built-in definitions with a scope and a stable id', () => {
        const s = sm.shortcuts.find(x => x.cmd === 'app:save');
        expect(s.scope).toBe('GLOBAL');
        expect(s.id).toMatch(/^GLOBAL:app:save:\d+$/);
    });

    it('register() attaches an action to an existing definition', () => {
        const action = vi.fn();
        sm.register({ cmd: 'app:save', scope: 'GLOBAL', action });
        expect(sm.shortcuts.filter(s => s.cmd === 'app:save' && s.action).length).toBeGreaterThan(0);
    });

    it('register() appends a brand-new shortcut', () => {
        const before = sm.shortcuts.length;
        sm.register({ key: 'q', ctrl: true, cmd: 'test:new', action: vi.fn() });
        expect(sm.shortcuts.length).toBe(before + 1);
        expect(sm.shortcuts.at(-1).scope).toBe('GLOBAL'); // defaulted
    });

    it('register() can override the description', () => {
        sm.register({ cmd: 'app:save', scope: 'GLOBAL', action: vi.fn(), description: 'Custom' });
        expect(sm.shortcuts.find(s => s.cmd === 'app:save').description).toBe('Custom');
    });

    it('unregisterScope() drops only that scope', () => {
        const globals = sm.shortcuts.filter(s => s.scope === 'GLOBAL').length;
        sm.unregisterScope('MARKDOWN');
        expect(sm.shortcuts.filter(s => s.scope === 'MARKDOWN')).toHaveLength(0);
        expect(sm.shortcuts.filter(s => s.scope === 'GLOBAL')).toHaveLength(globals);
    });

    it('setScope() accepts known scopes and ignores unknown ones', () => {
        sm.setScope('EDITOR');
        expect(sm.currentScope).toBe('EDITOR');
        sm.setScope('NOT_A_SCOPE');
        expect(sm.currentScope).toBe('EDITOR');
    });
});

describe('ShortcutManager — user overrides', () => {
    let sm;
    beforeEach(() => { localStorage.clear(); sm = new ShortcutManager(); });

    it('persists a remapped key and applies it on reload', () => {
        const id = sm.shortcuts.find(s => s.cmd === 'app:save').id;
        sm.updateShortcut(id, { key: 'F9', ctrl: false, shift: false, alt: false });

        const reloaded = new ShortcutManager();
        expect(reloaded.shortcuts.find(s => s.id === id).key).toBe('F9');
    });

    it('resetToDefaults() discards the overrides', () => {
        const id = sm.shortcuts.find(s => s.cmd === 'app:save').id;
        sm.updateShortcut(id, { key: 'F9' });
        sm.resetToDefaults();
        expect(sm.shortcuts.find(s => s.id === id).key).toBe('s');
    });
});

describe('ShortcutManager — dispatch', () => {
    let sm;
    beforeEach(() => {
        localStorage.clear();
        sm = new ShortcutManager();
        delete window._isRecordingShortcut;
    });
    afterEach(() => { delete window._isRecordingShortcut; });

    it('runs the action for a matching combo and stops the event', () => {
        const action = vi.fn();
        sm.register({ key: 'j', ctrl: true, cmd: 'test:go', scope: 'GLOBAL', action });
        const e = key({ key: 'j', ctrlKey: true });
        sm.handleKeyDown(e);
        expect(action).toHaveBeenCalledOnce();
        expect(e.preventDefault).toHaveBeenCalled();
    });

    it('requires every modifier to match exactly', () => {
        const action = vi.fn();
        sm.register({ key: 'j', ctrl: true, cmd: 'test:go', scope: 'GLOBAL', action });
        sm.handleKeyDown(key({ key: 'j', ctrlKey: true, shiftKey: true }));
        sm.handleKeyDown(key({ key: 'j' }));
        expect(action).not.toHaveBeenCalled();
    });

    it('treats Meta as Ctrl (macOS)', () => {
        const action = vi.fn();
        sm.register({ key: 'j', ctrl: true, cmd: 'test:go', scope: 'GLOBAL', action });
        sm.handleKeyDown(key({ key: 'j', metaKey: true }));
        expect(action).toHaveBeenCalledOnce();
    });

    it('is case-insensitive about the key', () => {
        const action = vi.fn();
        sm.register({ key: 'j', ctrl: true, cmd: 'test:go', scope: 'GLOBAL', action });
        sm.handleKeyDown(key({ key: 'J', ctrlKey: true }));
        expect(action).toHaveBeenCalledOnce();
    });

    it('prefers a scoped binding over the global one', () => {
        const globalAction = vi.fn();
        const scoped = vi.fn();
        sm.register({ key: 'j', ctrl: true, cmd: 'test:global', scope: 'GLOBAL', action: globalAction });
        sm.register({ key: 'j', ctrl: true, cmd: 'test:scoped', scope: 'CSV', action: scoped });
        sm.setScope('CSV');
        sm.handleKeyDown(key({ key: 'j', ctrlKey: true }));
        expect(scoped).toHaveBeenCalledOnce();
        expect(globalAction).not.toHaveBeenCalled();
    });

    it('ignores bindings belonging to another scope', () => {
        const scoped = vi.fn();
        sm.register({ key: 'j', ctrl: true, cmd: 'test:scoped', scope: 'CSV', action: scoped });
        sm.setScope('EDITOR');
        sm.handleKeyDown(key({ key: 'j', ctrlKey: true }));
        expect(scoped).not.toHaveBeenCalled();
    });

    it('emits a shortcutTriggered event when there is no action', () => {
        const seen = vi.fn();
        window.addEventListener('shortcutTriggered', seen);
        sm.register({ key: 'j', ctrl: true, cmd: 'test:evt', scope: 'GLOBAL' });
        sm.handleKeyDown(key({ key: 'j', ctrlKey: true }));
        expect(seen).toHaveBeenCalled();
        expect(seen.mock.calls[0][0].detail.command).toBe('test:evt');
        window.removeEventListener('shortcutTriggered', seen);
    });

    it('stays out of the way while a shortcut is being recorded', () => {
        const action = vi.fn();
        sm.register({ key: 'j', ctrl: true, cmd: 'test:go', scope: 'GLOBAL', action });
        window._isRecordingShortcut = true;
        sm.handleKeyDown(key({ key: 'j', ctrlKey: true }));
        expect(action).not.toHaveBeenCalled();
    });

    it('ignores events with no key', () => {
        expect(() => sm.handleKeyDown(key({ key: undefined }))).not.toThrow();
    });

    // WebView2 on Windows / Japanese-layout environments reports
    // e.key === 'Unidentified' for the function keys, which killed every
    // F-key shortcut (F2 rename / F2 edit) while letters and arrows worked.
    describe('function-key fallback (Unidentified / Process)', () => {
        beforeEach(() => {
            // The built-in GLOBAL scope already maps F2 → md-block:edit, which
            // would win the match over the test-only binding. Drop it so the
            // test binding is the one exercised.
            sm.unregisterScope('GLOBAL');
        });

        it('matches F2 via e.code when e.key is Unidentified', () => {
            const action = vi.fn();
            sm.register({ key: 'F2', cmd: 'test:f2', scope: 'GLOBAL', action });
            sm.handleKeyDown(key({ key: 'Unidentified', code: 'F2' }));
            expect(action).toHaveBeenCalledOnce();
        });

        it('matches F2 via keyCode 113 when key and code are missing', () => {
            const action = vi.fn();
            sm.register({ key: 'F2', cmd: 'test:f2', scope: 'GLOBAL', action });
            sm.handleKeyDown(key({ key: 'Unidentified', code: '', keyCode: 113 }));
            expect(action).toHaveBeenCalledOnce();
        });

        it('matches F12 via keyCode 123', () => {
            const action = vi.fn();
            sm.register({ key: 'F12', shift: true, cmd: 'test:f12', scope: 'GLOBAL', action });
            sm.handleKeyDown(key({ key: 'Process', code: '', keyCode: 123, shiftKey: true }));
            expect(action).toHaveBeenCalledOnce();
        });

        it('does not fall back for a normal letter key', () => {
            const action = vi.fn();
            sm.register({ key: 'j', ctrl: true, cmd: 'test:go', scope: 'GLOBAL', action });
            sm.handleKeyDown(key({ key: 'j', code: 'KeyJ', keyCode: 74, ctrlKey: true }));
            expect(action).toHaveBeenCalledOnce();
        });

        it('prefers e.code over keyCode when both are present', () => {
            const f2 = vi.fn();
            const f3 = vi.fn();
            sm.register({ key: 'F2', cmd: 'test:f2', scope: 'GLOBAL', action: f2 });
            sm.register({ key: 'F3', cmd: 'test:f3', scope: 'GLOBAL', action: f3 });
            // key says Unidentified, code says F2 but keyCode says 114 (F3) —
            // the physical key (e.code) wins.
            sm.handleKeyDown(key({ key: 'Unidentified', code: 'F2', keyCode: 114 }));
            expect(f2).toHaveBeenCalledOnce();
            expect(f3).not.toHaveBeenCalled();
        });
    });

    describe('SEARCH scope', () => {
        beforeEach(() => sm.setScope('SEARCH'));

        it('lets the search panel own most keys', () => {
            const action = vi.fn();
            sm.register({ key: 'j', ctrl: true, cmd: 'test:go', scope: 'GLOBAL', action });
            sm.handleKeyDown(key({ key: 'j', ctrlKey: true }));
            expect(action).not.toHaveBeenCalled();
        });

        // Ctrl+F must survive the SEARCH guard so the panel can be reopened.
        // (Ctrl+H is allowed through the same guard but has no ShortcutManager
        // binding — Search.js handles it on its own listener.)
        it('still allows Ctrl+F through', () => {
            const seen = vi.fn();
            window.addEventListener('shortcutTriggered', seen);
            sm.handleKeyDown(key({ key: 'f', ctrlKey: true }));
            expect(seen).toHaveBeenCalled();
            window.removeEventListener('shortcutTriggered', seen);
        });

        it('swallows a key that is neither Ctrl+F nor Ctrl+H', () => {
            const seen = vi.fn();
            window.addEventListener('shortcutTriggered', seen);
            sm.handleKeyDown(key({ key: 's', ctrlKey: true }));
            expect(seen).not.toHaveBeenCalled();
            window.removeEventListener('shortcutTriggered', seen);
        });
    });

    // Excel-style range-to-edge selection. The matcher compares ctrl AND shift,
    // so the ctrl-only and shift-only CSV arrow entries did NOT cover the combo
    // and Ctrl+Shift+Arrow fell through to nothing at all.
    describe('CSV scope arrows', () => {
        const dispatched = (ev) => {
            const seen = vi.fn();
            window.addEventListener('shortcutTriggered', seen);
            sm.setScope('CSV');
            sm.handleKeyDown(ev);
            window.removeEventListener('shortcutTriggered', seen);
            return seen.mock.calls.map((c) => c[0].detail.command);
        };

        it('routes Ctrl+Shift+Arrow to csv:nav', () => {
            for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
                expect(dispatched(key({ key: k, ctrlKey: true, shiftKey: true })))
                    .toEqual(['csv:nav']);
            }
        });

        it('still routes the plain, ctrl-only and shift-only arrows', () => {
            expect(dispatched(key({ key: 'ArrowDown' }))).toEqual(['csv:nav']);
            expect(dispatched(key({ key: 'ArrowDown', ctrlKey: true }))).toEqual(['csv:nav']);
            expect(dispatched(key({ key: 'ArrowDown', shiftKey: true }))).toEqual(['csv:nav']);
        });
    });

    // Ctrl+\ split. Two things used to break it: the commands lived in the
    // EDITOR scope (so a markdown block or the explorer never saw them), and the
    // matcher compared e.key, which is not a backslash on a JIS keyboard.
    describe('editor split', () => {
        const dispatched = (ev, scope) => {
            const seen = vi.fn();
            window.addEventListener('shortcutTriggered', seen);
            sm.setScope(scope);
            sm.handleKeyDown(ev);
            window.removeEventListener('shortcutTriggered', seen);
            return seen.mock.calls.map((c) => c[0].detail.command);
        };

        it('splits from any scope, not just EDITOR', () => {
            for (const scope of ['GLOBAL', 'EDITOR', 'MARKDOWN_BLOCK', 'CSV', 'EXPLORER']) {
                expect(dispatched(key({ key: '\\', ctrlKey: true, code: 'Backslash' }), scope))
                    .toEqual(['editor:split-right']);
            }
        });

        it('maps the modifiers to the four pane commands', () => {
            const bs = (over) => key({ key: '\\', ctrlKey: true, code: 'Backslash', ...over });
            expect(dispatched(bs({}), 'GLOBAL')).toEqual(['editor:split-right']);
            expect(dispatched(bs({ altKey: true }), 'GLOBAL')).toEqual(['editor:split-down']);
            expect(dispatched(bs({ shiftKey: true }), 'GLOBAL')).toEqual(['editor:focus-other-pane']);
            expect(dispatched(key({ key: 'w', ctrlKey: true, shiftKey: true }), 'GLOBAL'))
                .toEqual(['editor:close-split']);
        });

        // JIS keyboards report the ￥ / ろ keys as '¥' or '_', never a backslash.
        it('recognises the backslash key by e.code on non-US layouts', () => {
            for (const code of ['IntlYen', 'IntlRo']) {
                expect(dispatched(key({ key: '¥', ctrlKey: true, code }), 'GLOBAL'))
                    .toEqual(['editor:split-right']);
            }
        });

        it('does not treat an unrelated key as the backslash', () => {
            expect(dispatched(key({ key: 'b', ctrlKey: true, code: 'KeyB' }), 'GLOBAL'))
                .not.toContain('editor:split-right');
        });
    });

    // A themed modal dialog owns the keyboard while it is open. This listener is
    // on window in the CAPTURE phase and registers at module load, so the dialog
    // cannot stop it from its own handler — the guard has to live here.
    describe('modal dialog guard', () => {
        afterEach(() => {
            document.querySelectorAll('.app-dialog-overlay').forEach((o) => o.remove());
        });

        it('ignores every key while a dialog is open', () => {
            const action = vi.fn();
            sm.register({ key: 'Escape', cmd: 'test:close', scope: 'GLOBAL', action });
            const dlg = document.createElement('div');
            dlg.className = 'app-dialog-overlay';
            document.body.appendChild(dlg);

            sm.handleKeyDown(key({ key: 'Escape' }));
            expect(action).not.toHaveBeenCalled();

            dlg.remove();
            sm.handleKeyDown(key({ key: 'Escape' }));
            expect(action).toHaveBeenCalledOnce();
        });
    });

    describe('clipboard passthrough', () => {
        it('lets a plain input handle Ctrl+C natively', () => {
            const action = vi.fn();
            sm.register({ key: 'c', ctrl: true, cmd: 'app:copy', scope: 'GLOBAL', action });
            const input = document.createElement('input');
            sm.handleKeyDown(key({ key: 'c', ctrlKey: true, target: input }));
            expect(action).not.toHaveBeenCalled();
        });

        it('still handles Ctrl+C for the app editor', () => {
            const action = vi.fn();
            sm.register({ key: 'c', ctrl: true, cmd: 'app:copy', scope: 'GLOBAL', action });
            const ta = document.createElement('textarea');
            ta.className = 'plain-text-editor';
            sm.handleKeyDown(key({ key: 'c', ctrlKey: true, target: ta }));
            expect(action).toHaveBeenCalledOnce();
        });

        // The CSV grid edits a cell in an overlay <textarea> (F2). Ctrl+Z there
        // must undo the typing, not roll back the grid model underneath it.
        it('lets the CSV cell editor handle Ctrl+Z natively', () => {
            const action = vi.fn();
            sm.register({ key: 'z', ctrl: true, cmd: 'app:undo', scope: 'GLOBAL', action });
            sm.setScope('CSV_EDIT');
            const ta = document.createElement('textarea');
            ta.className = 'csv-overlay-editor';
            sm.handleKeyDown(key({ key: 'z', ctrlKey: true, target: ta }));
            expect(action).not.toHaveBeenCalled();
        });

        // The markdown block editor is a CodeMirror view (contentEditable, not a
        // textarea) with its own history keymap — app:undo would either roll
        // back the document under it or, with no view.undo(), do nothing.
        it('lets the markdown block editor handle Ctrl+Z natively', () => {
            const action = vi.fn();
            sm.register({ key: 'z', ctrl: true, cmd: 'app:undo', scope: 'GLOBAL', action });
            const host = document.createElement('div');
            host.className = 'block-editor block-cm';
            const content = document.createElement('div');
            content.className = 'cm-content';
            content.contentEditable = 'true';
            host.appendChild(content);
            document.body.appendChild(host);
            sm.setScope('MARKDOWN');
            sm.handleKeyDown(key({ key: 'z', ctrlKey: true, target: content }));
            expect(action).not.toHaveBeenCalled();
            host.remove();
        });

        it('still runs Ctrl+Z on the CSV grid itself', () => {
            const action = vi.fn();
            sm.register({ key: 'z', ctrl: true, cmd: 'app:undo', scope: 'GLOBAL', action });
            sm.setScope('CSV');
            sm.handleKeyDown(key({ key: 'z', ctrlKey: true, target: document.createElement('div') }));
            expect(action).toHaveBeenCalledOnce();
        });

        it('leaves clipboard keys to the table editor in MARKDOWN_TABLE scope', () => {
            const action = vi.fn();
            sm.register({ key: 'c', ctrl: true, cmd: 'app:copy', scope: 'MARKDOWN_TABLE', action });
            sm.setScope('MARKDOWN_TABLE');
            sm.handleKeyDown(key({ key: 'c', ctrlKey: true }));
            expect(action).not.toHaveBeenCalled();
        });
    });

    describe('inline rename input (explorer F2)', () => {
        beforeEach(() => {
            // The built-in GLOBAL scope maps F2 → md-block:edit and the
            // EXPLORER scope maps Enter → explorer:nav (which opens the file).
            // A rename-input must bypass ALL of them: Enter commits the rename.
            sm.unregisterScope('GLOBAL');
            sm.unregisterScope('EXPLORER');
        });

        it('lets Enter reach the rename input without dispatching any shortcut', () => {
            const action = vi.fn();
            const seen = vi.fn();
            sm.register({ key: 'Enter', cmd: 'explorer:nav', scope: 'EXPLORER', action });
            window.addEventListener('shortcutTriggered', seen);
            sm.setScope('EXPLORER');

            const input = document.createElement('input');
            input.className = 'rename-input';
            const e = key({ key: 'Enter', target: input });
            sm.handleKeyDown(e);

            expect(action).not.toHaveBeenCalled();
            expect(seen).not.toHaveBeenCalled();
            expect(e.preventDefault).not.toHaveBeenCalled();
            expect(e.stopPropagation).not.toHaveBeenCalled();
            window.removeEventListener('shortcutTriggered', seen);
        });

        it('lets plain letter keys reach the rename input (no global F2/shortcut)', () => {
            const action = vi.fn();
            sm.register({ key: 'F2', cmd: 'md-block:edit', scope: 'GLOBAL', action });
            const input = document.createElement('input');
            input.className = 'rename-input';
            const e = key({ key: 'F2', target: input });
            sm.handleKeyDown(e);
            expect(action).not.toHaveBeenCalled();
        });
    });

    describe('MARKDOWN_TABLE scope', () => {
        it('does not let the GLOBAL F2 (md-block:edit) hijack the table cell edit', () => {
            const action = vi.fn();
            sm.register({ key: 'F2', cmd: 'md-block:edit', scope: 'GLOBAL', action });
            sm.setScope('MARKDOWN_TABLE');
            const e = key({ key: 'F2' });
            sm.handleKeyDown(e);
            // The event must pass through untouched so TableEditor's own
            // cell handler can start editing.
            expect(action).not.toHaveBeenCalled();
            expect(e.preventDefault).not.toHaveBeenCalled();
            expect(e.stopPropagation).not.toHaveBeenCalled();
        });

        it('still dispatches other MARKDOWN_TABLE commands (md:save)', () => {
            const action = vi.fn();
            sm.register({ key: 's', ctrl: true, cmd: 'md:save', scope: 'MARKDOWN_TABLE', action });
            sm.setScope('MARKDOWN_TABLE');
            sm.handleKeyDown(key({ key: 's', ctrlKey: true }));
            expect(action).toHaveBeenCalledOnce();
        });
    });

    it('ignores key repeat for the view-mode toggle', () => {
        const action = vi.fn();
        sm.register({ key: 'e', ctrl: true, shift: true, cmd: 'app:toggle-view-mode', scope: 'GLOBAL', action });
        sm.handleKeyDown(key({ key: 'e', ctrlKey: true, shiftKey: true, repeat: true }));
        expect(action).not.toHaveBeenCalled();
    });
});
