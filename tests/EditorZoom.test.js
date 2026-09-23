import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
vi.mock('@tauri-apps/plugin-fs', () => ({ watch: vi.fn(async () => () => {}) }));

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
const { CodeMirrorView } = await import('../src/modules/views/CodeMirrorView.js');
const { State } = await import('../src/modules/core/Store.js');
const { EL } = await import('../src/modules/core/Constants.js');
const { initLayout } = await import('../src/modules/core/Layout.js');
const { renderEditor, closeAllTabs } = await import('../src/modules/core/Editor.js');

// Exercise the real wheel handler, view lifecycle and Markdown render entry.
// Page layout and CodeMirror measurement require a browser, so only those
// rendering backends are replaced with text in these lifecycle tests.
initLayout();

describe('Ctrl+wheel keeps the current document', () => {
    let bookRender;
    let markdownViews;
    const md = () => ({ name: 'previous.md', content: '# Previous Markdown', viewMode: 'structure' });
    const js = () => ({ name: 'eslint.config.js', content: 'export default [];', viewMode: 'text' });
    const show = (file) => {
        State.openFiles = [file];
        State.activeTabIndex = 0;
        renderEditor('left');
    };
    const wheel = (deltaY = -100) => {
        const event = new WheelEvent('wheel', { ctrlKey: true, deltaY, bubbles: true, cancelable: true });
        EL.editorContent.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    };

    beforeEach(() => {
        document.body.innerHTML = '<div id="tab-bar"><div id="tabs-container"></div></div><div id="editor-content"></div><div id="editor-content-right"></div>';
        EL.tabsContainer = document.getElementById('tabs-container');
        EL.editorContent = document.getElementById('editor-content');
        EL.editorContentRight = document.getElementById('editor-content-right');
        State.openFiles = [];
        State.activeTabIndex = -1;
        State.rightOpenFiles = [];
        State.rightActiveTabIndex = -1;
        State.splitMode = false;
        State.activePane = 'left';
        State.markdownViewMode = 'book';
        localStorage.setItem('settings_fontSize', '11');
        markdownViews = new Set();
        bookRender = vi.spyOn(MarkdownView.prototype, '_renderBookMode').mockImplementation(function () {
            markdownViews.add(this);
            this.container.textContent = this.file.content;
        });
        vi.spyOn(CodeMirrorView.prototype, 'render').mockImplementation(function (content, file) {
            this.file = file;
            this.container.textContent = content;
        });
    });

    afterEach(async () => {
        await closeAllTabs(false);
        for (const view of markdownViews) view.destroy();
        State.markdownViewMode = 'scroll';
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('zooms a text file after switching from Markdown', () => {
        show(md());
        const file = js();
        show(file);
        wheel();
        expect(EL.editorContent.textContent).toBe(file.content);
        expect(bookRender).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('settings_fontSize')).toBe('11.5');
        expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe('11.5pt');
        wheel(100);
        expect(localStorage.getItem('settings_fontSize')).toBe('11');
        expect(EL.editorContent.textContent).toBe(file.content);
    });

    it('releases the Markdown listener when closing all tabs before opening a text file', async () => {
        show(md());
        const oldView = window.app.getCurrentView();
        const destroy = vi.spyOn(oldView, 'destroy');
        await closeAllTabs(false);
        const file = js();
        show(file);
        wheel();
        expect(EL.editorContent.textContent).toBe(file.content);
        expect(bookRender).toHaveBeenCalledTimes(1);
        expect(destroy).toHaveBeenCalledOnce();
    });

    it('ignores a stale font callback after another view takes over', () => {
        show(md());
        const oldView = window.app.getCurrentView();
        const file = js();
        show(file);
        oldView._onFontChange();
        expect(EL.editorContent.textContent).toBe(file.content);
        expect(bookRender).toHaveBeenCalledTimes(1);
    });

    it('still repaginates visible Markdown in the other split pane', () => {
        show(js());
        State.splitMode = true;
        const file = md();
        State.rightOpenFiles = [file];
        State.rightActiveTabIndex = 0;
        renderEditor('right');
        wheel();
        expect(EL.editorContent.textContent).toBe('export default [];');
        expect(EL.editorContentRight.textContent).toBe(file.content);
        expect(bookRender).toHaveBeenCalledTimes(2);
    });
});
