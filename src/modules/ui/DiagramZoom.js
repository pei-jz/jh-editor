import { t } from '../utils/I18n.js';
import { Lightbox } from './Lightbox.js';

/**
 * DiagramZoom — zoom for the live diagram previews (Mermaid helper, block edit).
 *
 * Those previews sit in a pane a fraction of the window wide, and a diagram
 * laid out at its natural size (often well over 1000px for a flowchart with
 * subgraphs) is scaled down to that pane until its labels are unreadable. The
 * lightbox already enlarges a diagram, but it covers the source you are
 * editing. This keeps the diagram in place and changes its size instead:
 *
 *   fit    — as wide as the pane, never wider than the diagram itself (default)
 *   zoom   — a fixed scale of the diagram's natural size; the pane scrolls
 *
 * The previews re-render on every keystroke, which replaces the SVG, so the
 * chosen zoom lives here and is put back by refresh() after each render.
 */

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const STEP = 1.2;

function _injectStyles() {
    if (document.getElementById('diagram-zoom-styles')) return;
    const style = document.createElement('style');
    style.id = 'diagram-zoom-styles';
    style.textContent = `
    .dz-bar {
        display: inline-flex; align-items: center; gap: 2px;
        margin-left: auto; font-size: 11px; user-select: none;
    }
    .dz-bar[hidden] { display: none; }
    .dz-btn {
        min-width: 22px; height: 20px; padding: 0 6px;
        border: 1px solid var(--border-color); border-radius: 4px;
        background: var(--bg-color); color: var(--text-color);
        font: inherit; line-height: 1; cursor: pointer;
    }
    .dz-btn:hover { border-color: var(--primary-color); color: var(--primary-color); }
    .dz-btn.dz-on { border-color: var(--primary-color); color: var(--primary-color); }
    .dz-level {
        min-width: 42px; text-align: center;
        font-variant-numeric: tabular-nums; color: var(--text-secondary, var(--text-color));
    }
    /* While zoomed the diagram may be wider than its block; let the block
       scroll rather than clip, and start from the left edge so the scroll
       range covers all of it. */
    .dz-zoomed .mermaid { max-width: none; overflow: visible; text-align: left; }
    `;
    document.head.appendChild(style);
}

/** Natural size of a rendered diagram, from its viewBox. */
function _natural(svg) {
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    return vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? { w: vb[2], h: vb[3] } : null;
}

/**
 * @param {HTMLElement} scrollEl  the preview element the diagrams render into
 * @returns {{ bar: HTMLElement, refresh: () => void, reset: () => void, destroy: () => void }}
 *   `bar` is for the caller to place (a pane header); call refresh() after
 *   every render.
 */
export function attachDiagramZoom(scrollEl) {
    _injectStyles();
    let zoom = null; // null = fit to the pane

    const bar = document.createElement('div');
    bar.className = 'dz-bar';
    bar.hidden = true;
    const mk = (text, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dz-btn';
        b.textContent = text;
        b.title = title;
        // Keep the caret in the source editor: a click here must not steal focus.
        b.addEventListener('mousedown', (e) => e.preventDefault());
        return b;
    };
    const outBtn = mk('−', t('Zoom out'));
    const level = document.createElement('span');
    level.className = 'dz-level';
    const inBtn = mk('+', t('Zoom in'));
    const fitBtn = mk(t('Fit'), t('Fit to the pane width'));
    const bigBtn = mk('⤢', t('Open enlarged'));
    bar.title = t('Ctrl+wheel to zoom');
    bar.append(outBtn, level, inBtn, fitBtn, bigBtn);

    const svgs = () => [...scrollEl.querySelectorAll('.mermaid svg')];

    /** The scale the first diagram is shown at right now (for the label and for stepping from fit). */
    const currentScale = () => {
        if (zoom != null) return zoom;
        const svg = svgs()[0];
        const n = svg && _natural(svg);
        const w = svg && svg.getBoundingClientRect().width;
        return n && w ? w / n.w : 1;
    };

    const refresh = () => {
        const list = svgs();
        bar.hidden = list.length === 0;
        if (!list.length) return;
        scrollEl.classList.toggle('dz-zoomed', zoom != null);
        for (const svg of list) {
            const n = _natural(svg);
            if (!n) continue;
            if (zoom == null) {
                // Fill the pane, but never blow a small diagram up past 1:1.
                svg.style.width = '100%';
                svg.style.maxWidth = `${n.w}px`;
                svg.style.height = 'auto';
            } else {
                svg.style.width = `${Math.round(n.w * zoom)}px`;
                svg.style.maxWidth = 'none';
                svg.style.height = `${Math.round(n.h * zoom)}px`;
            }
        }
        level.textContent = `${Math.round(currentScale() * 100)}%`;
        fitBtn.classList.toggle('dz-on', zoom == null);
    };

    const setZoom = (z) => {
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
        refresh();
    };

    outBtn.onclick = () => setZoom(currentScale() / STEP);
    inBtn.onclick = () => setZoom(currentScale() * STEP);
    fitBtn.onclick = () => { zoom = null; refresh(); };
    bigBtn.onclick = () => {
        const host = scrollEl.querySelector('.mermaid');
        if (host && host.querySelector('svg')) Lightbox.open(host, '');
    };

    const onWheel = (e) => {
        if (!e.ctrlKey || !svgs().length) return;
        e.preventDefault();
        setZoom(currentScale() * (e.deltaY < 0 ? STEP : 1 / STEP));
    };
    scrollEl.addEventListener('wheel', onWheel, { passive: false });

    // In fit mode the label follows the pane as the splitter moves.
    const ro = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => { if (zoom == null && !bar.hidden) level.textContent = `${Math.round(currentScale() * 100)}%`; })
        : null;
    if (ro) ro.observe(scrollEl);

    return {
        bar,
        refresh,
        reset() { zoom = null; refresh(); },
        destroy() {
            scrollEl.removeEventListener('wheel', onWheel);
            scrollEl.classList.remove('dz-zoomed');
            if (ro) ro.disconnect();
            bar.remove();
        },
    };
}
