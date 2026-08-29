// Ctrl+N: pick the type of the new file before creating it.
// Flat, keyboard-first picker: ←/→ move between the format cards, Enter
// confirms, the number keys / the type's letter jump straight to it, Esc
// cancels. For Markdown files a template list is shown as well (↑/↓ or Tab
// walk it, Enter confirms the highlighted template), and new templates can
// be registered straight from the modal.

import { MarkdownTemplates } from '../utils/MarkdownTemplates.js';
import { t } from '../utils/I18n.js';
import { showAlert } from './Dialog.js';

const TYPES = [
    {
        ext: 'txt',
        label: t('Text'),
        hint: 'Plain text',
        key: '1',
        // Simple lined-document glyph.
        icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>',
    },
    {
        ext: 'md',
        label: t('Markdown'),
        hint: 'Headings, tables, live preview',
        key: '2',
        // The Markdown "M▾" mark.
        icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M6 15.5v-7l3 3.5 3-3.5v7"/><path d="M16.5 8.5v5"/><path d="M14.5 11.5l2 2 2-2"/></svg>',
    },
];

function _injectStyles() {
    if (document.getElementById('new-file-modal-styles')) return;
    const style = document.createElement('style');
    style.id = 'new-file-modal-styles';
    style.textContent = `
    #new-file-overlay .nf-title { font-size: 13px; font-weight: 600; }
    #new-file-overlay .nf-sub { font-size: 11px; opacity: 0.6; margin-top: 2px; }
    #new-file-overlay .nf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    #new-file-overlay .nf-card {
        display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
        padding: 14px 14px 12px; cursor: pointer; text-align: left;
        background: var(--bg-color-secondary, var(--bg-color));
        color: var(--text-color);
        border: 1px solid var(--border-color);
        border-radius: 6px;
        transition: background .12s ease, border-color .12s ease;
        position: relative;
    }
    #new-file-overlay .nf-card:hover { background: var(--hover-color); }
    #new-file-overlay .nf-card.sel {
        border-color: var(--primary-color);
        background: color-mix(in srgb, var(--primary-color) 10%, transparent);
    }
    #new-file-overlay .nf-ico { color: var(--primary-color); line-height: 0; }
    #new-file-overlay .nf-name { font-size: 13px; font-weight: 600; }
    #new-file-overlay .nf-ext { font-size: 11px; opacity: 0.6; font-family: var(--font-mono, monospace); }
    #new-file-overlay .nf-hint { font-size: 11px; opacity: 0.6; }
    #new-file-overlay .nf-key {
        position: absolute; top: 8px; right: 10px;
        font-size: 10px; opacity: 0.5; font-family: var(--font-mono, monospace);
        border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; line-height: 1.4;
    }
    #new-file-overlay .nf-foot { font-size: 11px; opacity: 0.55; }

    /* Markdown template picker */
    #new-file-overlay .nf-tpl { display: none; flex-direction: column; gap: 6px; }
    #new-file-overlay .nf-tpl.visible { display: flex; }
    #new-file-overlay .nf-tpl-label { font-size: 11px; font-weight: 600; opacity: 0.7; }
    #new-file-overlay .nf-tpl-head { display: flex; align-items: center; gap: 6px; }
    #new-file-overlay .nf-tpl-spacer { flex: 1; }
    #new-file-overlay .nf-tpl-btn {
        padding: 4px 10px; font-size: 11px; cursor: pointer; white-space: nowrap;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 4px;
    }
    #new-file-overlay .nf-tpl-btn:hover { background: var(--hover-color); }
    #new-file-overlay .nf-tpl-btn.nf-tpl-del { color: #d9534f; border-color: #d9534f; background: none; }
    #new-file-overlay .nf-tpl-btn.nf-tpl-del:hover { background: color-mix(in srgb, #d9534f 12%, transparent); }
    #new-file-overlay .nf-tpl-list {
        display: flex; flex-direction: column; gap: 2px;
        max-height: 180px; overflow-y: auto;
        border: 1px solid var(--border-color); border-radius: 4px;
        background: var(--bg-color-secondary, var(--bg-color));
    }
    #new-file-overlay .nf-tpl-item {
        display: flex; align-items: center; gap: 8px; text-align: left;
        padding: 5px 10px; font-size: 12px; cursor: pointer;
        background: none; color: var(--text-color);
        border: none; border-radius: 0;
    }
    #new-file-overlay .nf-tpl-item:hover { background: var(--hover-color); }
    #new-file-overlay .nf-tpl-item.sel {
        background: color-mix(in srgb, var(--primary-color) 16%, transparent);
        outline: 1px solid var(--primary-color); outline-offset: -1px;
    }
    #new-file-overlay .nf-tpl-item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #new-file-overlay .nf-tpl-item-key {
        font-size: 10px; opacity: 0.5; font-family: var(--font-mono, monospace);
        border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; line-height: 1.4;
    }
    #new-file-overlay .nf-tpl-item-badge {
        font-size: 9px; opacity: 0.6;
        border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; line-height: 1.4;
    }
    #new-file-overlay .nf-tpl-preview {
        max-height: 120px; overflow: auto; margin: 0;
        padding: 8px 10px; font-size: 11px; font-family: var(--font-mono, monospace);
        background: var(--bg-color-secondary, var(--bg-color));
        border: 1px solid var(--border-color); border-radius: 4px;
        white-space: pre-wrap; opacity: 0.85;
    }
    #new-file-overlay .nf-tpl-preview:empty { display: none; }

    /* Register-template inline form (rendered above the template list so a
       long list never pushes the "+ New" form out of view) */
    #new-file-overlay .nf-reg { display: none; flex-direction: column; gap: 6px; }
    #new-file-overlay .nf-reg.visible { display: flex; }
    #new-file-overlay .nf-reg input[type="text"], #new-file-overlay .nf-reg textarea {
        width: 100%; padding: 6px 8px; font-size: 12px; box-sizing: border-box;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 4px;
        font-family: var(--font-mono, monospace);
    }
    #new-file-overlay .nf-reg textarea { min-height: 90px; resize: vertical; }
    #new-file-overlay .nf-reg-actions { display: flex; gap: 6px; justify-content: flex-end; }
    #new-file-overlay .nf-reg-actions button {
        padding: 5px 12px; font-size: 11px; cursor: pointer;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 4px;
    }
    #new-file-overlay .nf-reg-actions button.primary {
        background: var(--primary-color); color: #fff; border-color: var(--primary-color);
    }
    #new-file-overlay .nf-reg-actions button:hover { filter: brightness(1.1); }
    `;
    document.head.appendChild(style);
}

