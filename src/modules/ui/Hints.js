
import { State } from '../core/Store.js';
import { selectBlock } from '../core/Editor.js';

let hints = [];
let hintContainer = null;
let inputBuffer = '';

/**
 * Shows hints for clickable elements.
 */
export function showHints() {
    if (hintContainer) {
        removeHints();
        return;
    }

    // 1. Identify Clickable Elements
    // We want to target:
    // - Buttons (Toolbar, Actions)
    // - Inputs/Textareas (if any, though in Normal mode mostly explicit)
    // - Links (in Preview or Help)
    // - .md-block (for selection/edit? No, usually 'Enter' does that. But maybe nice to jump?)
    // - .file-item (Explorer)
    // - .tree-item (Explorer)
    // - .tab (Tabs)

    // User request: "like Vimium 'i' key... focus clickable key".
    // "i" usually enters insert mode in Vim. User wants 'f' (Link Hints) behavior but mapped to 'i'?
    // "vim chrome extension like 'i' press -> key focus". 
    // Vimium 'f' is for links. 'i' is insert.
    // User specifically asked for 'i'. So we overwrite 'i'.

    const selectors = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'textarea',
        '[tabindex]:not([tabindex="-1"])',
        '.tree-item',
        '.file-item',
        '.tab',
        '.md-block', // Allow jumping to blocks
        '.edit-icon' // Explicit edit buttons
    ];

    const elements = Array.from(document.querySelectorAll(selectors.join(',')))
        .filter(el => {
            const rect = el.getBoundingClientRect();
            // Check visibility
            return xIsVisible(el) && rect.width > 0 && rect.height > 0;
        });

    if (elements.length === 0) return;

    // 2. Generate Hint Strings
    // Simple strategy: a, s, d, f, g, h, j, k, l... 
    // or aa, as, ad...
    const hintStrings = generateHintStrings(elements.length);

    hints = elements.map((el, i) => ({
        element: el,
        label: hintStrings[i]
    }));

    // 3. Render Hints
    renderHintsOverlay();

    // 4. Listen for Input
    inputBuffer = '';
    document.addEventListener('keydown', handleHintInput, true);
}

function removeHints() {
    if (hintContainer) {
        hintContainer.remove();
        hintContainer = null;
    }
    document.removeEventListener('keydown', handleHintInput, true);
    hints = [];
    inputBuffer = '';
}

function handleHintInput(e) {
    if (!hintContainer) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
        removeHints();
        return;
    }

    if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
        inputBuffer += e.key.toLowerCase();
        filterHints();
    } else if (e.key === 'Backspace') {
        inputBuffer = inputBuffer.slice(0, -1);
        filterHints();
    }
}

function filterHints() {
    // Check exact match
    const match = hints.find(h => h.label === inputBuffer);
    if (match) {
        // EXECUTE
        activateElement(match.element);
        removeHints();
        return;
    }

    // Check if distinct (no other hint starts with this prefix)?
    // Or just partial match highlighting?
    // Vimium style: If you type 'a', and you have 'a' and 'aa', it waits?
    // My generator uses fixed length? Mixed?
    // Let's assume standard behavior:
    // If inputBuffer matches a label EXACTLY and NO other label starts with inputBuffer, execute.
    // If multiple start with it, wait.
    // If none start with it, invalid.

    const candidates = hints.filter(h => h.label.startsWith(inputBuffer));
    if (candidates.length === 0) {
        // Invalid input, maybe reset or beep?
        // For now just keep buffer but show nothing matches
        // inputBuffer = inputBuffer.slice(0, -1); // Undo?
    } else if (candidates.length === 1 && candidates[0].label === inputBuffer) {
        activateElement(candidates[0].element);
        removeHints();
    } else {
        // Update UI to show matched chars
        updateHintsUI();
    }
}

function updateHintsUI() {
    hints.forEach(hint => {
        const hintEl = document.getElementById(`hint-${hint.label}`);
        if (!hintEl) return;

        if (hint.label.startsWith(inputBuffer)) {
            hintEl.style.display = 'block';
            hintEl.style.opacity = '1';
            // Highlight matched part
            // Simple logic:
            if (inputBuffer.length > 0) {
                // Colorize the matched prefix?
                hintEl.innerHTML = `<span style="color: #ffcccc">${inputBuffer.toUpperCase()}</span>${hint.label.substring(inputBuffer.length).toUpperCase()}`;
            } else {
                hintEl.textContent = hint.label.toUpperCase();
            }
            // Bring to front?
            hintEl.style.zIndex = '10001';
        } else {
            hintEl.style.display = 'none';
        }
    });
}

function activateElement(el) {
    el.focus();
    el.click();

    // Special case for our app:
    // If it is a .md-block, we might want to just Select it (Vim mode) or Activate it?
    // User said "Key focus possible". 
    // If I click a block, it usually just selects/activates editing depending on logic.
    // Our 'click' handler on md-block does selection?
    // Let's check Editor.js... 
    // md-block has NO click handler? It has ondblclick.
    // Wait, Editor.js: `div.tabIndex = -1;`
    // `div.ondblclick = ...`
    // It seems clicking a block doesn't do much by default unless we wired `selectBlock`?
    // Actually `setupDraggablePreview`... no.
    // `selectBlock` is called by `moveSelection`.
    // Clicking... ah, `Editor.js` doesn't explicitly handle single click on block for selection update?
    // `Vim.js` handles `document.addEventListener('click'... if target is not interactive...`
    // But if I implicitly click a block, native focus happens?
    // Let's ensure if it's a block, we invoke `selectBlock`.

    if (el.classList.contains('md-block')) {
        // Find index
        const blocks = Array.from(document.querySelectorAll('.md-block'));
        const idx = blocks.indexOf(el);
        if (idx !== -1) {
            selectBlock(idx);
        }
    }
}

function renderHintsOverlay() {
    hintContainer = document.createElement('div');
    hintContainer.id = 'vim-hints-container';
    Object.assign(hintContainer.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: '10000'
    });

    hints.forEach(hint => {
        const rect = hint.element.getBoundingClientRect();
        const label = document.createElement('div');
        label.id = `hint-${hint.label}`;
        label.textContent = hint.label.toUpperCase();
        Object.assign(label.style, {
            position: 'absolute',
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            backgroundColor: '#ffc107', // Yellow hint
            color: '#000',
            border: '1px solid #d39e00',
            borderRadius: '2px',
            padding: '0 4px',
            fontSize: '12px',
            fontWeight: 'bold',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            fontFamily: 'monospace',
            zIndex: '10001'
        });

        // Smart positioning if offscreen? 
        // For now simple top-left.

        hintContainer.appendChild(label);
    });

    document.body.appendChild(hintContainer);
}

function generateHintStrings(count) {
    const chars = 'asdfghjklqwertyuiopzxcvbnm';
    const result = [];

    // Simplest strategy: single chars then double
    // 1-char: 26
    // 2-char: 26*26 = 676

    if (count <= 26) {
        return chars.slice(0, count).split('');
    }

    // Generate 2-char hints
    // We can be smarter (use single chars for most visible?)
    // But simple AA, AB... is fine.

    let index = 0;
    for (let c1 of chars) {
        for (let c2 of chars) {
            result.push(c1 + c2);
            index++;
            if (index >= count) return result;
        }
    }
    return result;
}

function xIsVisible(elt) {
    return !!(elt.offsetWidth || elt.offsetHeight || elt.getClientRects().length);
}
