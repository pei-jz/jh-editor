import { DiffEditor } from './DiffEditor.js';

/**
 * CompareView — an empty, file-independent diff workspace.
 *
 * The user pastes arbitrary text into two full-height panes and presses 「比較」
 * to swap the whole view over to a full-height diff (rather than squeezing the
 * diff into the lower half). A 「編集に戻る」 button returns to the editable panes.
 * Left/right text lives on the tab's file object so switching tabs keeps it.
 */
export class CompareView {
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.file = null;
        this.diffEditor = null;
    }

    render(content, file) {
        this.file = file;
        this.container.classList.add('compare-view');
        // Open straight into the diff if both sides already hold text (tab re-open).
        if (file && (file.compareLeft || file.compareRight)) {
            this.renderResultMode();
        } else {
            this.renderEditMode();
        }
    }

    // ── Edit mode: two full-height editable panes + toolbar ──────────────────
    renderEditMode() {
        if (this.diffEditor) { this.diffEditor.destroy(); this.diffEditor = null; }
        this.container.innerHTML = '';
        // DiffEditor sets inline layout styles on the shared container; clear them
        // so the edit-mode layout (driven by .compare-view / .compare-root) applies.
        this.container.removeAttribute('style');
        this.container.classList.add('compare-view');

        const root = document.createElement('div');
        root.className = 'compare-root';

        const toolbar = document.createElement('div');
        toolbar.className = 'compare-toolbar';

        const compareBtn = document.createElement('button');
        compareBtn.className = 'compare-btn compare-btn-primary';
        compareBtn.textContent = 'Compare (Ctrl+Enter)';
        compareBtn.onclick = () => this.runCompare();

        const swapBtn = document.createElement('button');
        swapBtn.className = 'compare-btn';
        swapBtn.textContent = '⇄ Swap Sides';
        swapBtn.onclick = () => {
            const l = this.leftInput.value;
            this.leftInput.value = this.rightInput.value;
            this.rightInput.value = l;
            this._syncToFile();
        };

        const clearBtn = document.createElement('button');
        clearBtn.className = 'compare-btn';
        clearBtn.textContent = 'Clear';
        clearBtn.onclick = () => {
            this.leftInput.value = '';
            this.rightInput.value = '';
            this._syncToFile();
            this.leftInput.focus();
        };

        toolbar.appendChild(compareBtn);
        toolbar.appendChild(swapBtn);
        toolbar.appendChild(clearBtn);

        const inputPanel = document.createElement('div');
        inputPanel.className = 'compare-input-panel';

        const makeSide = (labelText, value, key) => {
            const col = document.createElement('div');
            col.className = 'compare-input-col';

            const label = document.createElement('div');
            label.className = 'compare-input-label';
            label.textContent = labelText;

            const ta = document.createElement('textarea');
            ta.className = 'compare-input';
            ta.spellcheck = false;
            ta.value = value || '';
            ta.placeholder = 'Paste or type text here…';
            ta.addEventListener('input', () => { if (this.file) this.file[key] = ta.value; });
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    this.runCompare();
                }
            });

            col.appendChild(label);
            col.appendChild(ta);
            return { col, ta };
        };

        const left = makeSide('Left', this.file ? this.file.compareLeft : '', 'compareLeft');
        const right = makeSide('Right', this.file ? this.file.compareRight : '', 'compareRight');
        this.leftInput = left.ta;
        this.rightInput = right.ta;

        inputPanel.appendChild(left.col);
        inputPanel.appendChild(right.col);

        root.appendChild(toolbar);
        root.appendChild(inputPanel);
        this.container.appendChild(root);
    }

    _syncToFile() {
        if (!this.file) return;
        this.file.compareLeft = this.leftInput ? this.leftInput.value : '';
        this.file.compareRight = this.rightInput ? this.rightInput.value : '';
    }

    runCompare() {
        this._syncToFile();
        const leftText = this.file ? (this.file.compareLeft || '') : '';
        const rightText = this.file ? (this.file.compareRight || '') : '';
        if (leftText === '' && rightText === '') {
            this.leftInput && this.leftInput.focus();
            return;
        }
        this.renderResultMode();
    }

    // ── Result mode: full-height diff with a back-to-edit button ─────────────
    renderResultMode() {
        if (this.diffEditor) { this.diffEditor.destroy(); this.diffEditor = null; }
        this.container.innerHTML = '';
        const leftText = this.file ? (this.file.compareLeft || '') : '';
        const rightText = this.file ? (this.file.compareRight || '') : '';
        this.diffEditor = new DiffEditor(
            this.container,
            leftText,
            rightText,
            '',
            null,
            {
                compareMode: true,
                leftLabel: 'Left',
                rightLabel: 'Right',
                onBack: () => this.renderEditMode()
            }
        );
    }

    // Compare tabs hold no on-disk content, so there is nothing to flush here.
    applyChanges() { /* no-op */ }

    destroy() {
        if (this.diffEditor) { this.diffEditor.destroy(); this.diffEditor = null; }
        if (this.container) this.container.classList.remove('compare-view');
    }
}
