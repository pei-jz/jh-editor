import { EL } from '../core/Constants.js';
import { showConfirm } from './Dialog.js';

/* --- Input Modal --- */
/* --- Input Modal --- */
export function showCustomInput(title, message, isConfirm = false) {
    return new Promise((resolve) => {
        const { overlay, title: titleEl, message: msgEl, input, okBtn, cancelBtn } = EL.inputModal;

        titleEl.textContent = title;
        msgEl.textContent = message;
        input.value = '';

        if (isConfirm) {
            input.style.display = 'none';
        } else {
            input.style.display = 'block';
            input.focus();
        }

        overlay.style.display = 'flex';
        // Focus OK button for confirm
        if (isConfirm) okBtn.focus();
        else input.focus();

        const close = (val) => {
            overlay.style.display = 'none';
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            input.onkeydown = null;
            window.removeEventListener('keydown', keyHandler); // Remove global key listener
            resolve(val);
        };

        okBtn.onclick = () => close(isConfirm ? true : input.value);
        cancelBtn.onclick = () => close(isConfirm ? false : null);

        const keyHandler = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                close(isConfirm ? true : input.value);
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close(isConfirm ? false : null);
            }
        };

        if (isConfirm) {
            // For confirm, input doesn't capture keys, so listen on window or buttons
            window.addEventListener('keydown', keyHandler);
        } else {
            input.onkeydown = keyHandler;
        }
    });
}

export function showCustomConfirm(title, message) {
    return showCustomInput(title, message, true);
}

export async function showNewFileModal() {
    return new Promise((resolve) => {
        const { overlay, title: titleEl, message: msgEl, input, okBtn, cancelBtn } = EL.inputModal;

        titleEl.textContent = 'New File';
        msgEl.textContent = ''; // Hide simple message, we'll use a form
        input.style.display = 'none';

        // Check for existing form container (clean up previous)
        let form = document.getElementById('new-file-form');
        if (form) form.remove();

        form = document.createElement('div');
        form.id = 'new-file-form';
        form.style.display = 'flex';
        form.style.flexDirection = 'column';
        form.style.gap = '15px';
        form.style.padding = '10px 0';

        // Name Field
        const nameGroup = document.createElement('div');
        nameGroup.className = 'form-group';
        nameGroup.innerHTML = '<label>Name:</label>';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'file_name';
        nameInput.style.width = '100%';
        nameInput.style.padding = '8px';
        nameInput.style.background = 'var(--bg-color-secondary)';
        nameInput.style.color = 'var(--text-color)';
        nameInput.style.border = '1px solid var(--border-color)';
        nameGroup.appendChild(nameInput);
        form.appendChild(nameGroup);

        // Grid for Ext and Encoding
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = '1fr 1fr';
        grid.style.gap = '10px';

        // Ext Group
        const extGroup = document.createElement('div');
        extGroup.className = 'form-group';
        extGroup.innerHTML = '<label>Extension:</label>';
        const extSelect = document.createElement('select');
        extSelect.style.width = '100%';
        extSelect.style.padding = '8px';
        extSelect.style.background = 'var(--bg-color-secondary)';
        extSelect.style.color = 'var(--text-color)';
        extSelect.style.border = '1px solid var(--border-color)';
        ['.md', '.txt', '.js', '.ts', '.css', '.html', '.json', '.rs', '.java', '.c', '.cpp', '.h', '.py', '.sql', '.xml', '.csv'].forEach(ext => {
            const opt = document.createElement('option');
            opt.value = ext;
            opt.textContent = ext;
            extSelect.appendChild(opt);
        });
        extGroup.appendChild(extSelect);
        grid.appendChild(extGroup);

        // Encoding Group
        const encGroup = document.createElement('div');
        encGroup.className = 'form-group';
        encGroup.innerHTML = '<label>Encoding:</label>';
        const encSelect = document.createElement('select');
        encSelect.style.width = '100%';
        encSelect.style.padding = '8px';
        encSelect.style.background = 'var(--bg-color-secondary)';
        encSelect.style.color = 'var(--text-color)';
        encSelect.style.border = '1px solid var(--border-color)';
        ['UTF-8', 'Shift_JIS', 'EUC-JP', 'ISO-2022-JP', 'UTF-16LE', 'UTF-16BE'].forEach(e => {
            const opt = document.createElement('option');
            opt.value = e;
            opt.textContent = e;
            encSelect.appendChild(opt);
        });
        encGroup.appendChild(encSelect);
        grid.appendChild(encGroup);

        form.appendChild(grid);

        // Insert form into modal
        if (msgEl.parentNode) {
            msgEl.parentNode.insertBefore(form, okBtn.parentNode);
        }

        overlay.style.display = 'flex';
        nameInput.focus();

        const close = (val) => {
            overlay.style.display = 'none';
            if (form) form.remove();
            input.style.display = 'block'; // Reset for other modals
            resolve(val);
        };

        const confirm = () => {
            const name = nameInput.value.trim();
            if (!name) return;
            const ext = extSelect.value;
            let finalName = name;
            if (!name.includes('.')) {
                finalName = name + ext;
            }
            close({ filename: finalName, encoding: encSelect.value });
        };

        okBtn.onclick = confirm;
        cancelBtn.onclick = () => close(null);

        nameInput.onkeydown = (e) => {
            if (e.key === 'Enter') { e.stopPropagation(); confirm(); }
            if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        };
    });
}

