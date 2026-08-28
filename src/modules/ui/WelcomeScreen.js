import { exists } from '../utils/FileSystem.js';
import { showAlert } from './Dialog.js';

const EL = {
    screen: document.getElementById('welcome-screen'),
    openBtn: document.getElementById('welcome-open-folder-btn'),
    openFileBtn: document.getElementById('welcome-open-file-btn'),
    newFileBtn: document.getElementById('welcome-new-file-btn'),
    recentList: document.getElementById('recent-workspaces-list'),
};

const RECENTS_KEY = 'jheditor_recent_workspaces';

/**
 * Wire up the Welcome screen.
 *
 * @param {(path: string) => any} onWorkspaceSelect  a folder was chosen
 * @param {{ onOpenFile?: (path: string) => any, onNewFile?: () => any }} [handlers]
 *
 * The extra handlers are optional so the workspace-only call still works, but
 * they matter: the screen used to offer nothing except "Open Folder", which
 * meant the fastest way to write one line of text was to pick a directory
 * first. Opening a single file and starting an empty buffer both work without a
 * workspace — the explorer, grep and Git panel simply stay empty until one is
 * opened — so there was no reason to gate them behind the folder picker.
 */
export function initWelcomeScreen(onWorkspaceSelect, handlers = {}) {
    if (!EL.screen) return; // Guard

    // Render Recents
    renderRecents(onWorkspaceSelect);

    // Bind Open Button
    EL.openBtn.onclick = async () => {
        try {
            // Dynamic import for Tauri dialog
            const dialog = await import('@tauri-apps/plugin-dialog');
            const folder = await dialog.open({
                directory: true,
                multiple: false,
                title: 'Open Workspace'
            });

            if (folder) {
                selectWorkspace(folder, onWorkspaceSelect);
            }
        } catch (e) {
            console.error('Failed to open folder dialog', e);
        }
    };

    if (EL.openFileBtn && handlers.onOpenFile) {
        EL.openFileBtn.onclick = async () => {
            try {
                const dialog = await import('@tauri-apps/plugin-dialog');
                const file = await dialog.open({
                    directory: false,
                    multiple: false,
                    title: 'Open File',
                });
                if (file) await handlers.onOpenFile(file);
            } catch (e) {
                console.error('Failed to open file dialog', e);
                showAlert('Could not open the file picker.', { title: 'Open File', kind: 'error' });
            }
        };
    }

    if (EL.newFileBtn && handlers.onNewFile) {
        EL.newFileBtn.onclick = () => handlers.onNewFile();
    }
}

export function showWelcomeScreen() {
    if (EL.screen) EL.screen.style.display = 'flex';
}

export function hideWelcomeScreen() {
    if (EL.screen) EL.screen.style.display = 'none';
}

async function selectWorkspace(path, callback) {
    if (await exists(path)) {
        addToRecents(path);
        callback(path);
    } else {
        showAlert('Path not found: ' + path, { title: 'Open Workspace', kind: 'error' });
        removeFromRecents(path);
        renderRecents(callback);
    }
}

function removeFromRecents(path) {
    let recents = getRecents();
    recents = recents.filter(p => p !== path);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
}

function addToRecents(path) {
    let recents = getRecents();
    // Remove if exists
    recents = recents.filter(p => p !== path);
    // Add to top
    recents.unshift(path);
    // Limit to 5
    if (recents.length > 5) recents.pop();

    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
}

function getRecents() {
    try {
        const json = localStorage.getItem(RECENTS_KEY);
        return json ? JSON.parse(json) : [];
    } catch (e) {
        return [];
    }
}

function renderRecents(onWorkspaceSelect) {
    const list = EL.recentList;
    if (!list) return;

    const recents = getRecents();
    list.innerHTML = '';

    if (recents.length === 0) {
        list.innerHTML = '<li class="no-recents">No recent workspaces</li>';
        return;
    }

    recents.forEach(path => {
        const li = document.createElement('li');
        li.className = 'recent-item';
        li.title = path; // Full path on hover
        
        // Truncate middle if path is too long
        let displayPath = path;
        if (path.length > 50) {
            const sep = path.includes('\\') ? '\\' : '/';
            const parts = path.split(sep);
            if (parts.length > 3) {
                displayPath = `${parts[0]}${sep}${parts[1]}${sep}...${sep}${parts[parts.length - 1]}`;
                // If it's still too long, fallback to basic split
                if (displayPath.length > 55) {
                    displayPath = path.substring(0, 20) + '...' + path.substring(path.length - 25);
                }
            } else {
                displayPath = path.substring(0, 20) + '...' + path.substring(path.length - 25);
            }
        }

        const label = document.createElement('span');
        label.className = 'recent-item-label';
        label.textContent = displayPath;
        label.onclick = () => selectWorkspace(path, onWorkspaceSelect);

        // Open this workspace in a SEPARATE process (multi-workspace support).
        const newWinBtn = document.createElement('button');
        newWinBtn.className = 'recent-item-newwin';
        newWinBtn.type = 'button';
        newWinBtn.textContent = '⧉';
        newWinBtn.title = 'Open in a new window';
        newWinBtn.onclick = (e) => {
            e.stopPropagation();
            try { window.app?.openWorkspaceInNewWindow?.(path); } catch (_) {}
        };

        li.appendChild(label);
        li.appendChild(newWinBtn);
        list.appendChild(li);
    });
}
