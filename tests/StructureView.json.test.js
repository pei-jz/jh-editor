import { describe, it, expect, vi, beforeEach } from 'vitest';

const showAlert = vi.fn(async () => true);
const invoke = vi.fn(async () => { throw new Error('should not be called for JSON'); });
const editors = [];

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(), readText: vi.fn(async () => '') }));
vi.mock('../src/modules/ui/Dialog.js', () => ({ showAlert: (...a) => showAlert(...a) }));
vi.mock('../src/modules/ui/InlineAI.js', () => ({ InlineAI: class { show() {} } }));
vi.mock('../src/modules/utils/SyntaxHighlighter.js', () => ({ SyntaxHighlighter: {} }));
vi.mock('../src/modules/utils/AsyncParser.js', () => ({ parseAsync: vi.fn() }));
vi.mock('../src/modules/editors/StructureEditor.js', () => ({
    StructureEditor: class {
        constructor(container, model, onUpdate, onSelect, options) {
            Object.assign(this, { container, model, onUpdate, options });
            this.state = { selectedNodeId: null, expandedNodes: new Set() };
            editors.push(this);
        }
        mount() {}
        render() {}
        saveState() {}
    },
}));
vi.mock('../src/modules/views/CodeMirrorView.js', () => ({
    CodeMirrorView: class {
        constructor() { this.text = ''; this.editorView = { hasFocus: false, state: { doc: { toString: () => this.text } } }; }
        render(text) { this.text = text; }
        destroy() {}
    },
}));

const { StructureView } = await import('../src/modules/views/StructureView.js');

/** Render a JSON file through the view and wait for its async parse. */
async function open(content) {
    editors.length = 0;
    const view = new StructureView(document.createElement('div'), { renderTabs: vi.fn() });
    const file = { path: 'C:/proj/data.json', content, eol: '\n', isDirty: false };
    view.render(content, file, 'json');
    await vi.waitFor(() => expect(editors.length).toBe(1));
    return { view, file, editor: editors[0] };
}

describe('StructureView on JSON', () => {
    beforeEach(() => { showAlert.mockClear(); invoke.mockClear(); });

    it('an edit in the tree rewrites only the edited value', async () => {
        const text = '{\n\t"a": 1.0,\n\t"b": "caf\\u00e9",\n\t"c": 1\n}\n';
        const { file, editor } = await open(text);
        expect(invoke).not.toHaveBeenCalledWith('parse_structured_data', expect.anything());
        editor.model.children.find((c) => c.key === 'c').value = '2';
        editor.onUpdate(editor.model);
        expect(file.content).toBe(text.replace('"c": 1', '"c": 2'));
        expect(file.isDirty).toBe(true);
    });

    it('a file with numbers that would lose precision opens read-only and says why', async () => {
        const text = '{"id": 12345678901234567890, "n": 1}';
        const { view, file, editor } = await open(text);
        expect(editor.options.readOnly).toBe(true);
        const banner = view.container.querySelector('.structure-readonly-banner');
        expect(banner && banner.textContent).toContain('12345678901234567890');

        // Nothing the tree does reaches the file.
        editor.model.children.find((c) => c.key === 'n').value = '2';
        editor.onUpdate(editor.model);
        expect(file.content).toBe(text);
        expect(file.isDirty).toBe(false);

        view.currentSelectedNode = editor.model;
        expect(view.applyChanges('{"id": 1, "n": 2}')).toBe(false);
        expect(showAlert).toHaveBeenCalled();
        expect(file.content).toBe(text);
    });

    it('long digit strings inside string values do not make the file read-only', async () => {
        const { editor, view } = await open('{"id": "12345678901234567890"}');
        expect(editor.options.readOnly).toBe(false);
        expect(view.container.querySelector('.structure-readonly-banner')).toBeNull();
    });

    it('the source pane shows the node in the file\'s indentation, and applying it patches the file', async () => {
        const text = '{\n    "keep": 1e3,\n    "obj": {\n        "x": 1\n    }\n}';
        const { view, file, editor } = await open(text);
        view.currentSelectedNode = editor.model.children.find((c) => c.key === 'obj');
        view.renderRightPane(document.createElement('div'));
        expect(view.cmView.text).toBe('{\n    "x": 1\n}');

        expect(view.applyChanges('{\n    "x": 2\n}')).toBe(true);
        expect(file.content).toBe('{\n    "keep": 1e3,\n    "obj": {\n        "x": 2\n    }\n}');
    });
});
