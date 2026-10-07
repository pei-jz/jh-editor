import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
    convertFileSrc: (p) => `asset://localhost/${p}`,
}));
vi.mock('../src/modules/utils/FileSystem.js', () => ({
    getParentDir: (p) => String(p).replace(/\\/g, '/').replace(/\/[^/]*$/, ''),
}));

const {
    DeckEdit, isDeckFile, isDeckTrusted, trustDeck, editableCounts, canEditDeck, applyDeckChange,
} = await import('../src/modules/utils/DeckHost.js');
const { DeckView } = await import('../src/modules/views/DeckView.js');

// jh-presentation が書き出すデッキの最小形 (meta generator と jh:slides ブロック)
const DECK = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="generator" content="jh-presentation 0.5.2">
<title>T</title></head><body>
<div class="deck">
<!-- jh:slides -->
<section class="slide"><h1>表紙</h1><p>サブタイトル</p></section>
<section class="slide"><h2>本文</h2><ul><li>一つ目</li><li>二つ目</li></ul></section>
<!-- /jh:slides -->
</div>
<script>/* engine */</script>
</body></html>`;

const deckFile = (over = {}) => ({ path: 'C:\\work\\decks\\talk.html', name: 'talk.html', content: DECK, ...over });

beforeEach(() => {
    localStorage.clear();
});

describe('DeckHost — finding decks', () => {
    it('recognises a jh-presentation deck by its generator meta', () => {
        expect(isDeckFile(deckFile())).toBe(true);
    });

    it('ignores ordinary HTML and decks saved under another extension', () => {
        expect(isDeckFile(deckFile({ content: '<html><body>hi</body></html>' }))).toBe(false);
        expect(isDeckFile(deckFile({ path: 'C:\\work\\talk.txt', name: 'talk.txt' }))).toBe(false);
        expect(isDeckFile(null)).toBe(false);
    });
});

describe('DeckHost — asking once per file before running scripts', () => {
    it('is not trusted until the user says so, and then remembers it', () => {
        const file = deckFile();
        expect(isDeckTrusted(file)).toBe(false);
        trustDeck(file);
        expect(isDeckTrusted(file)).toBe(true);
        // 別のタブで同じファイルを開いても (区切り・大文字小文字が違っても) 聞き直さない
        expect(isDeckTrusted(deckFile({ path: 'c:/WORK/decks/talk.html' }))).toBe(true);
        expect(isDeckTrusted(deckFile({ path: 'C:\\work\\decks\\other.html' }))).toBe(false);
    });

    it('trusts an untitled deck only for that tab', () => {
        const a = deckFile({ path: null });
        trustDeck(a);
        expect(isDeckTrusted(a)).toBe(true);
        expect(isDeckTrusted(deckFile({ path: null }))).toBe(false);
        expect(localStorage.getItem('settings_deckTrustedPaths')).toBeNull();
    });
});

describe('DeckHost — applying edits from the slides', () => {
    const ready = (editables) => ({ type: 'ready', jhdeck: DeckEdit.PROTOCOL, editables });

    it('counts the editable boxes per slide the same way the deck does', () => {
        expect(editableCounts(DECK)).toEqual([2, 3]);
        expect(editableCounts('<html></html>')).toBeNull();
    });

    it('allows editing only when the deck and the source agree', () => {
        expect(canEditDeck(ready([2, 3]), DECK)).toBe(true);
        expect(canEditDeck(ready([2, 4]), DECK)).toBe(false);
        expect(canEditDeck({ ...ready([2, 3]), jhdeck: 1 }, DECK)).toBe(false);
    });

    it('rewrites only the edited box', () => {
        const r = applyDeckChange(DECK, {
            slide: 1, index: 2, html: '二つ目（修正）', before: '二つ目', protocol: DeckEdit.PROTOCOL,
        });
        expect(r.source).toBe(DECK.replace('<li>二つ目</li>', '<li>二つ目（修正）</li>'));
    });

    it('refuses an edit when the source no longer has the text the slide showed', () => {
        expect(() => applyDeckChange(DECK, {
            slide: 1, index: 2, html: 'x', before: '別の文字', protocol: DeckEdit.PROTOCOL,
        })).toThrow();
    });

    it('refuses an edit from a deck with another edit rule version', () => {
        expect(() => applyDeckChange(DECK, {
            slide: 0, index: 0, html: 'x', before: '表紙', protocol: 1,
        })).toThrow();
    });
});

describe('DeckView', () => {
    let container;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.replaceChildren(container);
    });

    it('asks first, and shows the source when the user declines', () => {
        const file = deckFile({ viewMode: 'deck' });
        const renderEditor = vi.fn();
        const view = new DeckView(container, { renderEditor, renderTabs: vi.fn() });
        view.render(file.content, file);
        expect(container.querySelector('.deck-view-consent')).not.toBeNull();
        expect(container.querySelector('iframe')).toBeNull();

        const [, keep] = container.querySelectorAll('.deck-view-consent button');
        keep.click();
        expect(file.viewMode).toBe('text');
        expect(renderEditor).toHaveBeenCalled();
        expect(isDeckTrusted(file)).toBe(false);
        view.destroy();
    });

    it('shows the slides in a scripts-only sandbox once allowed', () => {
        const file = deckFile({ viewMode: 'deck' });
        const view = new DeckView(container, {});
        view.render(file.content, file);
        container.querySelector('.deck-view-consent button').click();
        const frame = container.querySelector('iframe.deck-view-frame');
        expect(frame).not.toBeNull();
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(isDeckTrusted(file)).toBe(true);
        view.destroy();
    });

    it('opens straight to the slides the next time', () => {
        const file = deckFile({ viewMode: 'deck' });
        trustDeck(file);
        const view = new DeckView(container, {});
        view.render(file.content, file);
        expect(container.querySelector('.deck-view-consent')).toBeNull();
        expect(container.querySelector('iframe.deck-view-frame')).not.toBeNull();
        view.destroy();
    });

    // デッキ (iframe) から届いたメッセージとして配る
    const fromDeck = (frame, data) => {
        window.dispatchEvent(new MessageEvent('message', {
            data: { jhdeck: DeckEdit.PROTOCOL, ...data }, source: frame.contentWindow,
        }));
    };

    it('writes an edit from the slides into the buffer and marks the tab modified', () => {
        const file = deckFile({ viewMode: 'deck', savedContent: DECK, savedEol: '\n', eol: '\n' });
        trustDeck(file);
        const renderTabs = vi.fn();
        const view = new DeckView(container, { renderTabs });
        view.render(file.content, file);
        const frame = container.querySelector('iframe');
        const post = vi.spyOn(frame.contentWindow, 'postMessage');

        fromDeck(frame, { type: 'ready', slides: 2, editables: [2, 3], index: 0, step: 0 });
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'goto', index: 0 }), '*');
        expect(container.querySelector('.deck-view-head button').disabled).toBe(false);

        fromDeck(frame, { type: 'change', slide: 0, index: 0, html: '新しい表紙', before: '表紙', protocol: DeckEdit.PROTOCOL });
        expect(file.content).toContain('<h1>新しい表紙</h1>');
        expect(file.isDirty).toBe(true);
        expect(renderTabs).toHaveBeenCalled();
        view.destroy();
    });

    it('ignores messages that do not come from its own frame', () => {
        const file = deckFile({ viewMode: 'deck' });
        trustDeck(file);
        const view = new DeckView(container, {});
        view.render(file.content, file);
        window.dispatchEvent(new MessageEvent('message', {
            data: { jhdeck: DeckEdit.PROTOCOL, type: 'change', slide: 0, index: 0, html: 'x', before: '表紙', protocol: DeckEdit.PROTOCOL },
            source: window,
        }));
        expect(file.content).toBe(DECK);
        view.destroy();
    });

    it('returns to the slide it was on after the frame reloads', () => {
        const file = deckFile({ viewMode: 'deck' });
        trustDeck(file);
        const view = new DeckView(container, {});
        view.render(file.content, file);
        let frame = container.querySelector('iframe');
        fromDeck(frame, { type: 'ready', slides: 2, editables: [2, 3], index: 0, step: 0 });
        fromDeck(frame, { type: 'state', index: 1, step: 2 });
        expect(file._deckState).toEqual({ index: 1, step: 2 });

        // ビューを作り直す (タブの切り替え・保存後の再描画など)
        view.render(file.content, file);
        frame = container.querySelector('iframe');
        const post = vi.spyOn(frame.contentWindow, 'postMessage');
        // 読み込み直後のデッキは、ready より先に 1 枚目の state を送ってくる
        fromDeck(frame, { type: 'state', index: 0, step: 0 });
        expect(file._deckState).toEqual({ index: 1, step: 2 });
        fromDeck(frame, { type: 'ready', slides: 2, editables: [2, 3], index: 0, step: 0 });
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'goto', index: 1, step: 2 }), '*');
        view.destroy();
    });

    it('saves through the editor when Ctrl+S is pressed inside the slides', async () => {
        const file = deckFile({ viewMode: 'deck' });
        trustDeck(file);
        const saveFile = vi.fn().mockResolvedValue(true);
        const view = new DeckView(container, { saveFile });
        view.render(file.content, file);
        const frame = container.querySelector('iframe');
        const post = vi.spyOn(frame.contentWindow, 'postMessage');
        fromDeck(frame, { type: 'save' });
        await Promise.resolve();
        await Promise.resolve();
        expect(saveFile).toHaveBeenCalled();
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'saved' }), '*');
        view.destroy();
    });
});