export const NewFileModal = {
    /**
     * @param {(ext: string, templateContent?: string) => void} onPick
     *   Called with the chosen extension; for Markdown the selected template's
     *   content is passed as the second argument ('' when blank/none).
     */
    show(onPick) {
        _injectStyles();
        const existing = document.getElementById('new-file-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'new-file-overlay';
        overlay.className = 'tab-search-overlay';

        const box = document.createElement('div');
        box.className = 'tab-search-container';
        box.style.cssText = 'width: 420px; max-width: 92vw; align-self: flex-start; height: auto; max-height: none; display: flex; flex-direction: column; gap: 12px; padding: 16px;';

        const head = document.createElement('div');
        head.innerHTML = `<div class="nf-title">New File</div><div class="nf-sub">Choose a format</div>`;

        const grid = document.createElement('div');
        grid.className = 'nf-grid';

        // ── Markdown template picker ──────────────────────────────────────
        // The register form sits ABOVE the list: with many templates the list
        // would otherwise push the "+ New" form out of view.
        const tplWrap = document.createElement('div');
        tplWrap.className = 'nf-tpl';
        tplWrap.innerHTML = `
            <div class="nf-reg">
                <div class="nf-tpl-label">Register Template</div>
                <input type="text" class="nf-reg-name" placeholder="Template name" maxlength="60">
                <textarea class="nf-reg-content" placeholder="# Template content (Markdown)"></textarea>
                <div class="nf-reg-actions">
                    <button type="button" class="nf-reg-cancel">Cancel</button>
                    <button type="button" class="primary nf-reg-save">Save Template</button>
                </div>
            </div>
            <div class="nf-tpl-head">
                <div class="nf-tpl-label">Template</div>
                <span class="nf-tpl-spacer"></span>
                <button type="button" class="nf-tpl-btn nf-tpl-del" title="Delete the selected template">Delete</button>
                <button type="button" class="nf-tpl-btn nf-tpl-new" title="Register a new template">+ New</button>
            </div>
            <div class="nf-tpl-list" role="listbox"></div>
            <pre class="nf-tpl-preview"></pre>
        `;
        const regWrap = tplWrap.querySelector('.nf-reg');
        const regName = regWrap.querySelector('.nf-reg-name');
        const regContent = regWrap.querySelector('.nf-reg-content');
        const tplList = tplWrap.querySelector('.nf-tpl-list');
        const tplPreview = tplWrap.querySelector('.nf-tpl-preview');
        const tplDelBtn = tplWrap.querySelector('.nf-tpl-del');
        const tplNewBtn = tplWrap.querySelector('.nf-tpl-new');

        // Keyboard-selectable template list state.
        let tplItems = [];
        let tplIndex = 0;
        const selectedTemplateId = () => (tplItems[tplIndex] ? tplItems[tplIndex].id : null);

        const updateTemplateUI = () => {
            const tpl = MarkdownTemplates.getById(selectedTemplateId());
            tplPreview.textContent = tpl ? tpl.content : '';
            // Everything except the Blank built-in can be deleted.
            tplDelBtn.style.display = (tpl && MarkdownTemplates.isDeletable(tpl.id)) ? '' : 'none';
        };

        const setTplSel = (i, { scroll = true } = {}) => {
            if (!tplItems.length) { tplIndex = 0; return; }
            tplIndex = ((i % tplItems.length) + tplItems.length) % tplItems.length;
            tplList.querySelectorAll('.nf-tpl-item').forEach((el, n) => {
                el.classList.toggle('sel', n === tplIndex);
            });
            if (scroll) {
                const selEl = tplList.querySelectorAll('.nf-tpl-item')[tplIndex];
                // jsdom (and very old engines) lack scrollIntoView — guard it.
                if (selEl && typeof selEl.scrollIntoView === 'function') {
                    selEl.scrollIntoView({ block: 'nearest' });
                }
            }
            updateTemplateUI();
        };

        const refreshTemplates = (selectId) => {
            tplItems = MarkdownTemplates.getAll();
            tplList.innerHTML = '';
            tplItems.forEach((t, n) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'nf-tpl-item';
                item.setAttribute('role', 'option');
                item.innerHTML =
                    `<span class="nf-tpl-item-key">${n + 1}</span>` +
                    `<span class="nf-tpl-item-name"></span>` +
                    `<span class="nf-tpl-item-badge">${t.builtin ? 'built-in' : 'user'}</span>`;
                item.querySelector('.nf-tpl-item-name').textContent = t.name;
                item.onclick = () => { setTplSel(n, { scroll: false }); pick(selected); };
                item.onmouseenter = () => setTplSel(n, { scroll: false });
                tplList.appendChild(item);
            });
            const target = (selectId && tplItems.some(t => t.id === selectId))
                ? tplItems.findIndex(t => t.id === selectId)
                : 0;
            setTplSel(target, { scroll: false });
        };

        tplNewBtn.onclick = () => {
            regWrap.classList.add('visible');
            regName.value = '';
            regContent.value = '';
            regName.focus();
        };
        regWrap.querySelector('.nf-reg-cancel').onclick = () => {
            regWrap.classList.remove('visible');
        };
        regWrap.querySelector('.nf-reg-save').onclick = () => {
            try {
                const saved = MarkdownTemplates.add(regName.value, regContent.value);
                regWrap.classList.remove('visible');
                refreshTemplates(saved.id);
            } catch (err) {
                if (window.showToast) window.showToast(err.message || String(err));
                else showAlert(err.message || err, { title: 'New File', kind: 'error' });
            }
        };
        tplDelBtn.onclick = () => {
            const tpl = MarkdownTemplates.getById(selectedTemplateId());
            if (!tpl || !MarkdownTemplates.isDeletable(tpl.id)) return;
            MarkdownTemplates.remove(tpl.id);
            refreshTemplates();
        };
        // Keep typing inside the form from triggering modal-level key jumps.
        // The modal-level key handler runs on document in the CAPTURE phase, so
        // it fires before a bubble-phase stopPropagation() on this form could
        // ever run — intercept the keys in the capture phase here instead.
        const stopFormKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); regWrap.classList.remove('visible'); return; }
            e.stopPropagation();
        };
        regName.addEventListener('keydown', stopFormKey, true);
        regContent.addEventListener('keydown', stopFormKey, true);

        let selected = 0;
        const cards = TYPES.map((t, i) => {
            const card = document.createElement('button');
            card.className = 'nf-card';
            card.type = 'button';
            card.innerHTML =
                `<span class="nf-key">${t.key}</span>` +
                `<span class="nf-ico">${t.icon}</span>` +
                `<span class="nf-name">${t.label} <span class="nf-ext">.${t.ext}</span></span>` +
                `<span class="nf-hint">${t.hint}</span>`;
            card.onclick = () => pick(i);
            card.onmouseenter = () => setSel(i);
            grid.appendChild(card);
            return card;
        });

        const foot = document.createElement('div');
        foot.className = 'nf-foot';
        foot.textContent = '← → format · ↑ ↓ / Tab template · Enter confirm · Esc cancel';

        box.append(head, grid, tplWrap, foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        refreshTemplates();

        const setSel = (i) => {
            selected = (i + cards.length) % cards.length;
            cards.forEach((c, n) => c.classList.toggle('sel', n === selected));
            cards[selected].focus({ preventScroll: true });
            // The template picker only applies to Markdown.
            tplWrap.classList.toggle('visible', TYPES[selected].ext === 'md');
        };

        const close = () => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
        };

        const pick = (i) => {
            const type = TYPES[i];
            close();
            if (type && typeof onPick === 'function') {
                if (type.ext === 'md') {
                    const tpl = MarkdownTemplates.getById(selectedTemplateId());
                    onPick(type.ext, tpl ? tpl.content : '');
                } else {
                    onPick(type.ext);
                }
            }
        };

        const onKey = (e) => {
            // Typing inside the register form must not trigger the card
            // key-jumps (e.g. "m" would pick Markdown). Only ignore keys
            // whose target is a form field INSIDE this modal; a field of the
            // editor behind the modal (e.g. CodeMirror's hidden textarea)
            // must still be swallowed below so it never reacts while the
            // modal is open.
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
                && overlay.contains(t)) {
                return;
            }
            const tplVisible = tplWrap.classList.contains('visible');
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(selected); return; }
            // ← / → always switch between the format cards.
            if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setSel(selected + 1); return; }
            if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); setSel(selected - 1); return; }
            // ↑ / ↓ (and Tab) walk the template list when it is visible, so a
            // template can be chosen without the mouse; otherwise they keep
            // moving between the format cards.
            if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
                e.preventDefault(); e.stopPropagation();
                if (tplVisible) setTplSel(tplIndex + 1); else setSel(selected + 1);
                return;
            }
            if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault(); e.stopPropagation();
                if (tplVisible) setTplSel(tplIndex - 1); else setSel(selected - 1);
                return;
            }
            // Number / first-letter jump (1, 2 … or t / m).
            const k = e.key.toLowerCase();
            const idx = TYPES.findIndex(t => t.key === k || t.ext[0] === k);
            if (idx >= 0) { e.preventDefault(); e.stopPropagation(); pick(idx); return; }
            // Any other key (F5, PageUp/Down, Home/End, …) must not leak
            // through to the editor/tab behind this modal either — swallow it.
            e.stopPropagation();
        };

        document.addEventListener('keydown', onKey, true);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
        setSel(0);
    }
};
