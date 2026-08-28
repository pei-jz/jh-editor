/**
 * JhAiActivityPanel.js — bottom-right activity dock for JHAI tasks.
 *
 * Shows running tasks (live status + Stop) and keeps a short history of recent
 * results that can be re-opened ("結果を呼び出して"). Each task gets an entry
 * handle the caller updates as the task streams:
 *
 *   const entry = activityPanel.addTask('ログ集計');
 *   entry.setStatus('🛠 get_buffer');     // live step
 *   entry.onAbort(() => handle.abort());  // Stop wiring
 *   entry.setResult(envelope, { onInsert, onAction });
 *   entry.setError('…');
 *
 * Dependency-light: renders markdown via the global `marked` (falls back to a
 * <pre>). No framework.
 */

import { icon as svgIcon } from '../ui/Icons.js';
import { t } from '../utils/I18n.js';
const MAX_HISTORY = 20;

function renderMarkdown(md) {
    const text = md || '';
    try {
        if (typeof marked !== 'undefined' && marked.parse) return marked.parse(text);
    } catch (_) { /* fall through */ }
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre style="white-space:pre-wrap;margin:0;">${esc}</pre>`;
}

function btn(label, primary = false) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `border:none;border-radius:5px;cursor:pointer;font-size:11px;padding:4px 9px;`
        + (primary
            ? 'background:#0a6cff;color:#fff;'
            : 'background:rgba(255,255,255,0.1);color:#ddd;');
    return b;
}

class JhAiActivityPanel {
    constructor() {
        this._root = null;
        this._list = null;
        this._count = 0;
    }

    _ensure() {
        if (this._root) return;
        const root = document.createElement('div');
        root.id = 'jhai-activity';
        root.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:16px', 'z-index:9998',
            'width:360px', 'max-width:calc(100vw - 32px)', 'max-height:70vh',
            'display:none', 'flex-direction:column',
            'background:#1e1e1e', 'color:#ddd', 'border:1px solid #444',
            'border-radius:8px', 'box-shadow:0 6px 24px rgba(0,0,0,.5)',
            'font-family:system-ui,Segoe UI,sans-serif', 'font-size:12px', 'overflow:hidden',
        ].join(';');
        root.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 11px;background:#2a2a2a;border-bottom:1px solid #444;">
                <strong class="jh-icon-row" style="font-size:12px;">${svgIcon('robot', { size: 13 })}AI Activity</strong>
                <span>
                    <button class="jhai-act-clear" title="Clear finished" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:12px;">Clear</button>
                    <button class="jhai-act-hide" title="Hide" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:15px;line-height:1;">×</button>
                </span>
            </div>
            <div class="jhai-act-list" style="overflow:auto;flex:1;padding:8px;display:flex;flex-direction:column;gap:8px;"></div>
        `;
        document.body.appendChild(root);
        root.querySelector('.jhai-act-hide').addEventListener('click', () => { root.style.display = 'none'; });
        root.querySelector('.jhai-act-clear').addEventListener('click', () => this._clearDone());
        this._root = root;
        this._list = root.querySelector('.jhai-act-list');
    }

    _show() { this._ensure(); this._root.style.display = 'flex'; }

    _clearDone() {
        if (!this._list) return;
        [...this._list.children].forEach((card) => {
            if (card.dataset.state === 'done' || card.dataset.state === 'error') card.remove();
        });
        if (this._list.children.length === 0) this._root.style.display = 'none';
    }

    _prune() {
        while (this._list.children.length > MAX_HISTORY) {
            this._list.lastElementChild.remove();
        }
    }

    /** Create a task card; returns an entry handle. */
    addTask(title) {
        this._ensure();
        this._show();
        const card = document.createElement('div');
        card.dataset.state = 'running';
        card.style.cssText = 'border:1px solid #3a3a3a;border-radius:6px;background:#232323;padding:8px;display:flex;flex-direction:column;gap:6px;position:relative;';
        card.innerHTML = `
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                <span class="jhai-act-title" style="font-weight:600;word-break:break-word;flex:1;line-height:1.2;padding-top:2px;padding-right:24px;"></span>
                <button class="jhai-act-stop" style="border:none;border-radius:4px;cursor:pointer;font-size:11px;padding:3px 8px;background:#7a2a2a;color:#fff;flex-shrink:0;">Stop</button>
            </div>
            <button class="jhai-act-remove" title="Remove this task" style="display:none;position:absolute;top:4px;right:6px;background:none;border:none;color:#888;cursor:pointer;font-size:18px;line-height:1;padding:2px 4px;z-index:1;">&times;</button>
            <div class="jhai-act-status" style="color:#9bd;display:flex;align-items:center;gap:6px;">
                <span class="jhai-act-spin" style="display:inline-block;width:10px;height:10px;border:2px solid #555;border-top-color:#0a6cff;border-radius:50%;animation:jhai-spin 0.8s linear infinite;"></span>
                <span class="jhai-act-status-text">Starting…</span>
            </div>
            <div class="jhai-act-body" style="display:none;"></div>
            <div class="jhai-act-actions" style="display:none;gap:6px;flex-wrap:wrap;align-items:center;"></div>
        `;
        card.querySelector('.jhai-act-title').textContent = title || 'AI Tasks';
        this._list.prepend(card);
        this._prune();
        this._ensureSpinKeyframes();

        let abortFn = null;
        const stopBtn = card.querySelector('.jhai-act-stop');
        stopBtn.addEventListener('click', () => {
            if (abortFn) { try { abortFn(); } catch (_) {} }
            this._finishState(card, 'aborted', '⏹ Cancelled');
        });

        // ✕ removal button (shown after task finishes)
        const removeBtn = card.querySelector('.jhai-act-remove');
        removeBtn.addEventListener('click', () => {
            card.remove();
            if (this._list && this._list.children.length === 0) {
                this._root.style.display = 'none';
            }
        });
        removeBtn.addEventListener('mouseenter', () => { removeBtn.style.color = '#ff6b6b'; });
        removeBtn.addEventListener('mouseleave', () => { removeBtn.style.color = '#888'; });

        const self = this;
        return {
            setStatus(text) {
                const el = card.querySelector('.jhai-act-status-text');
                if (el) el.textContent = text || '';
            },
            onAbort(fn) { abortFn = fn; },
            setResult(opts = {}) {
                self._renderResult(card, opts || {});
                self._finishState(card, 'done', 'Done');
            },
            setError(msg) {
                const body = card.querySelector('.jhai-act-body');
                body.style.display = 'block';
                body.innerHTML = `<span style="color:#ff6b6b;">Error: ${(msg || '').replace(/</g, '&lt;')}</span>`;
                self._finishState(card, 'error', 'Failed');
            },
            remove() { card.remove(); },
        };
    }

    _finishState(card, state, statusText) {
        card.dataset.state = state;
        const spin = card.querySelector('.jhai-act-spin');
        if (spin) spin.style.display = 'none';
        const stop = card.querySelector('.jhai-act-stop');
        if (stop) stop.style.display = 'none';
        // Show the ✕ remove button on the card when the task is finished
        const removeBtn = card.querySelector('.jhai-act-remove');
        if (removeBtn && (state === 'done' || state === 'error' || state === 'aborted')) {
            removeBtn.style.display = 'block';
        }
        const st = card.querySelector('.jhai-act-status-text');
        if (st) st.textContent = statusText;
    }

    /**
     * Compact result card: a short summary line + action buttons. The FULL result
     * is presented elsewhere by kind (markdown → editor tab, code-edit → diff),
     * so the dock stays small. opts: { summary, onOpen, onInsert, copyText, actions, onAction }.
     */
    _renderResult(card, opts) {
        const { summary = 'Done', onOpen = null, onInsert = null, copyText = null, actions = null, onAction = null } = opts;
        const body = card.querySelector('.jhai-act-body');
        const actionsEl = card.querySelector('.jhai-act-actions');

        body.style.cssText = 'display:block;max-height:120px;overflow:auto;border-top:1px solid #3a3a3a;padding-top:6px;line-height:1.4;color:#cfd8e0;white-space:pre-wrap;';
        body.textContent = summary;

        actionsEl.style.display = 'flex';
        actionsEl.innerHTML = '';
        if (onOpen) { const b = btn('Open', true); b.addEventListener('click', () => onOpen()); actionsEl.appendChild(b); }
        if (onInsert) { const b = btn('Insert into document'); b.addEventListener('click', () => onInsert()); actionsEl.appendChild(b); }
        if (copyText != null) {
            const b = btn('Copy');
            b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(copyText); } catch (_) {} });
            actionsEl.appendChild(b);
        }
        (actions || []).forEach((a) => {
            const label = (a && a.label) || (a && a.apply && a.apply.type) || 'Action';
            const ab = btn(label);
            ab.addEventListener('click', () => { if (onAction) onAction(a); });
            actionsEl.appendChild(ab);
        });

        // Add a "削除" button at the end of the actions row for easy removal
        const delBtn = btn('Remove');
        delBtn.style.marginLeft = 'auto';
        delBtn.style.color = '#f77';
        delBtn.addEventListener('click', () => {
            card.remove();
            if (this._list && this._list.children.length === 0) {
                this._root.style.display = 'none';
            }
        });
        actionsEl.appendChild(delBtn);
    }

    _ensureSpinKeyframes() {
        if (document.getElementById('jhai-spin-kf')) return;
        const style = document.createElement('style');
        style.id = 'jhai-spin-kf';
        style.textContent = '@keyframes jhai-spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(style);
    }
}

export const activityPanel = new JhAiActivityPanel();

