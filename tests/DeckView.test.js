import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
    convertFileSrc: (p) => `asset://localhost/${p}`,
}));
// 2 画面での発表 (発表用ウィンドウ) は、テストごとに差し替える。既定はモニター 1 台 (開かない)
const audienceMock = vi.hoisted(() => ({ open: async () => null }));
vi.mock('../src/modules/utils/DeckAudience.js', () => ({ openAudience: (o) => audienceMock.open(o) }));
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
        // 箇条書き・番号付き・太字は、編集欄の書き方で保たれる
        const list = setSlideNotes(THREE, 2, '導入\n- 要点 **A**\n1. 手順');
        expect(list.source).toContain('<aside class="notes"><p>導入</p><ul><li>要点 <b>A</b></li></ul><ol><li>手順</li></ol></aside>');
        expect(slideList(list.source)[2].notes).toBe('導入\n- 要点 **A**\n1. 手順');
        const b = setSlideNotes(THREE, 0, 'ノートを追加');
        expect(slideList(b.source)[0].notes).toBe('ノートを追加');
        expect(slideList(b.source).length).toBe(3);
        expect(setSlideNotes(THREE, 0, '').change).toBeNull();
    });

    it('builds a request for another AI and reads back the slides an AI returns', async () => {
        const { buildSlideRequest, applySlidesReply } = await import('../src/modules/utils/DeckHost.js');
        const req = buildSlideRequest(THREE, [{ index: 2, text: '最後に図を入れて' }], { path: 'C:/d/talk.html' });
        expect(req).toContain('対象のファイル: C:/d/talk.html');
        expect(req).toContain('id="end"');
        expect(req).toContain('最後に図を入れて');
        expect(req).toContain('<p>最後に一言</p><p>質問を受ける</p>');
        const agent = buildSlideRequest(THREE, [{ index: 2, text: 'x' }], { forAgent: true });
        expect(agent).toContain('```html のコードブロック');

        const reply = 'はい。\n```html\n<section class="slide" id="end"><h2>まとめ (改)</h2></section>\n```\n';
        const next = applySlidesReply(THREE, [2], reply);
        expect(slideList(next).map((x) => x.title)).toEqual(['表紙', '本文', 'まとめ (改)']);
        // 数が合わない・section でない返答は当てはめない
        expect(() => applySlidesReply(THREE, [1, 2], reply)).toThrow();
        expect(() => applySlidesReply(THREE, [2], '```html\n<div>x</div>\n```')).toThrow();
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

    const typeIn = (el, text) => {
        el.value = text;
        el.dispatchEvent(new Event('input'));
        return el;
    };
    const typeNotes = (text) => typeIn(container.querySelector('textarea[id^="deck-notes-"]'), text);
    const headButton = (label) => [...container.querySelectorAll('.deck-view-head button')].find((b) => b.textContent.includes(label));
    // AI への変更依頼のモーダル
    const openModal = () => headButton('Ask AI to change').click();
    const modal = () => document.querySelector('.deck-ai-overlay');
    const typeAsk = (text) => typeIn(document.querySelector('.deck-ai-input'), text);
    const modalButton = (label) => [...modal().querySelectorAll('button')].find((b) => b.textContent.includes(label));
    const nextSlideInModal = () => modal().querySelectorAll('.deck-ai-target button')[1].click();

    it('writes the notes straight into the source, keeping bullets and bold', () => {
        const { file, view } = open();
        typeNotes('導入\n- 要点 **A**\n- 要点 B').dispatchEvent(new Event('blur'));
        expect(file.content).toContain('<aside class="notes"><p>導入</p><ul><li>要点 <b>A</b></li><li>要点 B</li></ul></aside>');
        expect(file.isDirty).toBe(true);
        view.undo();
        expect(file.content).toBe(DECK);
        view.destroy();
    });

    it('collects a request per slide in the modal, marked in the list and counted on the button', () => {
        const { file, view } = open();
        openModal();
        expect(modal()).not.toBeNull();
        expect(modal().querySelector('.deck-ai-target-label').textContent).toContain('表紙');
        typeAsk('図にして');
        expect(file.content).toBe(DECK);
        expect(file._deckRequests[0].text).toBe('図にして');
        expect(container.querySelector('.deck-view-slide .deck-view-slide-mark')).not.toBeNull();
        expect(container.querySelector('.deck-view-count').textContent).toBe('1');
        expect(modalButton('Ask AI').disabled).toBe(false);
        // 次のスライドへ (スライド表示も移る)
        nextSlideInModal();
        expect(file._deckState.index).toBe(1);
        expect(document.querySelector('.deck-ai-input').value).toBe('');
        typeAsk('本文を図に');
        expect(modal().querySelectorAll('.deck-ai-list li')).toHaveLength(2);
        // 一覧の × で消せる
        modal().querySelector('.deck-ai-list .deck-ai-del').click();
        expect(Object.keys(file._deckRequests)).toEqual(['1']);
        // Esc で閉じても依頼は残る
        modal().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(modal()).toBeNull();
        expect(Object.keys(file._deckRequests)).toEqual(['1']);
        view.destroy();
    });

    it('copies one prompt for every slide with a request', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const { view } = open();
        openModal();
        typeAsk('表紙を短く');
        nextSlideInModal();
        typeAsk('箇条書きを図に');
        modalButton('Copy all requests').click();
        await Promise.resolve();
        const text = writeText.mock.calls[0][0];
        expect(text).toContain('C:\\work\\decks\\talk.html');
        expect(text).toContain('## スライド 1');
        expect(text).toContain('表紙を短く');
        expect(text).toContain('## スライド 2');
        expect(text).toContain('箇条書きを図に');
        expect(text).toContain('<li>二つ目</li>');
        view.destroy();
    });

    it('drops a request once that slide was changed outside Deck View (e.g. by another AI)', () => {
        const { file, view } = open();
        openModal();
        typeAsk('表紙を短く');
        nextSlideInModal();
        typeAsk('本文を図に');
        // 外でファイルが直され (表紙だけ)、読み込み直された
        file.content = DECK.replace('<h1>表紙</h1>', '<h1>表紙 (短)</h1>');
        view.render(file.content, file);
        expect(Object.keys(file._deckRequests)).toEqual(['1']);
        view.destroy();
    });

    it('does not drop requests for its own edits', () => {
        const { file, view, frame } = open();
        openModal();
        typeAsk('表紙を短く');
        fromDeck(frame, { type: 'change', slide: 0, index: 0, html: '新しい表紙', before: '表紙', protocol: DeckEdit.PROTOCOL });
        view.render(file.content, file);
        expect(file._deckRequests[0].text).toBe('表紙を短く');
        view.destroy();
    });

    it('moves a request along with its slide', () => {
        const { file, view } = open();
        openModal();
        typeAsk('表紙を短く');
        modal().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const film = container.querySelector('.deck-view-film');
        film.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
        expect(Object.keys(file._deckRequests)).toEqual(['1']);
        view.destroy();
    });

    it('applies an AI proposal only to the source it was made from', () => {
        const { file, view } = open();
        const proposal = DECK.replace('<h1>表紙</h1>', '<h1>新しい表紙</h1>');
        file._deckRequests = { 0: { text: 'x', was: '' } };
        file._deckProposal = { base: DECK, source: proposal, indices: [0] };
        view._renderProposal();
        const bar = container.querySelector('.deck-view-proposal');
        expect(bar.hidden).toBe(false);
        [...bar.querySelectorAll('button')].find((b) => b.textContent.includes('Apply')).click();
        expect(file.content).toBe(proposal);
        expect(file._deckRequests).toEqual({});
        expect(bar.hidden).toBe(true);
        // 依頼した後にソースが変わっていたら当てはめない
        file._deckProposal = { base: DECK, source: DECK.replace('本文', 'x'), indices: [1] };
        view._renderProposal();
        [...bar.querySelectorAll('button')].find((b) => b.textContent.includes('Apply')).click();
        expect(file.content).toBe(proposal);
        view.destroy();
    });

    it('shows notes, the next slide and a timer beside the slide while presenting (S)', () => {
        const NOTED = DECK.replace('<p>サブタイトル</p>', '<p>サブタイトル</p><aside class="notes"><p>最初の一言</p></aside>');
        const file = deckFile({ viewMode: 'deck', content: NOTED });
        trustDeck(file);
        const view = new DeckView(container, {});
        view.render(file.content, file);
        const frame = container.querySelector('iframe');
        fromDeck(frame, { type: 'ready', slides: 2, editables: [2, 3], index: 0, step: 0 });
        fromDeck(frame, { type: 'present' });
        fromDeck(frame, { type: 'presenter' });
        const root = container.querySelector('.deck-view');
        expect(root.classList.contains('with-presenter')).toBe(true);
        const panel = container.querySelector('.deck-view-presenter');
        expect(panel.textContent).toContain('最初の一言');
        expect(panel.querySelector('.deck-view-presenter-time').textContent).toBe('00:00');
        expect(panel.querySelector('.deck-view-presenter-next iframe').getAttribute('sandbox')).toBe('allow-scripts');
        expect(panel.querySelector('.deck-view-presenter-next iframe').srcdoc).toContain('__JH_DECK_MODE__');
        const post = vi.spyOn(frame.contentWindow, 'postMessage');
        [...panel.querySelectorAll('button')].find((b) => b.textContent.includes('Next')).click();
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'next' }), '*');
        fromDeck(frame, { type: 'present-exit' });
        expect(root.classList.contains('with-presenter')).toBe(false);
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

    it('drives the audience window from the presenter view, and follows it back (two screens)', async () => {
        let opts;
        const audience = { goto: vi.fn(), close: vi.fn() };
        audienceMock.open = async (o) => { opts = o; return audience; };
        try {
            const { file, view, frame } = open();
            await view.present();
            const root = container.querySelector('.deck-view');
            expect(root.classList.contains('dual')).toBe(true);
            expect(root.classList.contains('with-presenter')).toBe(true);
            expect(opts.content).toBe(file.content);

            // 発表者ビューで進むと、発表用ウィンドウも同じ位置へ
            fromDeck(frame, { type: 'state', index: 1, step: 2 });
            expect(audience.goto).toHaveBeenCalledWith(1, 2);

            // 発表用ウィンドウで戻ると、発表者ビューも同じ位置へ
            const post = vi.spyOn(frame.contentWindow, 'postMessage');
            opts.onState({ index: 0, step: 0 });
            expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'goto', index: 0, step: 0 }), '*');

            // 発表用ウィンドウで Esc → 発表を終える
            opts.onExit();
            expect(root.classList.contains('presenting')).toBe(false);
            view.destroy();
        } finally {
            audienceMock.open = async () => null;
        }
    });
});
