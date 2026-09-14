import { MergeEditor } from './MergeEditor.js';
import { makeSide } from '../utils/MergeSides.js';
import { t } from '../utils/I18n.js';

/**
 * CompareView — a scratch comparison: two editable panes, nothing on disk.
 *
 * It used to be two textareas and a Compare button that swapped the screen for
 * a read-only diff, with "Back to Edit" to change anything. The comparison view
 * edits in place now, so text is pasted straight into either side and the
 * differences follow as you type. The text lives on the tab (compareLeft /
 * compareRight), so switching tabs keeps it; being scratch, it is never
 * "unsaved".
 */
export class CompareView {
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.file = null;
        this.editor = null;
    }

    render(content, file) {
        this.file = file;
        if (this.editor) {
            this.editor.destroy();
            this.editor = null;
        }
        this.container.innerHTML = '';

        file.merge = {
            title: t('Compare Scratch Text'),
            path: '',
            nav: null,
            left: makeSide({
                label: t('Left'), text: file.compareLeft || '', writable: true, live: true,
                onLive: (value) => { file.compareLeft = value; },
            }),
            right: makeSide({
                label: t('Right'), text: file.compareRight || '', writable: true, live: true,
                onLive: (value) => { file.compareRight = value; },
            }),
        };

        this.editor = new MergeEditor(this.container, file, {
            extraActions: [
                {
                    label: t('Swap Sides'),
                    onClick: () => {
                        const left = file.compareLeft || '';
                        file.compareLeft = file.compareRight || '';
                        file.compareRight = left;
                        this.render(content, file);
                    },
                },
                {
                    label: t('Clear'),
                    onClick: () => {
                        file.compareLeft = '';
                        file.compareRight = '';
                        this.render(content, file);
                    },
                },
            ],
        });
    }

    copy() { return this.editor && this.editor.copy(); }
    cut() { return this.editor && this.editor.cut(); }
    paste() { return this.editor && this.editor.paste(); }
    undo() { if (this.editor) this.editor.undo(); }
    redo() { if (this.editor) this.editor.redo(); }
    focus() { if (this.editor) this.editor.focus(); }
    getDiagnostics() { return []; }

    // Compare tabs hold no on-disk content, so there is nothing to flush here.
    applyChanges() { /* no-op */ }

    destroy() {
        if (this.editor) {
            this.editor.destroy();
            this.editor = null;
        }
    }
}
