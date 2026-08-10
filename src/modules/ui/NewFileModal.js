// Ctrl+N: pick the type of the new file before creating it.
// Flat, keyboard-first picker: ←/→ (or ↑/↓ and Tab) move, Enter confirms,
// the number keys / the type's letter jump straight to it, Esc cancels.

const TYPES = [
    {
        ext: 'txt',
        label: 'Text',
        hint: 'Plain text',
        key: '1',
        // Simple lined-document glyph.
        icon: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>',
    },
    {
        ext: 'md',
        label: 'Markdown',
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
    `;
    document.head.appendChild(style);
}

export const NewFileModal = {
    /** @param {(ext: string) => void} onPick */
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
        foot.textContent = '← → select · Enter confirm · Esc cancel';

        box.append(head, grid, foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const setSel = (i) => {
            selected = (i + cards.length) % cards.length;
            cards.forEach((c, n) => c.classList.toggle('sel', n === selected));
            cards[selected].focus({ preventScroll: true });
        };

        const close = () => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
        };

        const pick = (i) => {
            const type = TYPES[i];
            close();
            if (type && typeof onPick === 'function') onPick(type.ext);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(selected); return; }
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
                e.preventDefault(); e.stopPropagation(); setSel(selected + 1); return;
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault(); e.stopPropagation(); setSel(selected - 1); return;
            }
            // Number / first-letter jump (1, 2 … or t / m).
            const k = e.key.toLowerCase();
            const idx = TYPES.findIndex(t => t.key === k || t.ext[0] === k);
            if (idx >= 0) { e.preventDefault(); e.stopPropagation(); pick(idx); }
        };

        document.addEventListener('keydown', onKey, true);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
        setSel(0);
    }
};
