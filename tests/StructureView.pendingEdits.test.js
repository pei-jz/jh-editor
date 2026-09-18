import { describe, it, expect, vi, beforeEach } from 'vitest';

const showAlert = vi.fn(async () => true);

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn(async () => '') }));
vi.mock('../src/modules/ui/Dialog.js', () => ({ showAlert: (...a) => showAlert(...a) }));
vi.mock('../src/modules/ui/InlineAI.js', () => ({ InlineAI: class { show() {} } }));
vi.mock('../src/modules/utils/SyntaxHighlighter.js', () => ({ SyntaxHighlighter: {} }));
vi.mock('../src/modules/utils/AsyncParser.js', () => ({ parseAsync: vi.fn() }));
vi.mock('../src/modules/editors/StructureEditor.js', () => ({ StructureEditor: class {} }));

/**
 * Stand-in for the source pane's CodeMirrorView: holds text, and calls the
 * renderTabs option on every change the way the real view's update listener
 * does. `type()` is a user edit.
 */
vi.mock('../src/modules/views/CodeMirrorView.js', () => ({
    CodeMirrorView: class {
        constructor(container, options) {
            this.options = options;
            this.text = '';
            const self = this;
            this.editorView = { hasFocus: false, state: { doc: { toString: () => self.text } } };
            this.undo = vi.fn();
            this.redo = vi.fn();
            this.replaceSelectedText = vi.fn();
        }
        render(text) { this.text = text; }
        type(text) {
            this.text = text;
            if (typeof this.options.renderTabs === 'function') this.options.renderTabs();
        }
        destroy() {}
    },
}));

const { StructureView } = await import('../src/modules/views/StructureView.js');
const { XmlParser } = await import('../src/modules/utils/XmlParser.js');
const { markSaved } = await import('../src/modules/utils/DirtyState.js');

const SOURCE = '<root>\n  <a>1</a>\n</root>';

/** A StructureView showing <a> in its source pane, as after a tree click. */
function openOnNodeA() {
    const renderTabs = vi.fn();
    const view = new StructureView(document.createElement('div'), { renderTabs });
    const model = XmlParser.parse(SOURCE);
    const file = { path: 'C:/proj/doc.xml', content: SOURCE, eol: '\n', isDirty: false };
    markSaved(file);
    view.currentFile = file;
    view.currentType = 'xml';
    view.parser = XmlParser;
    view.editor = { model, saveState: vi.fn(), render: vi.fn() };
    view.currentSelectedNode = model.children.find((c) => c.key === 'a');
    view.renderRightPane(document.createElement('div'));
    return { view, file, renderTabs, pane: view.cmView };
}

