import { State } from './Store.js';
import { SHORTCUTS } from './ShortcutDefinitions.js';

export class ShortcutManager {
    constructor() {
        this.shortcuts = [];
        this.currentScope = 'GLOBAL';
        this.scopes = Object.keys(SHORTCUTS);

        this.loadShortcuts();
        this.setupListeners();
    }

    /**
     * Load shortcuts, merging defaults with user overrides from localStorage
     */
    loadShortcuts() {
        const defaults = [];
        Object.entries(SHORTCUTS).forEach(([scope, list]) => {
            list.forEach((s, index) => {
                defaults.push({
                    ...s,
                    scope,
                    // Unique ID based on scope and command. 
                    // Note: If multiple shortcuts exist for same command in same scope, index is needed.
                    id: `${scope}:${s.cmd}:${index}`
                });
            });
        });

        const overrides = JSON.parse(localStorage.getItem('user_shortcuts') || '{}');

        this.shortcuts = defaults.map(s => {
            if (overrides[s.id]) {
                return { ...s, ...overrides[s.id] };
            }
            return s;
        });
    }

    /**
     * Update a specific shortcut mapping and persist it
     */
    updateShortcut(id, newMapping) {
        // newMapping: { key, ctrl, shift, alt }
        const overrides = JSON.parse(localStorage.getItem('user_shortcuts') || '{}');
        overrides[id] = newMapping;
        localStorage.setItem('user_shortcuts', JSON.stringify(overrides));
        this.loadShortcuts();

        // Notify UI that shortcuts changed
        window.dispatchEvent(new CustomEvent('shortcutsChanged'));
    }

    /**
     * Restore all shortcuts to their original definitions
     */
    resetToDefaults() {
        localStorage.removeItem('user_shortcuts');
        this.loadShortcuts();
        window.dispatchEvent(new CustomEvent('shortcutsChanged'));
    }

    register(shortcut) {
        // Runtime registration (e.g. by modules/plugins)
        if (!shortcut.scope) shortcut.scope = 'GLOBAL';

        let found = false;
        this.shortcuts.forEach(existing => {
            if (existing.cmd === shortcut.cmd && existing.scope === shortcut.scope) {
                existing.action = shortcut.action;
                if (shortcut.description) existing.description = shortcut.description;
                found = true;
            }
        });

        if (!found) {
            this.shortcuts.push(shortcut);
        }
    }

    unregisterScope(scope) {
        this.shortcuts = this.shortcuts.filter(s => s.scope !== scope);
    }

    setScope(scope) {
        if (this.scopes.includes(scope)) {
            this.currentScope = scope;
        }
    }

