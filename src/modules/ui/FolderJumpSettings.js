/**
 * FolderJumpSettings.js — the settings row for Folder Jump: the switch that makes
 * the app stay resident, and the key that brings the window up.
 *
 * The state lives in the backend (commands/folder_jump.rs), not localStorage,
 * because the tray and the hotkey are installed before any webview exists.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { t } from '../utils/I18n.js';
import { formatHotkey, hotkeyFromEvent } from '../utils/FolderJump.js';

/** The tray menu is drawn by the OS, so it is told its words. */
function trayLabels() {
    return { jump: t('Folder Jump'), new_window: t('New Window'), quit: t('Quit') };
}

/** At boot: put the tray menu in the language the editor is showing. */
export async function syncFolderJumpTray() {
    try {
        const status = await invoke('folder_jump_get_status');
        if (status?.enabled) await invoke('folder_jump_set_tray_labels', { labels: trayLabels() });
    } catch (_) { /* no backend: nothing to keep in step */ }
}

export async function initFolderJumpSettings() {
    const toggle = document.getElementById('folder-jump-enabled');
    const keyInput = document.getElementById('folder-jump-hotkey');
    const message = document.getElementById('folder-jump-message');
    if (!toggle || !keyInput || !message) return;

    let current;
    try {
        current = await invoke('folder_jump_get_status');
    } catch (_) {
        return;
    }

    const show = () => {
        toggle.checked = current.enabled;
        keyInput.value = formatHotkey(current.hotkey);
        keyInput.disabled = !current.enabled;
    };
    const say = (text, isError = false) => {
        message.textContent = text;
        message.classList.toggle('error', isError);
    };
    const hotkeyBusy = () => t('This key combination could not be registered. Another app may be using it.');

    /** The backend keeps the previous state when this fails. */
    const apply = async (enabled, hotkey) => {
        try {
            current = await invoke('folder_jump_set_config', { enabled, hotkey });
            say(current.enabled
                ? t('Press {key} in any app to open it. The app stays in the notification area after its windows close.', { key: formatHotkey(current.hotkey) })
                : '');
            if (current.enabled) await invoke('folder_jump_set_tray_labels', { labels: trayLabels() });
        } catch (err) {
            console.error('Folder Jump settings:', err);
            say(hotkeyBusy(), true);
        }
        show();
    };

    toggle.addEventListener('change', () => apply(toggle.checked, current.hotkey));

    keyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
            keyInput.blur();
            return;
        }
        const hotkey = hotkeyFromEvent(e);
        if (hotkey) apply(current.enabled, hotkey);
    });

    // Every window has this row; a change made in another one has to reach it.
    listen('folder-jump:changed', ({ payload }) => {
        current = payload;
        if (!current.enabled) say('');
        show();
    }).catch(() => { /* no backend: nothing will change */ });

    show();
    if (current.hotkey_error) say(hotkeyBusy(), true);
}
