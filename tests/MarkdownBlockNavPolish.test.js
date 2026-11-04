import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// ページをめくると、選択中のブロックは畳まれて (display:none) フォーカスが <body> へ
// 落ちる。このときスコープは MARKDOWN_BLOCK のままなので、ShortcutManager と
// _navKeyHandler の両方が同じ ↓ を処理し、1 ブロック目から 3 ブロック目へ飛んでいた。
// 2 回目以降はフォーカスがブロックにあるので 1 つずつ動き、↑ では 2 に戻っていた。

const load = async () => {
    const { MarkdownView } = await import('../src/modules/views/MarkdownView.js');
    const { State } = await import('../src/modules/core/Store.js');
    const { shortcuts } = await import('../src/modules/core/ShortcutManager.js');
    const { Lightbox } = await import('../src/modules/ui/Lightbox.js');
    return { MarkdownView, State, shortcuts, Lightbox };
};

describe('one ↓ moves one block', () => {
    let MarkdownView, State, shortcuts, view, savedTab, savedScope, listener;

    beforeEach(async () => {
        ({ MarkdownView, State, shortcuts } = await load());
        document.body.innerHTML = '<div id="host"></div>';
        const host = document.getElementById('host');
        Object.defineProperty(host, 'offsetParent', { get: () => document.body, configurable: true });
        view = new MarkdownView(host, {});
        view.blocksData = ['a', 'b', 'c', 'd'];
        for (let i = 0; i < 4; i++) {
            const d = document.createElement('div');
            d.className = 'md-block';
            d.dataset.index = i;
            d.tabIndex = -1;
            host.appendChild(d);
        }
        savedTab = State.activeTabIndex;
        savedScope = shortcuts.currentScope;
        State.activeTabIndex = 0;
        State.markdownViewMode = 'scroll';
        view._setCursor(0);
        view._installBlockNavKeys();
    });

    afterEach(() => {
        window.removeEventListener('keydown', view._navKeyHandler, true);
        if (listener) window.removeEventListener('shortcutTriggered', listener);
        listener = null;
        State.activeTabIndex = savedTab;
        shortcuts.setScope(savedScope);
        document.body.innerHTML = '';
    });

    const pressDown = () => document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );

    it('moves once when the shortcut scope already handled the key', () => {
        // めくった直後の状態: フォーカスは body、スコープは MARKDOWN_BLOCK のまま。
        shortcuts.setScope('MARKDOWN_BLOCK');
        document.body.focus();
        const step = vi.spyOn(view, 'navigateBlock');
        // 実アプリでは md-block:nav の action がこのビューを動かす。その 1 回を再現する。
        const match = shortcuts.shortcuts.find((s) => s.cmd === 'md-block:nav' && s.key === 'ArrowDown' && s.scope === 'MARKDOWN_BLOCK');
        const saved = match.action;
        match.action = () => view.navigateBlock(1);
        try {
            pressDown();
        } finally {
            match.action = saved;
        }
        expect(step).toHaveBeenCalledTimes(1);
        expect(State.vimState.selectedIndex).toBe(1);
    });

    it('still moves by itself when no shortcut claimed the key', () => {
        shortcuts.setScope('GLOBAL');
        pressDown();
        expect(State.vimState.selectedIndex).toBe(1);
    });
});

describe('Lightbox closes on a click outside the content', () => {
    let Lightbox;
    const mouse = (type, x = 10, y = 10) => new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });

    beforeEach(async () => {
        ({ Lightbox } = await load());
        document.body.innerHTML = '<img id="src" alt="x">';
        Lightbox.open(document.getElementById('src'));
    });

    afterEach(() => {
        document.getElementById('jh-lightbox')?.remove();
        document.body.innerHTML = '';
    });

    const isOpen = () => !!document.getElementById('jh-lightbox');
    const stage = () => document.querySelector('.lb-stage');

    it('closes on a click on the empty stage', () => {
        stage().dispatchEvent(mouse('mousedown'));
        window.dispatchEvent(mouse('mouseup'));
        expect(isOpen()).toBe(false);
    });

    it('stays open after a pan that started on the empty stage', () => {
        stage().dispatchEvent(mouse('mousedown', 10, 10));
        window.dispatchEvent(mouse('mousemove', 60, 40));
        window.dispatchEvent(mouse('mouseup', 60, 40));
        expect(isOpen()).toBe(true);
    });

    it('stays open on a click on the content itself', () => {
        document.querySelector('.lb-inner img').dispatchEvent(mouse('mousedown'));
        window.dispatchEvent(mouse('mouseup'));
        expect(isOpen()).toBe(true);
    });

    it('stays open when a toolbar button is pressed', () => {
        document.querySelector('.lb-btn').dispatchEvent(mouse('mousedown'));
        expect(isOpen()).toBe(true);
    });

    it('closes on the hint line, which is outside the content too', () => {
        document.querySelector('.lb-hint').dispatchEvent(mouse('mousedown'));
        expect(isOpen()).toBe(false);
    });
});

describe('block selection draws only the bar', () => {
    const css = readFileSync('src/styles/editor.css', 'utf8').replace(/\r\n/g, '\n');
    const rule = (selector) => {
        const at = css.indexOf(`\n${selector} {`);
        expect(at).toBeGreaterThanOrEqual(0);
        return css.slice(at, css.indexOf('}', at));
    };

    it('has no frame or fill on the selected block', () => {
        // 棒は ::before に描く。ブロック自体には枠も塗りも付けない。
        expect(css).not.toMatch(/\n\.md-block\.(selected|range-selected) \{/);
        expect(rule('.md-block.range-selected::before')).toContain('background-color');
    });

    it('keeps the bar off the text, in the margin outside the block', () => {
        const at = css.indexOf('\n.md-block.selected::before,');
        expect(at).toBeGreaterThanOrEqual(0);
        expect(css.slice(at, css.indexOf('}', at))).toMatch(/left: -\d+px/);
    });

    it('draws nothing around a hovered block', () => {
        expect(css).not.toMatch(/\n\.md-block:hover \{/);
        expect(css).toMatch(/\.md-block:hover \.md-block-tools/);
    });
});
