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

describe('DeckHost — slide operations', async () => {
    const { slideList, slideIndexAt, moveSlide, duplicateSlide, deleteSlide, setSlideNotes, recordDeckEdit, undoDeckEdit } =
        await import('../src/modules/utils/DeckHost.js');
    const THREE = DECK.replace('<!-- /jh:slides -->',
        '<section class="slide" id="end"><h2>まとめ</h2><aside class="notes"><p>最後に一言</p><p>質問を受ける</p></aside></section>\n<!-- /jh:slides -->');

    it('lists slides with their title and notes', () => {
        const list = slideList(THREE);
        expect(list.map((s) => s.title)).toEqual(['表紙', '本文', 'まとめ']);
        expect(list[2].notes).toBe('最後に一言\n質問を受ける');
        expect(list[2].id).toBe('end');
        expect(THREE.slice(list[1].start, list[1].start + 9)).toBe('<section ');
    });

    it('finds the slide that holds a source position', () => {
        const list = slideList(THREE);
        expect(slideIndexAt(THREE, list[1].start + 5)).toBe(1);
        expect(slideIndexAt(THREE, 0)).toBe(0);
        expect(slideIndexAt(THREE, THREE.length)).toBe(2);
    });

    it('moves a slide and keeps the rest of the file as it was', () => {
        const r = moveSlide(THREE, 2, 0);
        expect(slideList(r.source).map((s) => s.title)).toEqual(['まとめ', '表紙', '本文']);
        expect(r.source.slice(0, r.change.from)).toBe(THREE.slice(0, r.change.from));
        expect(r.source.endsWith(THREE.slice(r.change.to))).toBe(true);
    });

    it('duplicates a slide after itself with a fresh id', () => {
        const r = duplicateSlide(THREE, 2);
        const list = slideList(r.source);
        expect(list.map((s) => s.id)).toEqual([null, null, 'end', 'end-2']);
    });

    it('deletes a slide but never the last one', () => {
        const r = deleteSlide(THREE, 1);
        expect(slideList(r.source).map((s) => s.title)).toEqual(['表紙', 'まとめ']);
        const one = deleteSlide(deleteSlide(THREE, 0).source, 0).source;
        expect(() => deleteSlide(one, 0)).toThrow();
    });

    it('rewrites speaker notes, or adds them when a slide has none', () => {
        const a = setSlideNotes(THREE, 2, '一言目\n<b>二言目</b>');
        expect(a.source).toContain('<aside class="notes"><p>一言目</p><p>&lt;b&gt;二言目&lt;/b&gt;</p></aside>');
        const b = setSlideNotes(THREE, 0, 'ノートを追加');
        expect(slideList(b.source)[0].notes).toBe('ノートを追加');
        expect(slideList(b.source).length).toBe(3);
        expect(setSlideNotes(THREE, 0, '').change).toBeNull();
    });

    it('puts deck edits into the same undo history the source view uses', () => {
        const file = deckFile();
        const r = moveSlide(file.content, 1, 0);
        file.content = recordDeckEdit(file, 'left', r.change);
        expect(file.content).toBe(r.source);
        // ソース表示はこの状態 (content が一致) をそのまま使う
        expect(file._cmViewState.left.content).toBe(file.content);
        expect(file._cmViewState.left.history).toBeTruthy();

        const back = undoDeckEdit(file, 'left');
        expect(back.source).toBe(DECK);
        // 変わった場所を指す (並べ替えたスライドの先頭)
        expect(slideIndexAt(back.source, back.offset)).toBe(0);
        file.content = back.source;
        const again = undoDeckEdit(file, 'left', true);
        expect(again.source).toBe(r.source);
        file.content = again.source;
        expect(undoDeckEdit(file, 'left', true)).toBeNull();
    });
});

describe('DeckView — slide list, notes and undo', () => {
    let container;
    beforeEach(() => {
        container = document.createElement('div');
        document.body.replaceChildren(container);
    });
    const fromDeck = (frame, data) => {
        window.dispatchEvent(new MessageEvent('message', {
            data: { jhdeck: DeckEdit.PROTOCOL, ...data }, source: frame.contentWindow,
        }));
    };
    const open = (opts = {}) => {
        const file = deckFile({ viewMode: 'deck', savedContent: DECK, savedEol: '\n', eol: '\n' });
        trustDeck(file);
        const view = new DeckView(container, { renderTabs: vi.fn(), ...opts });
        view.render(file.content, file);
        const frame = container.querySelector('iframe');
        fromDeck(frame, { type: 'ready', slides: 2, editables: [2, 3], index: 0, step: 0 });
        return { file, view, frame };
    };

    it('lists the slides and moves them with Alt+arrow keys', () => {
        const { file, view } = open();
        const items = () => [...container.querySelectorAll('.deck-view-slide-title')].map((e) => e.textContent);
        expect(items()).toEqual(['表紙', '本文']);
        const film = container.querySelector('.deck-view-film');
        film.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
        expect(items()).toEqual(['本文', '表紙']);
        expect(file._deckState.index).toBe(1);
        expect(file.isDirty).toBe(true);
        view.undo();
        expect(items()).toEqual(['表紙', '本文']);
        expect(file.content).toBe(DECK);
        view.destroy();
    });

    it('shows the slide that changed after undoing a duplicate', () => {
        const { file, view } = open();
        const film = container.querySelector('.deck-view-film');
        container.querySelectorAll('.deck-view-slide')[1].click();
        film.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
        expect(container.querySelectorAll('.deck-view-slide')).toHaveLength(3);
        view.undo();
        expect(container.querySelectorAll('.deck-view-slide')).toHaveLength(2);
        expect(file._deckState.index).toBe(1);
        view.destroy();
    });

    it('undoes a text edit made on a slide', () => {
        const { file, view, frame } = open();
        fromDeck(frame, { type: 'change', slide: 0, index: 0, html: '新しい表紙', before: '表紙', protocol: DeckEdit.PROTOCOL });
        expect(file.content).toContain('<h1>新しい表紙</h1>');
        fromDeck(frame, { type: 'undo' });
        expect(file.content).toBe(DECK);
        expect(file.isDirty).toBe(false);
        fromDeck(frame, { type: 'redo' });
        expect(file.content).toContain('<h1>新しい表紙</h1>');
        view.destroy();
    });

    it('writes the speaker notes of the current slide', () => {
        const { file, view } = open();
        const notes = container.querySelector('.deck-view-notes textarea');
        notes.value = '話す内容';
        notes.dispatchEvent(new Event('blur'));
        expect(file.content).toContain('<aside class="notes"><p>話す内容</p></aside>');
        view.destroy();
    });

    it('asks the editor to save and tells the deck once it is saved', async () => {
        const saveFile = vi.fn().mockResolvedValue(true);
        const { view, frame } = open({ saveFile });
        const post = vi.spyOn(frame.contentWindow, 'postMessage');
        fromDeck(frame, { type: 'save' });
        await Promise.resolve();
        await Promise.resolve();
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'saved' }), '*');
        view.destroy();
    });

    it('presents on F5 from the deck and stops on Esc', async () => {
        const { view, frame } = open();
        const post = vi.spyOn(frame.contentWindow, 'postMessage');
        fromDeck(frame, { type: 'present' });
        expect(container.querySelector('.deck-view').classList.contains('presenting')).toBe(true);
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'present', on: true }), '*');
        fromDeck(frame, { type: 'present-exit' });
        expect(container.querySelector('.deck-view').classList.contains('presenting')).toBe(false);
        view.destroy();
    });
});
