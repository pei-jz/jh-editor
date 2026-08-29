import { State } from '../core/Store.js';
import { t } from '../utils/I18n.js';

// Ctrl+L: jump the active editor to a given line number.
export const GotoLineModal = {
    show() {
        if (State.activeTabIndex < 0) return;
        const existing = document.getElementById('goto-line-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'goto-line-overlay';
        overlay.className = 'tab-search-overlay';

        const box = document.createElement('div');
        box.className = 'tab-search-container';
        // align-self:flex-start + height:auto so the box hugs its content (the
        // overlay's default align-items:stretch was blowing it up to max-height).
        box.style.cssText = 'width: 320px; max-width: 90vw; align-self: flex-start; height: auto; max-height: none; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;';

        const total = (() => { try { return window.app.getLineCount() || 0; } catch (_) { return 0; } })();

        const label = document.createElement('div');
        label.textContent = total > 0 ? `Go to line  (1–${total})` : 'Go to line';
        label.style.cssText = 'font-size: 12px; opacity: 0.75;';

        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.placeholder = t('Line number (Enter)');
        input.style.cssText = 'width:100%; padding:8px 10px; font-size:14px; background:var(--bg-color-secondary,var(--bg-color)); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;';

        const err = document.createElement('div');
        err.style.cssText = 'font-size: 12px; color: var(--error-color, #e5534b); min-height: 1em; display: none;';

        box.append(label, input, err);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        setTimeout(() => input.focus(), 0);

        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
        const showErr = (msg) => {
            err.textContent = msg;
            err.style.display = 'block';
            input.style.borderColor = 'var(--error-color, #e5534b)';
        };
        const go = () => {
            const raw = input.value.trim();
            const n = parseInt(raw, 10);
            if (!raw || !Number.isFinite(n) || n < 1 || String(n) !== raw.replace(/^0+(?=\d)/, '')) {
                showErr('Enter a valid line number');
                return;
            }
            if (total > 0 && n > total) {
                showErr(`Out of range (1–${total})`);
                return;
            }
            try { window.app.goToLine(n); } catch (_) {}
            close();
        };
        // Clear the error state as soon as the user edits the value.
        input.addEventListener('input', () => {
            if (err.style.display !== 'none') { err.style.display = 'none'; input.style.borderColor = 'var(--border-color)'; }
        });
        const onKey = (e) => {
            if (e.target !== input) return;
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        };
        document.addEventListener('keydown', onKey, true);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    }
};