    /**
     * Which shortcut scope does focusing/clicking `target` imply?
     *
     * Pure: it reads the DOM ancestry of `target` plus the current scope, and
     * returns the scope to switch to — or `null` meaning "leave it alone",
     * which some contexts deliberately require.
     *
     * @param {Element} target
     * @returns {string|null}
     */
    resolveScope(target) {
        if (!target || typeof target.closest !== 'function') return null;

        if (target.closest('.visual-table-editor')) return 'MARKDOWN_TABLE';
        // The virtualized explorer renders rows inside #file-list (older markup
        // used #explorer-list-container, kept for safety). Without this the
        // scope fell back to GLOBAL while the explorer had focus and F2 hit
        // GLOBAL's md-block:edit instead of EXPLORER's explorer:rename.
        if (target.closest('#file-list') || target.closest('#explorer-list-container') || target.closest('#explorer-files-panel')) return 'EXPLORER';

        // The row-number strip is a SIBLING of the scrolling grid, not a child,
        // so it must be matched explicitly — otherwise clicking a row number
        // dropped the scope to GLOBAL and killed the CSV keyboard nav
        // (Shift+Arrow range selection).
        if (target.closest('.csv-grid-virtual-container') || target.closest('.csv-row-strip')) {
            return (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') ? 'CSV_EDIT' : 'CSV';
        }

        if (target.closest('.md-block')) {
            if (target.tagName === 'TEXTAREA' || target.isContentEditable) {
                // Block editor: keep the MARKDOWN(_TABLE) scope so Ctrl+Enter
                // (save), Escape (cancel) and the formatting shortcuts fire.
                // They are all Ctrl/Escape combos, so typing is unaffected.
                if (this.currentScope === 'MARKDOWN' || this.currentScope === 'MARKDOWN_TABLE') return null;
                return 'EDITOR';
            }
            return 'MARKDOWN_BLOCK';
        }

        if (target.closest('.plain-text-editor') || target.closest('.block-editor')) {
            if (this.currentScope === 'AI_REVIEW'
                || this.currentScope === 'MARKDOWN'
                || this.currentScope === 'MARKDOWN_TABLE') return null;
            return 'EDITOR';
        }

        if (target.closest('#search-panel')) return 'SEARCH';
        if (target.closest('.ai-review-overlay')) return 'AI_REVIEW';
        if (target.closest('.node-source-editor') || target.closest('.structure-editor')) return 'STRUCTURE_EDIT';

        // Main CodeMirror 6 editor. `.plain-text-editor` above is a leftover
        // from the pre-CM6 <textarea> editor and no longer matches anything,
        // which left EDITOR scope unreachable — so Ctrl+Tab / F12 / Ctrl+\
        // silently did nothing while editing.
        if (target.closest('.cm-editor-wrapper')) return 'EDITOR';

        // An AI review owns the keyboard until it is dismissed.
        return this.currentScope === 'AI_REVIEW' ? null : 'GLOBAL';
    }

    setupListeners() {
        window.addEventListener('keydown', (e) => {
            this.handleKeyDown(e);
        }, true);

        // Auto-scope detection based on focus. The DECISION lives in
        // resolveScope() (pure, unit-testable); this only applies it.
        const updateScope = (e) => {
            const target = e.target;
            if (!target) return;
            const scope = this.resolveScope(target);
            if (scope) this.setScope(scope);
        };

        document.addEventListener('focusin', updateScope);
        document.addEventListener('mousedown', updateScope);
    }

    handleKeyDown(e) {
        // WebView2 on some Windows / Japanese-layout environments reports
        // e.key === 'Unidentified' (or 'Process' while an IME is composing) for
        // the function keys (F1–F12), which made every F-key shortcut dead
        // (F2 rename / F2 edit block) while letters, Enter and arrows kept
        // working. Fall back to e.code (physical key, layout-independent) and
        // then e.keyCode (legacy but reliable in WebView2) for the function
        // keys only.
        let key = e.key;
        if (!key || key === 'Unidentified' || key === 'Process') {
            if (e.code && /^F\d{1,2}$/.test(e.code)) {
                key = e.code;
            } else if (e.keyCode >= 112 && e.keyCode <= 123) {
                // F1=112 … F12=123
                key = 'F' + (e.keyCode - 111);
            }
        }
        if (!key) return;

        // Skip if recording a new shortcut in settings
        if (window._isRecordingShortcut) return;

        // Inline rename input (explorer F2) owns Enter/Escape/typing itself:
        // Enter must COMMIT the rename, not match explorer:nav (which would
        // open the file) or any GLOBAL shortcut. Let the keydown reach the
        // input by returning without preventDefault/stopPropagation.
        if (e.target && e.target.classList && e.target.classList.contains('rename-input')) return;

        // When focus is inside the search panel, let the modal handle all keys itself.
        // Only allow Ctrl+F / Ctrl+H through (to re-open or toggle the modal).
        if (this.currentScope === 'SEARCH') {
            const ctrl = e.ctrlKey || e.metaKey;
            const k = key.toLowerCase();
            if (ctrl && (k === 'f' || k === 'h')) {
                // fall through — App.js handles app:search / open with replace
            } else {
                return;
            }
        }

        const ctrl = e.ctrlKey || e.metaKey;
        const shift = e.shiftKey;
        const alt = e.altKey;
        const eventKey = key.toLowerCase();

        const matches = this.shortcuts.filter(s => {
            if (!s.key) return false;
            const shortcutKey = s.key.toLowerCase();
            return eventKey === shortcutKey &&
                !!s.ctrl === ctrl &&
                !!s.shift === shift &&
                !!s.alt === alt &&
                (s.scope === 'GLOBAL' || s.scope === this.currentScope);
        });

        const match = matches.find(s => s.scope === this.currentScope) || matches.find(s => s.scope === 'GLOBAL');

        if (match) {
            // F2 inside the markdown TABLE editor starts cell editing
            // (TableEditor.handleTableKey). Don't let the GLOBAL F2
            // (md-block:edit) hijack it — it would open a nested block
            // editor instead of editing the focused cell. Let the event
            // reach the cell's own handler.
            if (this.currentScope === 'MARKDOWN_TABLE' && match.cmd === 'md-block:edit') return;
            // Special case: Allow native clipboard behavior for normal inputs
            // so that 'paste' events (with image data) can fire.
            if (match.cmd === 'app:copy' || match.cmd === 'app:paste' || match.cmd === 'app:cut') {
                const target = e.target;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && !target.classList.contains('plain-text-editor')) {
                    return; // Let browser handle it naturally
                }
            }
            // While a CSV cell is being edited (F2 opens an overlay <textarea>)
            // undo/redo belong to the text field, not to the grid model —
            // otherwise Ctrl+Z threw away the previous grid edit mid-typing.
            if (this.currentScope === 'CSV_EDIT' && (match.cmd === 'app:undo' || match.cmd === 'app:redo')) {
                const target = e.target;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
                    return; // Let browser handle it naturally
                }
            }

            if (typeof match.action === 'function') {
                if (this.currentScope === 'MARKDOWN_TABLE' &&
                    (match.cmd === 'app:copy' || match.cmd === 'app:paste' || match.cmd === 'app:cut')) {
                    return;
                }
                if (e.repeat && match.cmd === 'app:toggle-view-mode') return;
                e.preventDefault();
                e.stopPropagation();
                match.action(e);
            } else if (match.cmd) {
                if (e.repeat && match.cmd === 'app:toggle-view-mode') return;
                e.preventDefault();
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent('shortcutTriggered', {
                    detail: { command: match.cmd, originalEvent: e }
                }));
            }
        }
    }
}

export const shortcuts = new ShortcutManager();
