/**
 * folder-jump.js — the window the global hotkey brings up.
 *
 * Kept loaded and hidden while Folder Jump is on, so it appears at once; the
 * backend sends `folder-jump:opened` each time it is shown. Deliberately imports
 * none of the editor: this page is alive all day in every resident session.
 *
 * Losing focus hides it too, but that is handled in the backend
 * (commands/folder_jump.rs), where it also covers the page not having loaded.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { applyI18n, getLanguage } from './modules/utils/I18n.js';
import { themeClasses, isKnownTheme } from './modules/utils/Themes.js';
import { effectiveTheme } from './modules/utils/WorkspaceTheme.js';
import { createFolderJumpPanel } from './modules/ui/FolderJumpPanel.js';

const win = getCurrentWebviewWindow();

/** The global theme: this window belongs to no workspace. */
function applyCurrentTheme() {
    const theme = effectiveTheme(null);
    document.body.classList.remove(...themeClasses());
    if (theme && theme !== 'light' && isKnownTheme(theme)) document.body.classList.add(`theme-${theme}`);
}

const panel = createFolderJumpPanel({
    openWorkspace: (path) => invoke('open_folder_as_workspace', { path }),
    close: () => win.hide(),
});

function refresh() {
    document.documentElement.lang = getLanguage();
    applyCurrentTheme();
    panel.reset();
}

document.getElementById('root').appendChild(panel.element);
applyI18n();
refresh();
win.listen('folder-jump:opened', refresh);
