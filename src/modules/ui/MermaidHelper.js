import { MERMAID_RECIPES, getRecipe, searchRecipes, detectDiagramType, toMarkdownBlock } from '../utils/MermaidRecipes.js';
import * as Markdown from '../utils/Markdown.js';

/**
 * MermaidHelper — "I know what diagram I want, I just can't remember the syntax".
 *
 * Three panes:
 *   left   — pick a diagram type (searchable); inserts a working template
 *   middle — edit the source, rendered live as you type
 *   right  — the cheat sheet for the diagram you are currently editing,
 *            every entry click-to-insert
 *
 * The cheat sheet follows the CODE, not the button you pressed, so pasting an
 * existing diagram in still shows the right reference.
 */

let _idSeq = 0;

function _injectStyles() {
    if (document.getElementById('mermaid-helper-styles')) return;
    const style = document.createElement('style');
    style.id = 'mermaid-helper-styles';
    style.textContent = `
    #mermaid-helper-overlay {
        position: fixed; inset: 0; z-index: 3000;
        background: rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center;
    }
    .mh-box {
        width: min(1180px, 94vw); height: min(760px, 90vh);
        min-width: 620px; min-height: 380px;
        max-width: 99vw; max-height: 98vh;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 8px;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 12px 40px rgba(0,0,0,0.35);
        position: relative;
        /* Native resize grip in the bottom-right corner. */
        resize: both;
    }
    /* Draggable splitters between the three panes. */
    .mh-split {
        flex: 0 0 5px; cursor: col-resize; background: transparent;
        transition: background 0.12s ease;
    }
    .mh-split:hover, .mh-split.dragging { background: var(--primary-color); opacity: 0.55; }
    /* Horizontal splitter between the source editor and the preview. */
    .mh-split-h {
        flex: 0 0 5px; cursor: row-resize; background: transparent;
        transition: background 0.12s ease;
    }
    .mh-split-h:hover, .mh-split-h.dragging { background: var(--primary-color); opacity: 0.55; }
    /* Focused pane gets a visible ring so Alt+digit navigation is obvious. */
    .mh-pane-focus { box-shadow: inset 0 0 0 2px var(--primary-color); }
    .mh-pane-badge {
        font-size: 9px; opacity: 0.5; border: 1px solid currentColor;
        border-radius: 3px; padding: 0 3px; margin-left: 6px;
        font-family: var(--editor-font-family, monospace);
    }
    /* Keyboard cursor inside a list pane. */
    .mh-type.cursor, .mh-snip.cursor { outline: 2px solid var(--primary-color); outline-offset: -2px; }
    .mh-head {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px; border-bottom: 1px solid var(--border-color);
        background: var(--header-bg);
    }
    .mh-title { font-size: 13px; font-weight: 600; }
    .mh-sub { font-size: 11px; opacity: 0.6; }
    .mh-head-spacer { flex: 1; }
    .mh-body { flex: 1; display: flex; min-height: 0; }

    .mh-types { width: 190px; flex: 0 0 auto; border-right: 1px solid var(--border-color); display: flex; flex-direction: column; min-width: 130px; }
    .mh-search {
        margin: 8px; padding: 6px 8px; font-size: 12px;
        background: var(--bg-color-secondary, var(--bg-color)); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 4px;
    }
    .mh-type-list { flex: 1; overflow-y: auto; padding: 0 6px 8px; }
    .mh-type {
        display: block; width: 100%; text-align: left; cursor: pointer;
        padding: 7px 9px; margin-bottom: 3px; border-radius: 5px;
        background: transparent; color: var(--text-color);
        border: 1px solid transparent; font-size: 12px; line-height: 1.35;
    }
    .mh-type:hover { background: var(--hover-color); }
    .mh-type.sel { border-color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 12%, transparent); }
    .mh-type-name { font-weight: 600; display: block; }
    .mh-type-desc { font-size: 10px; opacity: 0.6; }

    .mh-center { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .mh-editor {
        height: 42%; flex: 0 0 auto; resize: none; border: none; outline: none;
        padding: 10px 12px; font-family: var(--editor-font-family, monospace);
        font-size: 12.5px; line-height: 1.6; tab-size: 2;
        background: var(--bg-color); color: var(--text-color);
        border-bottom: 1px solid var(--border-color);
    }
    .mh-preview {
        flex: 1; overflow: auto; padding: 12px;
        display: flex; align-items: flex-start; justify-content: center;
        background: var(--bg-color-secondary, var(--bg-color));
    }
    .mh-preview svg { max-width: 100%; }
    .mh-error {
        color: var(--error-color, #e5534b); font-size: 12px;
        font-family: var(--editor-font-family, monospace); white-space: pre-wrap;
        align-self: flex-start; text-align: left;
    }

    .mh-cheat { width: 290px; flex: 0 0 auto; border-left: 1px solid var(--border-color); display: flex; flex-direction: column; min-width: 180px; }
    .mh-cheat-head { padding: 8px 12px; font-size: 11px; font-weight: 600; opacity: 0.75; border-bottom: 1px solid var(--border-color); }
    .mh-cheat-list { flex: 1; overflow-y: auto; padding: 6px; }
    .mh-snip {
        width: 100%; text-align: left; cursor: pointer; display: block;
        padding: 6px 8px; margin-bottom: 4px; border-radius: 5px;
        background: transparent; border: 1px solid var(--border-color); color: var(--text-color);
    }
    .mh-snip:hover { background: var(--hover-color); border-color: var(--primary-color); }
    .mh-snip-label { font-size: 11px; font-weight: 600; display: block; }
    .mh-snip-code {
        font-family: var(--editor-font-family, monospace); font-size: 10.5px;
        opacity: 0.75; white-space: pre-wrap; display: block; margin-top: 2px;
    }
    .mh-snip-note { font-size: 10px; opacity: 0.55; display: block; margin-top: 2px; }

    .mh-foot {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px; border-top: 1px solid var(--border-color); background: var(--header-bg);
    }
    .mh-hint { flex: 1; font-size: 11px; opacity: 0.55; }
    .mh-btn {
        padding: 6px 14px; font-size: 12px; cursor: pointer; border-radius: 5px;
        background: var(--bg-color); color: var(--text-color); border: 1px solid var(--border-color);
    }
    .mh-btn:hover { background: var(--hover-color); border-color: var(--primary-color); }
    .mh-btn-primary { background: var(--primary-color); color: #fff; border-color: var(--primary-color); font-weight: 600; }
    .mh-btn-primary:hover { filter: brightness(1.08); background: var(--primary-color); }
    `;
    document.head.appendChild(style);
}

