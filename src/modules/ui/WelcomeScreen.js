import { exists } from '../utils/FileSystem.js';

const EL = {
    screen: document.getElementById('welcome-screen'),
    openBtn: document.getElementById('welcome-open-folder-btn'),
    recentList: document.getElementById('recent-workspaces-list'),
};

const RECENTS_KEY = 'jheditor_recent_workspaces';

export function initWelcomeScreen(onWorkspaceSelect) {
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
        alert('Path not found: ' + path);
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
