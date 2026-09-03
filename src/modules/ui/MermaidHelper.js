import { MERMAID_RECIPES, getRecipe, searchRecipes, detectDiagramType, toMarkdownBlock } from '../utils/MermaidRecipes.js';
import { t } from '../utils/I18n.js';
import * as Markdown from '../utils/Markdown.js';
import { showConfirm } from './Dialog.js';

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

    /* 全画面。フローチャートは横に伸びるので、窓が小さいと編集にならない。 */
    .mh-box.mh-max {
        width: 100vw; height: 100vh;
        max-width: 100vw; max-height: 100vh;
        border-radius: 0; resize: none;
    }

    /* プレビューを右へ。縦に積むと、横長の図はどちらも狭くなる。 */
    .mh-center.mh-side { flex-direction: row; }
    .mh-center.mh-side > .mh-editor { height: auto; width: 46%; }
    .mh-center.mh-side > .mh-split-h { cursor: col-resize; }

    /* 畳んだ列。図の編集中は種類も部品も要らないことが多い。 */
    .mh-types.mh-collapsed, .mh-cheat.mh-collapsed { display: none; }
    .mh-types.mh-collapsed + .mh-split,
    .mh-split.mh-collapsed { display: none; }

    .mh-head-btn {
        flex: 0 0 auto; padding: 3px 8px; font-size: 11px;
        background: transparent; color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 4px;
        cursor: pointer; white-space: nowrap;
    }
    .mh-head-btn:hover { background: var(--hover-color); }
    .mh-head-btn.on { border-color: var(--primary-color); color: var(--primary-color); }
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

        // Whatever had the keyboard before this dialog took it — typically the
        // markdown block editor. close() hands it back, otherwise dismissing
        // the dialog left the block editor unfocused and typing went nowhere.
        const returnFocusTo = document.activeElement;

        const overlay = document.createElement('div');
        overlay.id = 'mermaid-helper-overlay';

        const box = document.createElement('div');
        box.className = 'mh-box';

        // ── header ──
        const head = document.createElement('div');
        head.className = 'mh-head';
        head.innerHTML = `<span class="mh-title">${_escape(t('Insert a Mermaid diagram'))}</span>
            <span class="mh-sub">${_escape(t('Pick a type to insert its skeleton. Click anything on the right to add it.'))}</span>
            <span class="mh-head-spacer"></span>`;

        // 表示の切り替え。図の種類によって欲しい形が違うので、固定しない。
        const mkHeadBtn = (label, title) => {
            const b = document.createElement('button');
            b.className = 'mh-head-btn';
            b.type = 'button';
            b.textContent = label;
            b.title = title;
            return b;
        };
        const typesBtn = mkHeadBtn(t('Types'), t('Show or hide the diagram types'));
        const partsBtn = mkHeadBtn(t('Parts'), t('Show or hide the syntax list'));
        const sideBtn = mkHeadBtn(t('Side preview'), t('Put the preview beside the source instead of below'));
        const maxBtn = mkHeadBtn(t('Full screen'), t('Fill the window'));
        head.append(typesBtn, partsBtn, sideBtn, maxBtn);

        // ── left: diagram types ──
        const types = document.createElement('div');
        types.className = 'mh-types';
        const search = document.createElement('input');
        search.className = 'mh-search';
        search.type = 'text';
        search.placeholder = t('Search diagram types…');
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
        search.placeholder = t('Search diagram types…  (Alt+1)');
        editor.title = t('Mermaid source (Alt+2)');
        const cheatList = document.createElement('div');
        cheatList.className = 'mh-cheat-list';
        cheat.append(cheatHead, cheatList);

        // ── footer ──
        const foot = document.createElement('div');
        foot.className = 'mh-foot';
        const hint = document.createElement('span');
        hint.className = 'mh-hint';
        hint.textContent = t('Ctrl+Enter to insert · Esc to close');
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'mh-btn';
        cancelBtn.textContent = t('Cancel');
        const insertBtn = document.createElement('button');
        insertBtn.className = 'mh-btn mh-btn-primary';
        insertBtn.textContent = t('Insert');
        foot.append(hint, cancelBtn, insertBtn);

        // Splitters: vertical between the three columns, horizontal between the
        // source editor and its preview.
        const splitL = document.createElement('div');
        splitL.className = 'mh-split';
        splitL.title = t('Drag to resize');
        const splitR = document.createElement('div');
        splitR.className = 'mh-split';
        splitR.title = t('Drag to resize');
        const splitH = document.createElement('div');
        splitH.className = 'mh-split-h';
        splitH.title = t('Drag to resize');
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
        // 上下と左右で掴む軸が変わる。両方受け取って、いまの向きで使う。
        _makeDragger(splitH, 'both', (dx, dy) => {
            if (center.classList.contains('mh-side')) {
                const w = editor.getBoundingClientRect().width + dx;
                const max = center.getBoundingClientRect().width - 160;
                editor.style.width = `${Math.min(Math.max(160, w), Math.max(160, max))}px`;
            } else {
                const h = editor.getBoundingClientRect().height + dy;
                const max = center.getBoundingClientRect().height - 120;
                editor.style.height = `${Math.min(Math.max(80, h), Math.max(80, max))}px`;
            }
        });

        // ── 表示の切り替え ────────────────────────────────────────────────
        const syncBtn = (btn, on) => btn.classList.toggle('on', on);

        typesBtn.onclick = () => {
            const off = types.classList.toggle('mh-collapsed');
            splitL.classList.toggle('mh-collapsed', off);
            syncBtn(typesBtn, !off);
        };
        partsBtn.onclick = () => {
            const off = cheat.classList.toggle('mh-collapsed');
            splitR.classList.toggle('mh-collapsed', off);
            syncBtn(partsBtn, !off);
        };
        syncBtn(typesBtn, true);
        syncBtn(partsBtn, true);

        sideBtn.onclick = () => {
            const side = center.classList.toggle('mh-side');
            // 掴んで決めた寸法は向きが変わると意味を失う。縦に引いた高さが
            // 横向きの幅として効くと、開いた瞬間に潰れて見える。
            editor.style.height = '';
            editor.style.width = '';
            syncBtn(sideBtn, side);
        };

        maxBtn.onclick = () => {
            const max = box.classList.toggle('mh-max');
            syncBtn(maxBtn, max);
        };

        // ── behaviour ─────────────────────────────────────────────────────────
        let selectedId = detectDiagramType(editor.value) || null;

        const renderTypeList = () => {
            typeList.innerHTML = '';
            for (const r of searchRecipes(search.value)) {
                const btn = document.createElement('button');
                btn.className = 'mh-type' + (r.id === selectedId ? ' sel' : '');
                btn.innerHTML = `<span class="mh-type-name">${r.title}</span><span class="mh-type-desc">${r.subtitle}</span>`;
                btn.onclick = async () => {
                    // Replacing existing work should be deliberate.
                    if (editor.value.trim()
                        && !(await showConfirm(t('Replace the current content with this template?'), {
                            title: 'Mermaid', kind: 'warning', okLabel: 'Replace',
                        }))) return;
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
                cheatHead.textContent = t('Syntax reference');
                cheatList.innerHTML = '<div style="padding:10px;font-size:11px;opacity:0.6;">Pick a diagram type on the left to see the syntax it supports.</div>';
                return;
            }
            cheatHead.innerHTML = `${_escape(recipe.title)}  syntax (click to insert)<span class="mh-pane-badge">Alt+3</span>`;
            for (const s of recipe.snippets) {
                const btn = document.createElement('button');
                btn.className = 'mh-snip';
                // Translated at RENDER, not in the table: MermaidRecipes stays
                // plain data, and a language change re-renders rather than
                // needing the table rebuilt.
                btn.innerHTML = `<span class="mh-snip-label">${t(s.label)}</span>`
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
                err.textContent = t('Syntax error: ') + (e && e.message ? e.message : String(e));
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
            if (returnFocusTo && returnFocusTo.isConnected
                && typeof returnFocusTo.focus === 'function') {
                returnFocusTo.focus({ preventScroll: true });
            }
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

            // mermaid は字下げで入れ子を表すので、ソース欄では Tab を文字と
            // して受ける。既定のフォーカス移動のままだと、押した瞬間に欄から
            // 出てしまい、空白を手で並べることになる。
            //
            // 欄から出る手段は残す。Alt+1..4 と Esc があり、Shift+Tab は
            // 既定のまま前の要素へ戻る。閉じ込めない。
            if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
                && document.activeElement === editor) {
                e.preventDefault();
                e.stopPropagation();
                _indentSelection(editor);
                schedulePreview();
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
/**
 * Drag a splitter.
 *
 * `axis` is 'x', 'y', or 'both'. The preview splitter needs 'both' because the
 * pane can sit under the source or beside it, and which delta matters is only
 * known at drag time. The callback always receives (dx, dy); single-axis
 * draggers get 0 for the one they do not use.
 */
function _makeDragger(handle, axis, onDelta) {
    handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        let lastX = e.clientX;
        let lastY = e.clientY;
        handle.classList.add('dragging');
        // Suppress text selection / iframe capture while dragging.
        const prevUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';

        const move = (ev) => {
            const dx = ev.clientX - lastX;
            const dy = ev.clientY - lastY;
            lastX = ev.clientX;
            lastY = ev.clientY;
            if (axis === 'x') {
                if (dx) onDelta(dx, 0);
            } else if (axis === 'y') {
                if (dy) onDelta(0, dy);
            } else if (dx || dy) {
                onDelta(dx, dy);
            }
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

/**
 * Indent at the caret with two spaces.
 *
 * Spaces rather than a tab character: mermaid does not care, but the source
 * ends up inside a fenced block in the document, where a real tab renders at
 * whatever width the reader's viewer picks. Two spaces match the skeletons
 * this dialog inserts.
 *
 * With a selection spanning lines, every line moves — indenting a subgraph
 * one line at a time is the tedious part.
 */
function _indentSelection(textarea) {
    const INDENT = '  ';
    const { selectionStart: start, selectionEnd: end, value } = textarea;

    if (start === end) {
        textarea.value = value.slice(0, start) + INDENT + value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + INDENT.length;
        return;
    }

    // Grow the range to whole lines so partial selections still indent
    // sensibly rather than injecting spaces mid-word.
    const from = value.lastIndexOf('\n', start - 1) + 1;
    const to = value.indexOf('\n', end);
    const tail = to === -1 ? value.length : to;

    const block = value.slice(from, tail);
    const shifted = block.split('\n').map((line) => INDENT + line).join('\n');

    textarea.value = value.slice(0, from) + shifted + value.slice(tail);
    textarea.selectionStart = start + INDENT.length;
    textarea.selectionEnd = end + INDENT.length * block.split('\n').length;
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