export const MermaidHelper = {
    /**
     * @param {(markdown: string) => void} onInsert  receives a fenced ```mermaid block
     * @param {string} [initialCode]  existing diagram source when editing one
     */
    show(onInsert, initialCode = '') {
        _injectStyles();
        document.getElementById('mermaid-helper-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'mermaid-helper-overlay';

        const box = document.createElement('div');
        box.className = 'mh-box';

        // ── header ──
        const head = document.createElement('div');
        head.className = 'mh-head';
        head.innerHTML = `<span class="mh-title">Mermaid 図の作成</span>
            <span class="mh-sub">種類を選ぶと雛形が入ります。右の一覧はクリックで挿入できます。</span>
            <span class="mh-head-spacer"></span>
            <span class="mh-sub">Alt+1〜4 でペイン移動 · ↑↓ で選択</span>`;

        // ── left: diagram types ──
        const types = document.createElement('div');
        types.className = 'mh-types';
        const search = document.createElement('input');
        search.className = 'mh-search';
        search.type = 'text';
        search.placeholder = 'Search diagram types…';
        const typeList = document.createElement('div');
        typeList.className = 'mh-type-list';
        types.append(search, typeList);

        // ── center: source + live preview ──
        const center = document.createElement('div');
        center.className = 'mh-center';
        const editor = document.createElement('textarea');
        editor.className = 'mh-editor';
        editor.spellcheck = false;
        editor.value = initialCode || '';
        const preview = document.createElement('div');
        preview.className = 'mh-preview';
        center.append(editor, preview);

        // ── right: cheat sheet ──
        const cheat = document.createElement('div');
        cheat.className = 'mh-cheat';
        const cheatHead = document.createElement('div');
        cheatHead.className = 'mh-cheat-head';
        // Pane numbers so Alt+N is discoverable without reading the header hint.
        search.placeholder = 'Search diagram types…  (Alt+1)';
        editor.title = 'Mermaid source (Alt+2)';
        const cheatList = document.createElement('div');
        cheatList.className = 'mh-cheat-list';
        cheat.append(cheatHead, cheatList);

        // ── footer ──
        const foot = document.createElement('div');
        foot.className = 'mh-foot';
        const hint = document.createElement('span');
        hint.className = 'mh-hint';
        hint.textContent = 'Ctrl+Enter to insert · Esc to close';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'mh-btn';
        cancelBtn.textContent = 'Cancel';
        const insertBtn = document.createElement('button');
        insertBtn.className = 'mh-btn mh-btn-primary';
        insertBtn.textContent = 'Insert';
        foot.append(hint, cancelBtn, insertBtn);

        // Splitters: vertical between the three columns, horizontal between the
        // source editor and its preview.
        const splitL = document.createElement('div');
        splitL.className = 'mh-split';
        splitL.title = 'Drag to resize';
        const splitR = document.createElement('div');
        splitR.className = 'mh-split';
        splitR.title = 'Drag to resize';
        const splitH = document.createElement('div');
        splitH.className = 'mh-split-h';
        splitH.title = 'Drag to resize';
        center.insertBefore(splitH, preview);

        const body = document.createElement('div');
        body.className = 'mh-body';
        body.append(types, splitL, center, splitR, cheat);
        box.append(head, body, foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        _makeDragger(splitL, 'x', (dx) => {
            types.style.width = `${Math.max(130, types.getBoundingClientRect().width + dx)}px`;
        });
        _makeDragger(splitR, 'x', (dx) => {
            cheat.style.width = `${Math.max(180, cheat.getBoundingClientRect().width - dx)}px`;
        });
        _makeDragger(splitH, 'y', (dy) => {
            const h = editor.getBoundingClientRect().height + dy;
            const max = center.getBoundingClientRect().height - 120;
            editor.style.height = `${Math.min(Math.max(80, h), Math.max(80, max))}px`;
        });

        // ── behaviour ─────────────────────────────────────────────────────────
        let selectedId = detectDiagramType(editor.value) || null;

        const renderTypeList = () => {
            typeList.innerHTML = '';
            for (const r of searchRecipes(search.value)) {
                const btn = document.createElement('button');
                btn.className = 'mh-type' + (r.id === selectedId ? ' sel' : '');
                btn.innerHTML = `<span class="mh-type-name">${r.title}</span><span class="mh-type-desc">${r.subtitle}</span>`;
                btn.onclick = () => {
                    // Replacing existing work should be deliberate.
                    if (editor.value.trim() && !confirm('Replace the current content with this template?')) return;
                    editor.value = r.template;
                    selectedId = r.id;
                    renderTypeList();
                    renderCheat();
                    schedulePreview();
                    editor.focus();
                };
                typeList.appendChild(btn);
            }
        };

        const renderCheat = () => {
            const recipe = getRecipe(selectedId);
            cheatList.innerHTML = '';
            if (!recipe) {
                cheatHead.textContent = 'Syntax reference';
                cheatList.innerHTML = '<div style="padding:10px;font-size:11px;opacity:0.6;">Pick a diagram type on the left to see the syntax it supports.</div>';
                return;
            }
            cheatHead.innerHTML = `${_escape(recipe.title)}  syntax (click to insert)<span class="mh-pane-badge">Alt+3</span>`;
            for (const s of recipe.snippets) {
                const btn = document.createElement('button');
                btn.className = 'mh-snip';
                btn.innerHTML = `<span class="mh-snip-label">${s.label}</span>`
                    + `<code class="mh-snip-code">${_escape(s.code)}</code>`
                    + (s.note ? `<span class="mh-snip-note">${_escape(s.note)}</span>` : '');
                btn.onclick = () => { _insertAtCursor(editor, s.code); schedulePreview(); };
                cheatList.appendChild(btn);
            }
        };

        let previewTimer = null;
        const schedulePreview = () => {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(renderPreview, 300);
        };

        const renderPreview = async () => {
            const code = editor.value.trim();
            preview.innerHTML = '';
            if (!code) return;
            // Render into a detached node so a syntax error can't inject a
            // half-drawn diagram into the panel.
            const host = document.createElement('div');
            host.className = 'mermaid';
            host.textContent = code;
            host.id = `mh-preview-${++_idSeq}`;
            preview.appendChild(host);
            try {
                await Markdown.renderMermaid(preview);
                // mermaid.run leaves the source in place when it fails.
                if (!preview.querySelector('svg')) throw new Error('Could not render');
            } catch (e) {
                preview.innerHTML = '';
                const err = document.createElement('div');
                err.className = 'mh-error';
                err.textContent = 'Syntax error: ' + (e && e.message ? e.message : String(e));
                preview.appendChild(err);
            }
        };

        // The cheat sheet follows what is actually in the editor.
        editor.addEventListener('input', () => {
            const detected = detectDiagramType(editor.value);
            if (detected && detected !== selectedId) {
                selectedId = detected;
                renderTypeList();
                renderCheat();
            }
            schedulePreview();
        });
        search.addEventListener('input', renderTypeList);

        const close = () => {
            clearTimeout(previewTimer);
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
        };
        const insert = () => {
            const code = editor.value.trim();
            if (!code) { close(); return; }
            close();
            if (typeof onInsert === 'function') onInsert(toMarkdownBlock(code));
        };

        // ── pane navigation ───────────────────────────────────────────────────
        // Alt+1..4 jumps between panes; ↑/↓ walks the list inside a list pane
        // (with the cursor scrolled into view), Enter activates it.
        const panes = [
            { el: types, focus: () => search.focus(), list: () => typeList },
            { el: center, focus: () => editor.focus(), list: () => null },
            { el: cheat, focus: () => cheat.focus(), list: () => cheatList },
            { el: foot, focus: () => insertBtn.focus(), list: () => null },
        ];
        cheat.tabIndex = -1;
        let paneIdx = 0;
        const cursor = new WeakMap(); // list element -> index

        const focusPane = (i) => {
            paneIdx = (i + panes.length) % panes.length;
            panes.forEach((p, n) => p.el.classList.toggle('mh-pane-focus', n === paneIdx));
            panes[paneIdx].focus();
        };

        const moveCursor = (delta) => {
            const list = panes[paneIdx].list();
            if (!list) return false;
            const items = Array.from(list.children).filter(c => c.tagName === 'BUTTON');
            if (items.length === 0) return false;
            let idx = cursor.get(list);
            idx = (idx == null ? -1 : idx) + delta;
            idx = Math.max(0, Math.min(items.length - 1, idx));
            cursor.set(list, idx);
            items.forEach((el, n) => el.classList.toggle('cursor', n === idx));
            // Auto-scroll so the cursor is always visible.
            items[idx].scrollIntoView({ block: 'nearest' });
            return true;
        };

        const activateCursor = () => {
            const list = panes[paneIdx].list();
            if (!list) return false;
            const items = Array.from(list.children).filter(c => c.tagName === 'BUTTON');
            const idx = cursor.get(list);
            if (idx == null || !items[idx]) return false;
            items[idx].click();
            return true;
        };

        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); insert(); return; }

            if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-4]$/.test(e.key)) {
                e.preventDefault(); e.stopPropagation();
                focusPane(parseInt(e.key, 10) - 1);
                return;
            }
            // Arrow keys drive the list panes; inside the textarea they must
            // still move the caret, so only intercept for list panes.
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && panes[paneIdx].list()) {
                if (moveCursor(e.key === 'ArrowDown' ? 1 : -1)) {
                    e.preventDefault(); e.stopPropagation();
                }
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey && panes[paneIdx].list()) {
                if (activateCursor()) { e.preventDefault(); e.stopPropagation(); }
            }
        };
        // Clicking inside a pane makes it the active one for keyboard nav.
        panes.forEach((p, i) => p.el.addEventListener('mousedown', () => {
            paneIdx = i;
            panes.forEach((q, n) => q.el.classList.toggle('mh-pane-focus', n === i));
        }));
        document.addEventListener('keydown', onKey, true);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
        cancelBtn.onclick = close;
        insertBtn.onclick = insert;

        renderTypeList();
        renderCheat();
        if (editor.value) schedulePreview();
        // Land in the editor when reopening an existing diagram, otherwise in
        // the type picker where the user has to choose first.
        setTimeout(() => focusPane(editor.value ? 1 : 0), 0);
    },
};

function _escape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Turn `handle` into a drag bar. `onDelta` receives the movement SINCE THE LAST
 * event (not since the drag started), so callers can size relative to the
 * element's current box without tracking a baseline.
 */
function _makeDragger(handle, axis, onDelta) {
    handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        let last = axis === 'x' ? e.clientX : e.clientY;
        handle.classList.add('dragging');
        // Suppress text selection / iframe capture while dragging.
        const prevUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';

        const move = (ev) => {
            const cur = axis === 'x' ? ev.clientX : ev.clientY;
            const delta = cur - last;
            last = cur;
            if (delta) onDelta(delta);
        };
        const up = () => {
            handle.classList.remove('dragging');
            document.body.style.userSelect = prevUserSelect;
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    });
}

/** Insert `text` at the caret, on its own line, and keep the caret after it. */
function _insertAtCursor(textarea, text) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    // Snippets are whole lines; make sure we don't glue them onto existing text.
    const before = value.slice(0, start);
    const needsNl = before.length > 0 && !before.endsWith('\n');
    const insert = (needsNl ? '\n' : '') + text;
    textarea.value = before + insert + value.slice(end);
    const pos = start + insert.length;
    textarea.setSelectionRange(pos, pos);
    textarea.focus();
}
