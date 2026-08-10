import { State } from '../core/Store.js';
import { selectBlock, activateBlock, focusEditor } from '../core/Editor.js';
import { focusExplorer } from '../core/Explorer.js';
import { showHints } from '../ui/Hints.js';

// Vim's global key/click/focus handlers must only act when Vim mode is enabled.
// Otherwise they steal focus back to the Markdown block (e.g. clicking the
// terminal or explorer wouldn't hold focus). Read fresh so toggling applies live.
const isVimEnabled = () => localStorage.getItem('settings_vimMode') === 'true';


export function updateVimStatus() {
    const el = document.getElementById('status-vim-mode');
    if (!el) return;
    
    const isVimEnabled = localStorage.getItem('settings_vimMode') === 'true';
    if (isVimEnabled && State.vimState) {
        el.style.display = 'inline';
        el.textContent = State.vimState.mode.toUpperCase();
        if (State.vimState.mode === 'insert') {
            el.style.color = '#4caf50'; // Green for Insert
        } else {
            el.style.color = 'var(--primary-color)';
        }
    } else {
        el.style.display = 'none';
    }
}

export function initVimMode() {
    // Initial display sync
    updateVimStatus();

    document.addEventListener('keydown', (e) => {
        if (!isVimEnabled()) return;
        const tag = e.target.tagName.toLowerCase();
        const isTableActive = e.target.classList.contains('active-cell') || e.target.closest('.active-cell');
        const isInput = tag === 'input' || tag === 'textarea' || e.target.isContentEditable || isTableActive;

        // Ignore other keys if in Input/Insert mode
        if (State.vimState.mode === 'insert' || isInput) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                const saveBtn = document.querySelector('.editing .btn-save');
                if (saveBtn) {
                    e.preventDefault();
                    saveBtn.click();
                    State.vimState.mode = 'normal';
                    updateVimStatus();
                }
            }
            if (e.key === 'Escape') {
                const cancelBtn = document.querySelector('.editing .btn-cancel');
                if (cancelBtn) {
                    e.preventDefault();
                    cancelBtn.click();
                    State.vimState.mode = 'normal';
                    updateVimStatus();
                } else if ((tag === 'textarea' && e.target.classList.contains('plain-text-editor'))
                    || (e.target.closest && e.target.closest('.cm-editor'))) {
                    // Plain text / CodeMirror editor vim-like esc fallback
                    State.vimState.mode = 'normal';
                    updateVimStatus();
                }
            }
            return;
        }

        // --- NORMAL MODE ---
        if (State.vimState.mode === 'normal') {
            const inExplorer = document.activeElement && document.activeElement.closest('#explorer');
            // The explorer's virtual scroll synchronously wipes its rows while
            // handling a keydown (setFocus → render → innerHTML=''), which drops
            // document.activeElement to <body> and makes the closest('#explorer')
            // check above miss. VirtualExplorer.handleKeyDown stamps every event
            // it processes, so use the stamp as the authoritative signal that
            // the explorer owns this key.
            const explorerOwnsKey = e.__explorerKeyDown;

            if (inExplorer || explorerOwnsKey) {
                // --- EXPLORER NAVIGATION ---
                if (e.key === 'ArrowDown' || e.key === 'j') {
                    e.preventDefault();
                    moveFocusInExplorer(1);
                } else if (e.key === 'ArrowUp' || e.key === 'k') {
                    e.preventDefault();
                    moveFocusInExplorer(-1);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    document.activeElement.click();
                } else if (e.key === 'f') {
                    // Also allow Hints in Explorer
                    e.preventDefault();
                    showHints();
                    return;
                }
                return; // Stop Editor logic
            }

            // --- EDITOR NAVIGATION ---

            // Text Selection (Shift + Arrows)
            if (e.shiftKey) {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    // Manual selection expansion
                    const selection = window.getSelection();
                    const direction = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 'forward' : 'backward';
                    const granularity = (e.key === 'ArrowUp' || e.key === 'ArrowDown') ? 'line' : 'character';

                    try {
                        selection.modify('extend', direction, granularity);
                        // Prevent default scrolling if we handled it
                        e.preventDefault();
                    } catch (err) {
                        // Fallback
                        console.warn('Selection modify failed', err);
                    }
                    return;
                }
            }

            // Movement (No Shift)
            if (e.key === 'j' || e.key === 'ArrowDown') {
                e.preventDefault();
                moveSelection(1);
            } else if (e.key === 'k' || e.key === 'ArrowUp') {
                e.preventDefault();
                moveSelection(-1);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                // Allow caret movement if we want? Or block navigation?
                if (!e.shiftKey) {
                    const selection = window.getSelection();
                    const direction = (e.key === 'ArrowRight') ? 'forward' : 'backward';
                    try {
                        selection.modify('move', direction, 'character');
                        //  e.preventDefault(); // Maybe?
                    } catch (err) { }
                }
                return;
            }

            // Action
            if (e.key === 'Enter') {
                e.preventDefault();
                activateBlock(State.vimState.selectedIndex);
            }

            // --- HINT MODE ---
            if (e.key === 'f') {
                e.preventDefault();
                showHints();
            }
            // --- INSERT MODE ---
            if (e.key === 'i') {
                e.preventDefault();
                State.vimState.mode = 'insert';
                updateVimStatus();
                const blocks = document.querySelectorAll('.md-block');
                const index = State.vimState.selectedIndex;
                if (blocks[index]) {
                    activateBlock(index);
                }
            }
            if (e.key === 'o') {
                e.preventDefault();
                State.vimState.mode = 'insert';
                updateVimStatus();
                const blocks = document.querySelectorAll('.md-block');
                if (blocks.length > 0) {
                    selectBlock(blocks.length - 1);
                    activateBlock(blocks.length - 1);
                }
            }
        }
    });

    // console.log('Vim Mode initialized');
}