describe('StructureView source pane', () => {
    beforeEach(() => showAlert.mockClear());

    it('shows the tab as modified as soon as the pane is edited', () => {
        const { file, renderTabs, pane } = openOnNodeA();
        expect(pane.text).toBe('<a>1</a>');
        pane.type('<a>2</a>');
        expect(file.isDirty).toBe(true);
        expect(renderTabs).toHaveBeenCalled();
    });

    it('typing the original text back clears the modified mark', () => {
        const { file, pane } = openOnNodeA();
        pane.type('<a>2</a>');
        pane.type('<a>1</a>');
        expect(file.isDirty).toBe(false);
    });

    it('commitPendingEdits merges the pane into file.content — what save writes', () => {
        const { view, file, pane } = openOnNodeA();
        pane.type('<a>2</a>');
        expect(file.content).toBe(SOURCE); // not merged yet: this is what used to be saved

        expect(view.commitPendingEdits()).toBe(true);
        expect(file.content).toContain('<a>2</a>');
        expect(file.content).not.toContain('<a>1</a>');
        expect(file.isDirty).toBe(true);

        // Nothing left pending: a second commit changes nothing.
        view.editor.saveState.mockClear();
        expect(view.commitPendingEdits()).toBe(true);
        expect(view.editor.saveState).not.toHaveBeenCalled();
    });

    it('refuses (false) when the pane does not parse, so save can stop', () => {
        const { view, file, pane } = openOnNodeA();
        pane.type('<a>2</b>');
        expect(view.commitPendingEdits()).toBe(false);
        expect(showAlert).toHaveBeenCalled();
        expect(file.content).toBe(SOURCE);
    });

    it('with no pending edits there is nothing to refuse', () => {
        const { view } = openOnNodeA();
        expect(view.commitPendingEdits()).toBe(true);
    });

    it('switching tabs (destroy) keeps what was typed', () => {
        const { view, file, pane } = openOnNodeA();
        pane.type('<a>3</a>');
        view.destroy();
        expect(file.content).toContain('<a>3</a>');
    });

    /*
       Half-written XML does not parse, and a tab switch destroys the pane. The
       text used to go with it — silently, and with the tab's "*" left up, so it
       looked like the edit was still there.
    */
    describe('text that does not parse yet', () => {
        it('survives a tab switch on the tab instead of dying with the pane', () => {
            const { view, file, pane } = openOnNodeA();
            pane.type('<a>3');
            view.destroy();

            expect(file.content).toBe(SOURCE); // the tree is untouched, as before
            expect(file._structPendingSource.text).toBe('<a>3');
            // Nothing was lost, so there is nothing to interrupt the user with.
            expect(showAlert).not.toHaveBeenCalled();
        });

        it('comes back into the pane on the same node', () => {
            const first = openOnNodeA();
            first.pane.type('<a>3');
            first.view.destroy();

            // A fresh view over the same tab, as renderEditor builds after a
            // switch back: a new parse, so new node ids.
            const second = openOnNodeA();
            second.view.currentFile = first.file;
            second.view.renderRightPane(document.createElement('div'));

            expect(second.view.cmView.text).toBe('<a>3');
            // Still measured against the TREE's text, so it is still an
            // unmerged edit that has to be applied.
            expect(second.view._hasPendingSourceEdits()).toBe(true);
            // ...and it is not handed out twice.
            expect(first.file._structPendingSource).toBe(null);
        });

        it('is not restored onto a node whose own text has moved on', () => {
            const { view, file, pane } = openOnNodeA();
            pane.type('<a>3');
            view.destroy();
            file._structPendingSource.baseline = '<a>99</a>';

            const second = openOnNodeA();
            second.view.currentFile = file;
            second.view.renderRightPane(document.createElement('div'));
            expect(second.view.cmView.text).toBe('<a>1</a>');
        });

        it('is cleared once the text parses and merges', () => {
            const { view, file, pane } = openOnNodeA();
            pane.type('<a>3');
            view._commitOrStash();
            expect(file._structPendingSource.text).toBe('<a>3');

            pane.type('<a>3</a>');
            view._commitOrStash();
            expect(file._structPendingSource).toBe(null);
            expect(file.content).toContain('<a>3</a>');
        });

        it('is not dropped by a successful commit on another node', () => {
            const TWO = '<root>\n  <a>1</a>\n  <b>2</b>\n</root>';
            const view = new StructureView(document.createElement('div'), {});
            const model = XmlParser.parse(TWO);
            const file = { path: 'C:/proj/two.xml', content: TWO, eol: '\n', isDirty: false };
            markSaved(file);
            view.currentFile = file;
            view.currentType = 'xml';
            view.parser = XmlParser;
            view.editor = { model, saveState: vi.fn(), render: vi.fn() };

            view.currentSelectedNode = model.children.find((c) => c.key === 'a');
            view.renderRightPane(document.createElement('div'));
            view.cmView.type('<a>3');
            view._commitOrStash();
            expect(file._structPendingSource.text).toBe('<a>3');

            // Move to the sibling and finish an edit there properly.
            view.currentSelectedNode = model.children.find((c) => c.key === 'b');
            view.renderRightPane(document.createElement('div'));
            view.cmView.type('<b>9</b>');
            expect(view._commitOrStash()).toBe(true);

            expect(file._structPendingSource.text).toBe('<a>3');
        });

        // Save is the caller that must still refuse and still say why: it is
        // about to write the file, and the edit cannot go in it.
        it('still stops a save, out loud', () => {
            const { view, file, pane } = openOnNodeA();
            pane.type('<a>3');
            expect(view.commitPendingEdits()).toBe(false);
            expect(showAlert).toHaveBeenCalled();
            expect(file.content).toBe(SOURCE);
        });
    });

    it('Ctrl+S routes to the app save even with no node open', () => {
        const view = new StructureView(document.createElement('div'), {});
        const onSave = vi.fn();
        window.addEventListener('app:save-shortcut', onSave);
        try {
            expect(view.handleShortcut('app:save')).toBe(true);
            expect(view.handleShortcut('structure:save')).toBe(true);
            expect(onSave).toHaveBeenCalledTimes(2);
        } finally {
            window.removeEventListener('app:save-shortcut', onSave);
        }
    });

    it('undo/redo/paste inside the pane go to the pane, not the tree', async () => {
        const { view, pane } = openOnNodeA();
        view.editor.undo = vi.fn(() => true);
        view.editor.redo = vi.fn(() => true);
        pane.editorView.hasFocus = true;

        view.undo();
        view.redo();
        expect(pane.undo).toHaveBeenCalled();
        expect(pane.redo).toHaveBeenCalled();
        expect(view.editor.undo).not.toHaveBeenCalled();
        expect(view.editor.redo).not.toHaveBeenCalled();

        const clipboard = await import('@tauri-apps/plugin-clipboard-manager');
        clipboard.readText.mockResolvedValueOnce('<b/>');
        await view.paste();
        expect(pane.replaceSelectedText).toHaveBeenCalledWith('<b/>');
    });
});
