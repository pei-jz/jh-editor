import { t } from '../utils/I18n.js';
import { icon } from './Icons.js';
import { isDeckFile } from '../utils/DeckHost.js';
import { viewSwitchTarget } from '../utils/ViewSwitch.js';

/**
 * ViewSwitchButton.js — the toolbar button that does what Ctrl+Shift+E does.
 *
 * It sits with Book Mode / Preview in the top-right of the view, named for
 * where it goes ("Markdown View", "Table View", "Text View"), with the key in
 * its tooltip so the button also teaches the shortcut. Files with no second
 * view get no button at all: a plain .txt keeps the toolbar it had.
 *
 * The click goes through window.app.toggleViewMode — the one implementation of
 * the switch — which acts on the active pane's tab. The pane under the pointer
 * becomes active on mousedown (Editor.js listens in the capture phase), before
 * this click, so a button in the other pane switches its own tab.
 */

/**
 * A button for `file`, or null when it has nowhere to switch to.
 * @param {object} file
 * @param {object} [opts]
 * @param {string} [opts.cls]  extra class names
 */
export function createViewSwitchButton(file, { cls = '' } = {}) {
    const target = viewSwitchTarget(file, { isDeck: file && file.viewMode === 'text' && isDeckFile(file) });
    if (!target) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cm-toolbar-btn cm-view-switch-btn${cls ? ' ' + cls : ''}`;
    btn.innerHTML = icon('swap', { size: 14, cls: 'cm-tb-icon' });
    const label = document.createElement('span');
    label.textContent = t(target.label);
    btn.appendChild(label);
    btn.title = `${t('Switch to {view}', { view: t(target.label) })} — Ctrl+Shift+E`;
    btn.setAttribute('aria-label', btn.title);
    btn.onclick = (e) => {
        e.stopPropagation();
        if (window.app && typeof window.app.toggleViewMode === 'function') window.app.toggleViewMode();
    };
    return btn;
}

/**
 * Append the button to `toolbar` (if the file has a second view). Returns it.
 */
export function addViewSwitchButton(toolbar, file, opts) {
    if (!toolbar) return null;
    const btn = createViewSwitchButton(file, opts);
    if (btn) toolbar.appendChild(btn);
    return btn;
}
