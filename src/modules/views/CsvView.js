import { BaseView } from './BaseView.js';
import { CsvEditor } from '../editors/CsvEditor.js';

export class CsvView extends BaseView {
    constructor(container, callbacks = {}) {
        super(container);
        this.renderTabs = callbacks.renderTabs;
    }

    render(content, file) {
        this.container.innerHTML = '';
        this.file = file;

        const wrapper = document.createElement('div');
        wrapper.className = 'csv-wrapper';
        wrapper.style.height = '100%';
        wrapper.style.overflow = 'auto';

        CsvEditor.render(wrapper, content, (newContent) => {
            this.file.content = newContent;
            if (!this.file.isDirty) {
                this.file.isDirty = true;
                if (this.renderTabs) this.renderTabs();
            }
        });

        this.container.appendChild(wrapper);

        // Restore the grid scroll position (saved in destroy()) so switching
        // tabs and coming back keeps the same viewport.
        const inst = CsvEditor.activeInstance;
        if (inst && inst.gridContainer && (file._csvScrollTop || file._csvScrollLeft)) {
            requestAnimationFrame(() => {
                if (!inst.gridContainer) return;
                inst.gridContainer.scrollTop = file._csvScrollTop || 0;
                inst.gridContainer.scrollLeft = file._csvScrollLeft || 0;
                if (inst.scroller) inst.scroller.onScroll(); // re-render virtualized rows
            });
        }
    }

    async copy() {
        if (CsvEditor.activeInstance) await CsvEditor.activeInstance.copy();
    }

    async cut() {
        if (CsvEditor.activeInstance) await CsvEditor.activeInstance.cut();
    }

    async paste() {
        if (CsvEditor.activeInstance) await CsvEditor.activeInstance.paste();
    }

    handleShortcut(command, e) {
        if (CsvEditor.activeInstance && CsvEditor.activeInstance.handleShortcut) {
            return CsvEditor.activeInstance.handleShortcut(command, e);
        }
        return false;
    }

    // --- Search panel integration (grid mode only) ---
    isCsvGridMode() {
        return !!(CsvEditor.activeInstance && CsvEditor.activeInstance.mode === 'grid');
    }

    collectCsvMatches(pred) {
        if (!this.isCsvGridMode()) return [];
        return CsvEditor.activeInstance.collectCsvMatches(pred);
    }

    gotoCsvMatch(m) {
        if (CsvEditor.activeInstance) CsvEditor.activeInstance.gotoCsvMatch(m);
    }

    undo() {
        if (CsvEditor.activeInstance && CsvEditor.activeInstance.model) {
            if (CsvEditor.activeInstance.model.undo()) {
                CsvEditor.activeInstance.view.updateData();
                CsvEditor.activeInstance.view.refreshSelection();
                CsvEditor.activeInstance.onSave(CsvEditor.activeInstance.model.serialize());
            }
        }
    }

    redo() {
        if (CsvEditor.activeInstance && CsvEditor.activeInstance.model) {
            if (CsvEditor.activeInstance.model.redo()) {
                CsvEditor.activeInstance.view.updateData();
                CsvEditor.activeInstance.view.refreshSelection();
                CsvEditor.activeInstance.onSave(CsvEditor.activeInstance.model.serialize());
            }
        }
    }

    destroy() {
        if (CsvEditor.activeInstance) {
            // Save the grid scroll position before teardown so it can be
            // restored when this tab is reopened.
            const inst = CsvEditor.activeInstance;
            if (this.file && inst.gridContainer) {
                try {
                    this.file._csvScrollTop = inst.gridContainer.scrollTop;
                    this.file._csvScrollLeft = inst.gridContainer.scrollLeft;
                } catch (e) { /* ignore */ }
            }
            inst.destroy();
            CsvEditor.activeInstance = null;
        }
        this.container.innerHTML = '';
    }

    getDiagnostics() {
        return [];
    }
}
