/**
 * Lightbox.js — click a diagram or an image in rendered Markdown to see it big.
 *
 * Rendered Mermaid diagrams and pasted screenshots are usually laid out at
 * document width, which is far too small to actually read. This blows the
 * selected element up to fill the window, with zoom (wheel / +- / buttons) and
 * drag-to-pan, and leaves the document untouched — the content is cloned.
 */

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

function _injectStyles() {
    if (document.getElementById('lightbox-styles')) return;
    const style = document.createElement('style');
    style.id = 'lightbox-styles';
    style.textContent = `
    #jh-lightbox {
        position: fixed; inset: 0; z-index: 4000;
        background: rgba(0, 0, 0, 0.72);
        display: flex; flex-direction: column;
    }
    .lb-bar {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; color: #fff;
        background: rgba(0, 0, 0, 0.35);
        font-size: 12px; user-select: none;
    }
    .lb-title { flex: 1; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lb-btn {
        background: rgba(255,255,255,0.12); color: #fff;
        border: 1px solid rgba(255,255,255,0.25); border-radius: 5px;
        padding: 4px 10px; cursor: pointer; font-size: 12px; line-height: 1.2;
    }
    .lb-btn:hover { background: rgba(255,255,255,0.24); }
    .lb-zoom { min-width: 52px; text-align: center; opacity: 0.9; font-variant-numeric: tabular-nums; }
    .lb-stage {
        flex: 1; overflow: hidden; position: relative;
        display: flex; align-items: center; justify-content: center;
        cursor: grab;
    }
    .lb-stage.dragging { cursor: grabbing; }
    .lb-inner {
        transform-origin: center center;
        background: #fff; border-radius: 6px; padding: 16px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.5);
        max-width: none;
    }
    /* The clone must be free of the document's width limits. */
    .lb-inner svg, .lb-inner img { max-width: none !important; max-height: none !important; height: auto; }
    .lb-hint { padding: 6px 12px; color: rgba(255,255,255,0.6); font-size: 11px; text-align: center; user-select: none; }
    `;
    document.head.appendChild(style);
}

export const Lightbox = {
    /**
     * @param {Element} sourceEl  the diagram/image element to enlarge
     * @param {string} [title]
     */
    open(sourceEl, title = '') {
        if (!sourceEl) return;
        _injectStyles();
        document.getElementById('jh-lightbox')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'jh-lightbox';

        const bar = document.createElement('div');
        bar.className = 'lb-bar';
        const titleEl = document.createElement('span');
        titleEl.className = 'lb-title';
        titleEl.textContent = title || '';
        const zoomOut = Object.assign(document.createElement('button'), { className: 'lb-btn', textContent: '−' });
        const zoomLabel = document.createElement('span');
        zoomLabel.className = 'lb-zoom';
        const zoomIn = Object.assign(document.createElement('button'), { className: 'lb-btn', textContent: '＋' });
        const fitBtn = Object.assign(document.createElement('button'), { className: 'lb-btn', textContent: 'Fit' });
        const oneBtn = Object.assign(document.createElement('button'), { className: 'lb-btn', textContent: '100%' });
        const closeBtn = Object.assign(document.createElement('button'), { className: 'lb-btn', textContent: 'Close (Esc)' });
        bar.append(titleEl, zoomOut, zoomLabel, zoomIn, fitBtn, oneBtn, closeBtn);

        const stage = document.createElement('div');
        stage.className = 'lb-stage';
        const inner = document.createElement('div');
        inner.className = 'lb-inner';
        // Clone so zooming can never disturb the document.
        inner.appendChild(sourceEl.cloneNode(true));
        stage.appendChild(inner);

        const hint = document.createElement('div');
        hint.className = 'lb-hint';
        hint.textContent = 'Wheel to zoom · drag to pan · +/− zoom · 0 actual size · F fit';

        overlay.append(bar, stage, hint);
        document.body.appendChild(overlay);

        // ── zoom / pan ────────────────────────────────────────────────────────
        let zoom = 1, tx = 0, ty = 0;
        const apply = () => {
            inner.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
            zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
        };
        const setZoom = (z) => { zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)); apply(); };

        const fit = () => {
            tx = 0; ty = 0;
            const sw = stage.clientWidth - 40, sh = stage.clientHeight - 40;
            // Measure at 1:1 so the ratio isn't skewed by the current zoom.
            inner.style.transform = 'translate(0,0) scale(1)';
            const r = inner.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                setZoom(Math.min(sw / r.width, sh / r.height, 1));
            } else {
                setZoom(1);
            }
        };

        stage.addEventListener('wheel', (e) => {
            e.preventDefault();
            setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
        }, { passive: false });

        let dragging = false, lastX = 0, lastY = 0;
        stage.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            dragging = true; lastX = e.clientX; lastY = e.clientY;
            stage.classList.add('dragging');
            e.preventDefault();
        });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        function onMove(e) {
            if (!dragging) return;
            tx += e.clientX - lastX; ty += e.clientY - lastY;
            lastX = e.clientX; lastY = e.clientY;
            apply();
        }
        function onUp() { dragging = false; stage.classList.remove('dragging'); }

        const close = () => {
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            overlay.remove();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom * 1.2); }
            else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom / 1.2); }
            else if (e.key === '0') { e.preventDefault(); tx = 0; ty = 0; setZoom(1); }
            else if (e.key.toLowerCase() === 'f') { e.preventDefault(); fit(); }
        };
        document.addEventListener('keydown', onKey, true);

        zoomIn.onclick = () => setZoom(zoom * 1.2);
        zoomOut.onclick = () => setZoom(zoom / 1.2);
        oneBtn.onclick = () => { tx = 0; ty = 0; setZoom(1); };
        fitBtn.onclick = fit;
        closeBtn.onclick = close;
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

        // Images may still be decoding when cloned; fit once they have a size.
        const img = inner.querySelector('img');
        if (img && !img.complete) img.addEventListener('load', fit, { once: true });
        requestAnimationFrame(fit);
    },
};

/**
 * Make diagrams/images inside `container` open in the lightbox on click.
 * Idempotent per element, so it is safe to call after every re-render.
 */
export function enableLightbox(container) {
    if (!container) return;
    const targets = container.querySelectorAll('.mermaid, img');
    for (const el of targets) {
        if (el.dataset.lightbox === '1') continue;
        // A .mermaid node still holding source text isn't a diagram yet.
        if (el.classList.contains('mermaid') && !el.querySelector('svg')) continue;
        el.dataset.lightbox = '1';
        el.style.cursor = 'zoom-in';
        el.title = el.title || 'Click to enlarge';
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const name = el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '';
            Lightbox.open(el, name);
        });
    }
}
