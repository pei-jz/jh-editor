import { t } from '../utils/I18n.js';
import { shortcuts } from '../core/ShortcutManager.js';

/**
 * EmptyPaneGuide.js — what a pane shows with no tab open.
 *
 * It used to say "select a file" and nothing else, on the one screen with room
 * to say more and nothing competing for attention. The features with no control
 * of their own could only be found by already knowing the key. The rows are real
 * buttons that also show the key, so using one once teaches the shortcut, and
 * the screen is gone again as soon as a file opens.
 *
 * Labels are I18n keys, marked `data-i18n` so a language change reaches a guide
 * that is already on screen.
 */

const ROWS = [
    { cmd: 'app:file-search', label: 'Go to File' },
    { cmd: 'app:command-palette', label: 'Command Palette' },
    { cmd: 'app:open-compare', label: 'Compare Scratch Text' },
    { cmd: 'app:toggle-terminal', label: 'Toggle Terminal' },
    { cmd: 'app:workspace-menu', label: 'Recent Workspaces' },
];

let runCommand = null;   // injected dispatcher

/** @param {(cmd: string) => any} dispatcher runs a command as a keystroke would */
export function initEmptyPaneGuide(dispatcher) {
    runCommand = dispatcher;
}

/** Replace the contents of `container` with the guide. */
export function renderEmptyPaneGuide(container) {
    const guide = document.createElement('div');
    guide.className = 'empty-guide';

    const hint = document.createElement('p');
    hint.className = 'empty-guide-hint';
    hint.dataset.i18n = 'Select a file from the explorer to start editing.';
    hint.textContent = t('Select a file from the explorer to start editing.');
    guide.appendChild(hint);

    const list = document.createElement('div');
    list.className = 'empty-guide-list';
    for (const { cmd, label } of ROWS) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'empty-guide-row';
        row.dataset.cmd = cmd;
        row.onclick = () => runCommand?.(cmd);

        const name = document.createElement('span');
        name.dataset.i18n = label;
        name.textContent = t(label);
        row.appendChild(name);

        const binding = shortcuts.bindingFor(cmd);
        if (binding) {
            const key = document.createElement('kbd');
            key.textContent = binding;
            row.appendChild(key);
        }
        list.appendChild(row);
    }
    guide.appendChild(list);

    container.replaceChildren(guide);
}