function moveSelection(delta) {
    const current = State.vimState.selectedIndex;
    selectBlock(current + delta);
}

function moveFocusInExplorer(delta) {
    const active = document.activeElement;
    if (!active || !active.classList.contains('file-item')) return;

    const all = Array.from(document.querySelectorAll('.file-item'));
    if (all.length === 0) return;

    const index = all.indexOf(active);

    let nextIndex = index + delta;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= all.length) nextIndex = all.length - 1;

    all[nextIndex].focus();
}

// Window Focus Restoration
const restoreFocus = async () => {
    if (!isVimEnabled()) return;
    // If we're in normal mode, aggressive restore
    if (State.vimState && State.vimState.mode === 'normal') {

        // Force Window Focus
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().setFocus();
        } catch (e) { }

        window.focus();

        setTimeout(() => {
            const blocks = document.querySelectorAll('.md-block');
            const index = State.vimState.selectedIndex;
            const targetBlock = blocks[index];

            if (targetBlock) {
                // Hack: Create temporary input to grab deep focus
                const tempInput = document.createElement('input');
                tempInput.style.position = 'absolute';
                tempInput.style.opacity = '0';
                tempInput.style.height = '0';
                tempInput.style.top = '0';
                tempInput.style.left = '0';
                document.body.appendChild(tempInput);

                tempInput.focus();

                setTimeout(() => {
                    // Cleanup and switch to block
                    targetBlock.focus({ preventScroll: true });
                    tempInput.remove();
                    // console.log('Focus reset via temp input complete');
                }, 10);
            }
        }, 50);
    }
};

window.addEventListener('focus', restoreFocus);

// Native Window Focus (Tauri)
// Tauri handles window focus events natively through 'focus' event on window usually.
// But we can listen to explicit tauri event if needed.

// Background Click Focus Restoration
document.addEventListener('click', (e) => {
    if (!isVimEnabled()) return;
    // If clicking on the app background (not an interactive element)
    // and in normal mode, refocus the active block.
    if (State.vimState.mode === 'normal') {
        const isInteractive = e.target.closest('input, textarea, button, a, .md-block, .file-item, .modal');
        if (!isInteractive) {
            const blocks = document.querySelectorAll('.md-block');
            const index = State.vimState.selectedIndex;
            if (blocks[index]) {
                blocks[index].focus({ preventScroll: true });
            }
        }
    }
});