export async function showEncodingSelectionModal() {
    return new Promise((resolve) => {
        // Reuse input modal structure but hide input? Or just use custom input with dropdown?
        // Let's reuse inputModal but repurpose it quickly.
        const { overlay, title: titleEl, message: msgEl, input, okBtn, cancelBtn } = EL.inputModal;

        titleEl.textContent = 'Reopen with Encoding';
        msgEl.textContent = 'Select Encoding:';
        input.style.display = 'none'; // Hide text input

        let select = document.getElementById('reopen-enc-select');
        if (!select) {
            select = document.createElement('select');
            select.id = 'reopen-enc-select';
            select.style.width = '100%';
            select.style.padding = '8px';
            select.style.marginTop = '10px';
            select.style.marginBottom = '20px';
            select.style.background = 'var(--bg-color)';
            select.style.color = 'var(--text-color)';
            select.style.border = '1px solid var(--border-color)';

            ['UTF-8', 'Shift_JIS', 'EUC-JP', 'ISO-2022-JP', 'UTF-16LE', 'UTF-16BE'].forEach(e => {
                const opt = document.createElement('option');
                opt.value = e;
                opt.textContent = e;
                select.appendChild(opt);
            });
            if (input.parentNode) input.parentNode.insertBefore(select, input);
        }
        select.style.display = 'block';
        select.value = 'UTF-8'; // Default

        overlay.style.display = 'flex';
        select.focus();

        const close = (val) => {
            overlay.style.display = 'none';
            select.style.display = 'none';
            input.style.display = 'block'; // Restore
            resolve(val);
        };

        okBtn.onclick = () => close(select.value);
        cancelBtn.onclick = () => close(null);
    });
}

/* --- Preview Modal Features --- */

export function setupDraggablePreview() {
    const modalBox = document.getElementById('preview-modal');
    const header = modalBox ? modalBox.querySelector('.preview-header') : null;

    // Ensure header exists and has class for styling (added via CSS)
    if (!header) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        // Compute initial position (handle centered / fixed)
        const rect = modalBox.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        // Break out of flex centering if not already
        modalBox.style.margin = '0';
        modalBox.style.position = 'absolute';
        modalBox.style.left = `${initialLeft}px`;
        modalBox.style.top = `${initialTop}px`;
        document.body.style.cursor = 'move';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        modalBox.style.left = `${initialLeft + dx}px`;
        modalBox.style.top = `${initialTop + dy}px`;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        document.body.style.cursor = 'default';
    });
}

/**
 * The block editor is closing with unsaved edits.
 *
 * This route has no save path — the modal has its own Save button — so the only
 * real question is whether to throw the edits away. The old wording asked "Do
 * you want to save them?" while answering YES closed WITHOUT saving; the labels
 * now say what the buttons actually do.
 *
 * @returns {Promise<'YES'|'NO'>} 'YES' = discard and close, 'NO' = keep editing
 */
export async function confirmDiscardChange() {
    const discard = await showConfirm(
        'You have unsaved changes. Discard them and close the editor?',
        {
            title: 'Unsaved Changes',
            kind: 'warning',
            okLabel: 'Discard',
            cancelLabel: 'Keep Editing',
        }
    );
    return discard ? 'YES' : 'NO';
}

/* --- Tab Switcher Logic --- */
export function showTabSwitcher(files, activeIndex, onSwitch) {
    const modal = document.getElementById('tab-switcher-modal');
    const input = modal.querySelector('.tab-switcher-input');
    const list = modal.querySelector('.tab-switcher-list');

    // 1. Prepare Data with guaranteed names and original index
    const allFiles = files.map((f, i) => ({
        ...f,
        index: i,
        // Derive name if missing
        name: f.name || (f.path ? f.path.split(/[/\\]/).pop() : 'Untitled')
    }));

    // 2. State
    let filtered = [...allFiles];
    let selectedIndex = 0;

    // 3. Render
    const render = () => {
        list.innerHTML = '';
        filtered.forEach((file, idx) => {
            const li = document.createElement('li');
            li.className = 'tab-switcher-item';
            if (idx === selectedIndex) li.classList.add('selected');

            li.innerHTML = `
                <span class="tab-switcher-name">${file.name}</span>
                <span class="tab-switcher-path">${file.path || ''}</span>
            `;
            li.onclick = (e) => {
                e.preventDefault(); // Prevent accidental double-triggers
                e.stopPropagation();
                close();
                // Defer switch slightly to ensure modal is gone
                setTimeout(() => onSwitch(file.index), 10);
            };
            list.appendChild(li);
        });

        // Scroll selected into view
        if (filtered.length > 0) {
            const selectedEl = list.children[selectedIndex];
            if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
        }
    };

    const close = () => {
        modal.style.display = 'none';
        input.value = '';
        document.removeEventListener('keydown', handleKey);
        input.onkeydown = null;
    };

    const handleKey = (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = (selectedIndex + 1) % filtered.length;
            render();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
            render();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (filtered[selectedIndex]) {
                close();
                setTimeout(() => onSwitch(filtered[selectedIndex].index), 10);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    };

    input.oninput = () => {
        const query = input.value.toLowerCase();
        filtered = allFiles.filter(f =>
            f.name.toLowerCase().includes(query) ||
            (f.path && f.path.toLowerCase().includes(query))
        );
        selectedIndex = 0;
        render();
    };

    // Open
    modal.style.display = 'flex';
    input.focus();

    // Map keys
    input.onkeydown = handleKey;

    // Close on click outside
    modal.onclick = (e) => {
        if (e.target === modal) close();
    };

    // Initial Selection: Find the currently active file in the filtered list
    selectedIndex = filtered.findIndex(f => f.index === activeIndex);
    if (selectedIndex < 0) selectedIndex = 0;

    render();
}

