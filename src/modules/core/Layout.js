import { EL } from './Constants.js';
import { State } from './Store.js';
import { applyTheme } from '../ui/SettingsModal.js';

export function setCompactMode(isCompact) {
    if (isCompact) document.body.classList.add('display-mode-compact');
    else document.body.classList.remove('display-mode-compact');
    saveSettings();
}

export function initLayout() {
    loadSettings();

    // Toggle Explorer
    if (EL.toggleExplorerBtn) {
        EL.toggleExplorerBtn.addEventListener('click', () => {
            State.isExplorerVisible = !State.isExplorerVisible;
            EL.explorer.classList.toggle('hidden', !State.isExplorerVisible);
        });
    }

    // Resizers
    setupResizers();

    // Zoom via Ctrl + Mouse Wheel
    window.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const currentSize = parseFloat(localStorage.getItem('settings_fontSize')) || 11.5;
            let newSize = currentSize;
            if (e.deltaY < 0) {
                newSize = Math.min(30, currentSize + 0.5);
            } else {
                newSize = Math.max(8, currentSize - 0.5);
            }
            saveFontSize(newSize.toString());
        }
    }, { passive: false });
}

function setupResizers() {
    let isResizingLeft = false;

    if (EL.resizerLeft) {
        EL.resizerLeft.addEventListener('mousedown', (e) => {
            isResizingLeft = true;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });
    }

    document.addEventListener('mousemove', (e) => {
        if (isResizingLeft) {
            const newWidth = e.clientX;
            if (newWidth > 150 && newWidth < 600) {
                document.documentElement.style.setProperty('--explorer-width', `${newWidth}px`);
            }
        }
    });

    document.addEventListener('mouseup', () => {
        isResizingLeft = false;
        document.body.style.cursor = 'default';
    });
}

function saveSettings() {
    // Note: Theme saving is primarily handled in SettingsModal now.
    // This is a fallback or for other settings like compact mode.
    const isCompact = document.body.classList.contains('display-mode-compact');
    localStorage.setItem('settings_compact', isCompact ? 'true' : 'false');
}

function loadSettings() {
    const theme = localStorage.getItem('theme') || 'dark';
    const compact = localStorage.getItem('settings_compact');

    // Apply Theme (Centralized)
    applyTheme(theme);

    // Compact
    if (compact === 'true') {
        document.body.classList.add('display-mode-compact');
    } else {
        document.body.classList.remove('display-mode-compact');
    }

    // Font Size
    let fontSize = localStorage.getItem('settings_fontSize');
    // If fontSize is missing or unreasonable (e.g. 32px/24pt from broken session), reset to 10.5pt (14px)
    if (!fontSize || isNaN(fontSize) || fontSize > 18 || fontSize < 8) {
        fontSize = "10.5"; 
        localStorage.setItem('settings_fontSize', fontSize);
    }
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}pt`);

    // Dynamic line-height calculation
    const sizePt = parseFloat(fontSize);
    const sizePx = sizePt * 1.33333;
    const lineHeightPx = Math.round(sizePx * 1.5);
    document.documentElement.style.setProperty('--editor-line-height-px', `${lineHeightPx}px`);
}

export function saveFontSize(size) {
    localStorage.setItem('settings_fontSize', size);
    document.documentElement.style.setProperty('--editor-font-size', `${size}pt`);

    // Dynamic line-height calculation
    const sizePt = parseFloat(size);
    const sizePx = sizePt * 1.33333;
    const lineHeightPx = Math.round(sizePx * 1.5);
    document.documentElement.style.setProperty('--editor-line-height-px', `${lineHeightPx}px`);

    window.dispatchEvent(new CustomEvent('fontSettingsChanged', { detail: { size } }));
}
