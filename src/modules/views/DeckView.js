import { BaseView } from './BaseView.js';
import { t } from '../utils/I18n.js';
import { iconEl } from '../ui/Icons.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { buildPreviewDocument } from '../ui/HtmlPreview.js';
import { isAtSavedState } from '../utils/DirtyState.js';
import { openAudience } from '../utils/DeckAudience.js';
import {
    DeckEdit, isDeckTrusted, trustDeck, canEditDeck, applyDeckChange,
    slideList, moveSlide, duplicateSlide, deleteSlide, setSlideNotes,
    recordDeckEdit, undoDeckEdit, slideIndexAt,
    buildSlideRequest, applySlidesReply, remapByIndex,
} from '../utils/DeckHost.js';

/** クリップボードへ (Tauri の WebView で navigator.clipboard が使えないときはプラグインで) */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (_) {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(text);
    }
}

/**
 * DeckView — jh-presentation のデッキをスライドとして表示し、その場で直すビュー。
 *
 * デッキはスクリプトで動くので、ファイルごとに最初の 1 回だけ実行の許可を求める
 * (開いただけでは中の JavaScript を実行しない、という HTML プレビューと同じ考え方)。
 * iframe は allow-scripts だけの sandbox で、allow-same-origin は付けない。
 * エディタとのやり取りは postMessage だけで、ソースの書き換えはエディタ側で行う。
 *
 * デッキ → エディタ: ready / state / edit-mode / change / save / undo / redo / present / present-exit
 * エディタ → デッキ: goto / edit / error / saved / present
 *
 * 画面: 上に操作バー、左にスライド一覧、中央にスライド (iframe)、下に発表者ノート。
 * 一覧での並べ替え・複製・削除と、ノート (話す内容) の編集は、ソースの書き換えとして行う。
 * 「AI への依頼」欄にはスライドごとの修正依頼を書き、J.H AI Agent に送るか、依頼文をコピーして別の AI に渡す。
 * どの書き換えもソース表示の Undo 履歴に積むので、どちらの表示からでも元に戻せる。
 *
 * 枠の文字を直したときはプレビューを読み込み直さない (編集中の位置・フォーカスを失わないため)。
 * 読み込み直したとき (並べ替え・元に戻す・照合の失敗など) は、ready を受けて元のスライドへ戻す。
 */
export class DeckView extends BaseView {
    constructor(container, options = {}) {
        super(container);
        this.options = options;
        this.pane = options.pane || 'left';
        this.frame = null;
        this.editable = false;
        this.presenting = false;
        this._onMessage = this._onMessage.bind(this);
        this._onPresentKey = this._onPresentKey.bind(this);
    }

    render(content, file) {
        this.destroy();
        this.file = file;
        this.container.innerHTML = '';
        this.root = document.createElement('div');
        this.root.className = 'deck-view';
        this.container.appendChild(this.root);
        if (isDeckTrusted(file)) this._renderDeck();
        else this._renderConsent();
    }

    // -----------------------------------------------------------------
    // 初回の確認
    // -----------------------------------------------------------------

    /** 初回だけ: スクリプトの実行を許可してスライド表示にするか、ソースのままにするか */
    _renderConsent() {
        const box = document.createElement('div');
        box.className = 'deck-view-consent';

        const title = document.createElement('div');
        title.className = 'deck-view-consent-title';
        title.append(iconEl('play', { size: 16 }), document.createTextNode(t('This is a jh-presentation deck')));

        const text = document.createElement('p');
        text.textContent = t('Showing the slides runs the scripts in this file. It is asked only once per file.');

        const actions = document.createElement('div');
        actions.className = 'deck-view-consent-actions';
        const open = this._button(t('Show slides'), null, () => {
            trustDeck(this.file);
            this.root.innerHTML = '';
            this._renderDeck();
        });
        open.classList.add('primary');
        const source = this._button(t('Keep the source'), null, () => this._showSource());
        actions.append(open, source);

        box.append(title, text, actions);
        this.root.appendChild(box);
        open.focus();
    }

    // -----------------------------------------------------------------
    // 画面
    // -----------------------------------------------------------------

    _button(label, icon, onClick, title) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'deck-view-btn';
        if (icon) b.append(iconEl(icon, { size: 12 }));
        if (label) b.append(document.createTextNode(label));
        if (title) b.title = title;
        b.onclick = onClick;
        return b;
    }

    _renderDeck() {
        const head = document.createElement('div');
        head.className = 'deck-view-head';

        this.posLabel = document.createElement('span');
        this.posLabel.className = 'deck-view-pos';

        const undoBtn = this._button('↶', null, () => this._undo(false), t('Undo') + ' (Ctrl+Z)');
        const redoBtn = this._button('↷', null, () => this._undo(true), t('Redo') + ' (Ctrl+Y)');
        undoBtn.classList.add('icon-only');
        redoBtn.classList.add('icon-only');

        this.editBtn = this._button(t('Edit text'), 'pencil', () => this._setEdit(!this.file._deckEdit));
        this.editBtn.disabled = true;
        const presentBtn = this._button(t('Present'), 'play', () => this.present(), 'F5');
        const browserBtn = this._button(t('Open in browser'), 'export', () => this._openInBrowser(),
            t('Present from the browser, with the presenter view in a second window (projector + laptop)'));
        const sourceBtn = this._button(t('Source'), 'file-code', () => this._showSource(), 'Ctrl+Shift+E');

        this.aiBtn = this._button(t('Ask AI to change'), 'robot', () => this._openAiModal(),
            t('Write what to change on each slide, then ask J.H AI Agent or copy one request for another AI'));
        this.aiCount = document.createElement('span');
        this.aiCount.className = 'deck-view-count';
        this.aiBtn.append(this.aiCount);
        head.append(this.posLabel, undoBtn, redoBtn, this.editBtn, this.aiBtn, presentBtn, browserBtn, sourceBtn);

        const body = document.createElement('div');
        body.className = 'deck-view-body';

        this.film = document.createElement('ol');
        this.film.className = 'deck-view-film';
        this.film.tabIndex = 0;
        this.film.setAttribute('aria-label', t('Slides'));
        this.film.addEventListener('keydown', (e) => this._onFilmKey(e));

        const stage = document.createElement('div');
        stage.className = 'deck-view-stage';
        this.frame = document.createElement('iframe');
        this.frame.className = 'deck-view-frame';
        this.frame.title = t('Slides');
        this.frame.setAttribute('sandbox', 'allow-scripts');
        stage.appendChild(this.frame);
        body.append(this.film, stage);

        // AI の変更案 (差分 / 適用 / 破棄)
        this.proposalBar = document.createElement('div');
        this.proposalBar.className = 'deck-view-proposal';
        this.proposalBar.hidden = true;

        // 下の欄: 発表者ノート (話す内容)
        const bottom = document.createElement('div');
        bottom.className = 'deck-view-notes';
        const notesLabel = document.createElement('label');
        notesLabel.textContent = t('Notes');
        this.notesInput = document.createElement('textarea');
        this.notesInput.rows = 3;
        this.notesInput.placeholder = t('Speaker notes. "- " for a bullet, "1. " for a numbered item, **bold**');
        this.notesInput.addEventListener('input', () => {
            clearTimeout(this._notesTimer);
            this._notesTimer = setTimeout(() => this._commitNotes(), 600);
        });
        this.notesInput.addEventListener('blur', () => this._commitNotes());
        notesLabel.htmlFor = this.notesInput.id = `deck-notes-${this.pane}`;
        bottom.append(notesLabel, this.notesInput);

        // 発表中の発表者向け表示 (S): ノート・次のスライド・タイマー
        this.presenterPanel = this._buildPresenter();
        stage.appendChild(this.presenterPanel);

        this.root.append(head, this.proposalBar, body, bottom);
        this._renderProposal();
        window.addEventListener('message', this._onMessage);
        this._noteExternalChange();
        this._renderFilm();
        this._load();
    }

    _currentIndex() {
        return (this.file._deckState && this.file._deckState.index) || 0;
    }

    /** スライド一覧 (ソースから作る) */
    _renderFilm() {
        if (!this.film) return;
        const list = slideList(this.file.content);
        this.slideInfo = list;
        const cur = this._currentIndex();
        this.film.replaceChildren(...list.map((s) => {
            const li = document.createElement('li');
            li.className = 'deck-view-slide' + (s.index === cur ? ' active' : '');
            li.draggable = true;
            li.dataset.index = String(s.index);
            const no = document.createElement('span');
            no.className = 'deck-view-slide-no';
            no.textContent = String(s.index + 1);
            const title = document.createElement('span');
            title.className = 'deck-view-slide-title';
            title.textContent = s.title || t('(no title)');
            li.append(no, title);
            if (this._requests()[s.index] != null) li.append(this._mark());
            li.title = s.title;
            li.addEventListener('click', () => this._goto(s.index));
            li.addEventListener('contextmenu', (e) => this._slideMenu(e, s.index));
            li.addEventListener('dragstart', (e) => {
                this._dragFrom = s.index;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(s.index));
            });
            li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drop'); });
            li.addEventListener('dragleave', () => li.classList.remove('drop'));
            li.addEventListener('drop', (e) => {
                e.preventDefault();
                li.classList.remove('drop');
                if (this._dragFrom != null && this._dragFrom !== s.index) this._move(this._dragFrom, s.index);
                this._dragFrom = null;
            });
            return li;
        }));
        this._syncNotes();
    }

    _markActive(index) {
        if (!this.film) return;
        this.film.querySelectorAll('.deck-view-slide').forEach((li) => {
            const on = Number(li.dataset.index) === index;
            li.classList.toggle('active', on);
            if (on && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
        });
    }

    /** ノートの欄と発表者向け表示を、今のスライドに合わせる */
    _syncNotes() {
        const index = this._currentIndex();
        const info = this.slideInfo && this.slideInfo[index];
        if (this.notesInput && document.activeElement !== this.notesInput) {
            this.notesInput.value = info ? info.notes : '';
            this._notesShown = this.notesInput.value;
        }
        this._syncAskActions();
        this._renderPresenter();
    }

    // -----------------------------------------------------------------
    // ノート (話す内容) はその場で書き込む
    // -----------------------------------------------------------------

    _commitNotes() {
        clearTimeout(this._notesTimer);
        if (!this.notesInput || this.notesInput.value === this._notesShown) return;
        try {
            const r = setSlideNotes(this.file.content, this._currentIndex(), this.notesInput.value);
            this._notesShown = this.notesInput.value;
            // ノートはスライドに表示されないので、読み込み直さない
            if (r.change) {
                this.file.content = recordDeckEdit(this.file, this.pane, r.change);
                this._markDirty();
                this.slideInfo = slideList(this.file.content);
                this._renderPresenter();
            }
        } catch (err) {
            console.warn('DeckView: notes not saved:', err);
        }
    }

    // -----------------------------------------------------------------
    // AI への依頼 (スライドごと)
    // -----------------------------------------------------------------

    /** スライド番号 → { text: 依頼, was: 依頼したときのそのスライドの HTML } */
    _requests() {
        if (!this.file._deckRequests) this.file._deckRequests = {};
        return this.file._deckRequests;
    }

    _requestList() {
        const map = this._requests();
        return Object.keys(map).map((k) => ({ index: Number(k), text: map[k].text }));
    }

    /**
     * Deck View の外でソースが変わっていたら (依頼文を渡した Claude Code などがファイルを直し、
     * エディタが読み込み直した場合など)、中身が変わったスライドの依頼は済んだものとして消す。
     * Deck View 自身の書き換えは _deckSeen に覚えているので、ここでは数えない。
     */
    _noteExternalChange() {
        const seen = this.file._deckSeen;
        if (seen != null && seen !== this.file.content) {
            const list = slideList(this.file.content);
            const map = this._requests();
            Object.keys(map).forEach((k) => {
                const info = list[Number(k)];
                if (!info || this.file.content.slice(info.start, info.end) !== map[k].was) delete map[k];
            });
        }
        this.file._deckSeen = this.file.content;
    }

    _mark() {
        const m = document.createElement('span');
        m.className = 'deck-view-slide-mark';
        m.textContent = '●';
        m.title = t('Has a request to the AI');
        return m;
    }

    /** スライドの依頼を書き換える (空なら消す) */
    _setRequest(index, text) {
        const info = this.slideInfo && this.slideInfo[index];
        const map = this._requests();
        const had = map[index] != null;
        if (info && text.trim()) map[index] = { text, was: this.file.content.slice(info.start, info.end) };
        else delete map[index];
        if (had !== (map[index] != null)) this._renderFilmMarks();
        this._syncAskActions();
    }

    /** 一覧の ● だけを付け直す (一覧全体を作り直すと、入力中の欄が途切れるため) */
    _renderFilmMarks() {
        if (!this.film) return;
        const map = this._requests();
        this.film.querySelectorAll('.deck-view-slide').forEach((li) => {
            const want = map[Number(li.dataset.index)] != null;
            const mark = li.querySelector('.deck-view-slide-mark');
            if (want && !mark) li.append(this._mark());
            else if (!want && mark) mark.remove();
        });
    }

    /** 操作バーの依頼の数と、モーダルのボタンの状態 */
    _syncAskActions() {
        const count = this._requestList().length;
        if (this.aiCount) {
            this.aiCount.textContent = count ? String(count) : '';
            this.aiCount.hidden = !count;
        }
        const m = this._modal;
        if (m) {
            m.askBtn.disabled = !count || !!this._asking;
            m.askBtn.textContent = count ? t('Ask AI ({n} slides)', { n: count }) : t('Ask AI');
            m.copyBtn.disabled = !count;
            this._renderModalList();
        }
    }

    // -----------------------------------------------------------------
    // AI への変更依頼のモーダル
    // -----------------------------------------------------------------

    /**
     * スライドごとに依頼を書くモーダル。書いた依頼はスライドに残り (一覧に ●)、
     * 最後にまとめて J.H AI Agent に送るか、依頼文をまとめてコピーする。
     */
    _openAiModal(index = this._currentIndex()) {
        this._closeAiModal();
        this._commitNotes();
        const overlay = document.createElement('div');
        overlay.className = 'app-dialog-overlay deck-ai-overlay';
        const box = document.createElement('div');
        box.className = 'app-dialog deck-ai-dialog';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');

        const head = document.createElement('div');
        head.className = 'app-dialog-head';
        head.textContent = t('Ask AI to change slides');

        const body = document.createElement('div');
        body.className = 'app-dialog-body deck-ai-body';
        const target = document.createElement('div');
        target.className = 'deck-ai-target';
        const prev = this._button('◀', null, () => this._modalTarget(this._modal.index - 1), t('Previous slide'));
        const next = this._button('▶', null, () => this._modalTarget(this._modal.index + 1), t('Next slide'));
        const label = document.createElement('span');
        label.className = 'deck-ai-target-label';
        target.append(prev, label, next);

        const input = document.createElement('textarea');
        input.className = 'deck-ai-input';
        input.rows = 4;
        input.placeholder = t('What should change on this slide? e.g. Turn the list into a diagram');
        input.addEventListener('input', () => this._setRequest(this._modal.index, input.value));

        const hint = document.createElement('p');
        hint.className = 'deck-ai-hint';
        hint.textContent = t('Write a request for each slide you want changed. Without the AI connected, copy them all at the end and paste into Claude Code or another AI.');

        const listHead = document.createElement('div');
        listHead.className = 'deck-ai-list-head';
        const list = document.createElement('ul');
        list.className = 'deck-ai-list';
        body.append(target, input, hint, listHead, list);

        const actions = document.createElement('div');
        actions.className = 'app-dialog-actions';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'app-dialog-btn';
        copyBtn.textContent = t('Copy all requests');
        copyBtn.onclick = () => this._copyRequest();
        const askBtn = document.createElement('button');
        askBtn.type = 'button';
        askBtn.className = 'app-dialog-btn primary';
        askBtn.onclick = () => { this._closeAiModal(); this._askAi(); };
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'app-dialog-btn';
        closeBtn.textContent = t('Close');
        closeBtn.onclick = () => this._closeAiModal();
        actions.append(copyBtn, askBtn, closeBtn);

        box.append(head, body, actions);
        overlay.appendChild(box);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) this._closeAiModal(); });
        // 開いている間のキーはこのモーダルのもの (エディタのショートカットはダイアログ表示中は止まる)
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); this._closeAiModal(); }
            else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !askBtn.disabled) { e.preventDefault(); askBtn.click(); }
        });
        document.body.appendChild(overlay);
        this._modal = { overlay, input, label, listHead, list, askBtn, copyBtn, prev, next, index };
        this._modalTarget(index);
        input.focus();
    }

    /** モーダルで依頼を書くスライドを替える (スライド表示も合わせて移る) */
    _modalTarget(index) {
        const m = this._modal;
        const count = this.slideInfo ? this.slideInfo.length : 0;
        if (!m || index < 0 || index >= count) return;
        m.index = index;
        const info = this.slideInfo[index];
        m.label.textContent = t('Slide {n}', { n: index + 1 }) + (info.title ? `「${info.title}」` : '');
        const req = this._requests()[index];
        m.input.value = req ? req.text : '';
        m.prev.disabled = index === 0;
        m.next.disabled = index >= count - 1;
        if (index !== this._currentIndex()) this._goto(index);
        this._syncAskActions();
        m.input.focus();
    }

    _renderModalList() {
        const m = this._modal;
        if (!m) return;
        const reqs = this._requestList().sort((a, b) => a.index - b.index);
        m.listHead.textContent = reqs.length ? t('Slides with a request ({n})', { n: reqs.length }) : '';
        m.list.replaceChildren(...reqs.map((r) => {
            const li = document.createElement('li');
            li.classList.toggle('current', r.index === m.index);
            const pick = document.createElement('button');
            pick.type = 'button';
            pick.className = 'deck-ai-item';
            const info = this.slideInfo && this.slideInfo[r.index];
            pick.textContent = `${r.index + 1}. ${info && info.title ? info.title : ''} — ${r.text.replace(/\s+/g, ' ')}`;
            pick.onclick = () => this._modalTarget(r.index);
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'deck-ai-del';
            del.textContent = '×';
            del.title = t('Remove this request');
            del.onclick = () => {
                this._setRequest(r.index, '');
                if (r.index === m.index) m.input.value = '';
            };
            li.append(pick, del);
            return li;
        }));
    }

    _closeAiModal() {
        if (!this._modal) return;
        this._modal.overlay.remove();
        this._modal = null;
        if (this.frame) this.frame.focus();
    }

    /** 依頼をまとめた文章をコピーする (Claude Code など、別の AI に貼り付ける) */
    async _copyRequest() {
        const requests = this._requestList();
        if (!requests.length) return;
        const text = buildSlideRequest(this.file.content, requests, { path: this.file.path || null });
        try {
            await copyText(text);
            if (window.showToast) {
                window.showToast(t('Copied the request for {n} slide(s). Paste it into Claude Code or another AI.', { n: requests.length }));
            }
        } catch (_) {
            if (window.showToast) window.showToast(t('Could not copy to the clipboard.'));
        }
    }

    /** 依頼を J.H AI Agent に送り、返ってきたスライドを変更案として出す */
    async _askAi() {
        const requests = this._requestList();
        if (!requests.length || this._asking) return;
        this._commitNotes();
        const file = this.file;
        const base = file.content;
        const indices = requests.map((r) => r.index);
        const prompt = buildSlideRequest(base, requests, { path: file.path || null, forAgent: true });
        const [{ default: AIAgent }, { activityPanel }] = await Promise.all([
            import('../ai/AIAgent.js'),
            import('../ai/JhAiActivityPanel.js'),
        ]);
        const entry = activityPanel.addTask(t('Update slides'));
        const ac = new AbortController();
        entry.onAbort(() => ac.abort());
        entry.setStatus(t('Generating…'));
        this._asking = true;
        this._syncAskActions();
        try {
            const reply = await AIAgent.runSingleShot({
                prompt,
                systemPrompt: 'You edit slides of a jh-presentation deck (HTML). Follow the request exactly and answer only with the requested code blocks.',
                abortSignal: ac.signal,
            });
            const source = applySlidesReply(base, indices, reply);
            file._deckProposal = { base, source, indices };
            entry.setResult({
                summary: t('Proposal for {n} slide(s) — review it in Deck View', { n: indices.length }),
                copyText: reply,
            });
            if (this.file === file) this._renderProposal();
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            entry.setError(err && err.message ? err.message : String(err));
            if (window.showToast) window.showToast(t('The AI could not be reached. Use "Copy all requests" to ask another AI.'));
        } finally {
            this._asking = false;
            if (this.file === file) this._syncAskActions();
        }
    }

    _renderProposal() {
        const bar = this.proposalBar;
        if (!bar) return;
        const p = this.file._deckProposal;
        bar.replaceChildren();
        bar.hidden = !p;
        if (!p) return;
        const label = document.createElement('span');
        label.className = 'deck-view-proposal-label';
        label.textContent = t('AI proposal for slide(s) {slides}', {
            slides: p.indices.slice().sort((a, b) => a - b).map((i) => i + 1).join(', '),
        });
        const diff = this._button(t('Show diff'), 'diff', () => this._showProposalDiff());
        const apply = this._button(t('Apply'), 'check', () => this._applyProposal());
        apply.classList.add('primary');
        const discard = this._button(t('Discard'), null, () => { this.file._deckProposal = null; this._renderProposal(); });
        bar.append(label, diff, apply, discard);
    }

    _showProposalDiff() {
        const p = this.file._deckProposal;
        if (!p || !window.app || typeof window.app.openMergeTab !== 'function') return;
        const order = p.indices.slice().sort((a, b) => a - b);
        const pick = (src) => {
            const list = slideList(src);
            return order.map((i) => (list[i] ? src.slice(list[i].start, list[i].end) : '')).join('\n\n');
        };
        const name = this.file.name || 'deck';
        window.app.openMergeTab({
            id: `deck-ai:${this.file.path || name}`,
            title: `AI: ${name}`,
            left: { label: t('Current slides'), text: pick(p.base) },
            right: { label: t('AI proposal'), text: pick(p.source) },
        });
    }

    _applyProposal() {
        const p = this.file._deckProposal;
        if (!p) return;
        this.file._deckProposal = null;
        this._renderProposal();
        if (this.file.content !== p.base) {
            // 依頼した後にソースが変わった: 古い内容に当てはめると、その変更を消してしまう
            if (window.showToast) window.showToast(t('The deck changed after the request. Ask again.'));
            return;
        }
        const map = this._requests();
        p.indices.forEach((i) => { delete map[i]; });
        this._commit({ from: 0, to: p.base.length, insert: p.source }, { reload: true, index: Math.min(...p.indices) });
    }

    _slideMenu(e, index) {
        const count = this.slideInfo ? this.slideInfo.length : 0;
        ContextMenu.show(e, [
            { label: `${t('Duplicate')}  (Ctrl+D)`, action: () => this._duplicate(index) },
            { label: `${t('Move up')}  (Alt+↑)`, action: () => this._move(index, index - 1), disabled: index === 0 },
            { label: `${t('Move down')}  (Alt+↓)`, action: () => this._move(index, index + 1), disabled: index >= count - 1 },
            { label: `${t('Delete')}  (Delete)`, action: () => this._delete(index), disabled: count <= 1 },
        ].filter((i) => !i.disabled));
    }

    _onFilmKey(e) {
        const cur = this._currentIndex();
        const count = this.slideInfo ? this.slideInfo.length : 0;
        let handled = true;
        if (e.altKey && e.key === 'ArrowUp') this._move(cur, cur - 1);
        else if (e.altKey && e.key === 'ArrowDown') this._move(cur, cur + 1);
        else if (e.key === 'ArrowUp') this._goto(Math.max(0, cur - 1));
        else if (e.key === 'ArrowDown') this._goto(Math.min(count - 1, cur + 1));
        else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) this._duplicate(cur);
        else if (e.key === 'Delete') this._delete(cur);
        else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    // -----------------------------------------------------------------
    // デッキ (iframe) とのやり取り
    // -----------------------------------------------------------------

    /** ソースの今の内容でデッキを読み込む (ready が来たら元の位置へ戻す) */
    _load() {
        if (!this.frame) return;
        this.ready = false;
        this.editable = false;
        this._syncEditButton();
        this.frame.srcdoc = buildPreviewDocument(this.file.content, this.file.path);
    }

    _post(msg) {
        if (!this.frame || !this.frame.contentWindow) return;
        // sandbox で origin がないので '*'。受け取る側は送り主 (event.source) で確かめる
        this.frame.contentWindow.postMessage({ ...msg, jhdeck: DeckEdit.PROTOCOL }, '*');
    }

    _goto(index, step = 0) {
        this._commitNotes();
        this.file._deckState = { index, step };
        this._markActive(index);
        this._syncNotes();
        this._showPos(index);
        this._post({ type: 'goto', index, step });
    }

    _onMessage(ev) {
        if (!this.frame || ev.source !== this.frame.contentWindow) return;
        const d = ev.data;
        if (!d || !d.jhdeck) return;
        switch (d.type) {
            case 'ready': {
                this.ready = true;
                this.slides = d.slides || 0;
                this.editable = canEditDeck(d, this.file.content);
                const st = this.file._deckState;
                const index = st && st.index < this.slides ? st.index : (d.index || 0);
                const step = st && st.index < this.slides ? st.step : (d.step || 0);
                // 最初のメッセージで、デッキは「エディタの中にいる」と分かる (Ctrl+S をエディタに渡す)
                this._post({ type: 'goto', index, step });
                if (this.file._deckEdit && this.editable) this._post({ type: 'edit', on: true });
                else this.file._deckEdit = false;
                if (this.presenting) this._post({ type: 'present', on: true });
                this._syncEditButton();
                this._showPos(index);
                break;
            }
            case 'state':
                // 読み込み直後、デッキは ready より先に 1 枚目の state を送ってくる。
                // それで覚えていた位置を上書きしないよう、ready までは無視する
                if (!this.ready) break;
                {
                    const changed = this._currentIndex() !== (d.index || 0);
                    if (changed) this._commitNotes();
                    this.file._deckState = { index: d.index || 0, step: d.step || 0 };
                    if (changed) { this._markActive(d.index || 0); this._syncNotes(); }
                    this._showPos(d.index || 0);
                    // 2 画面での発表: 発表用ウィンドウを同じ位置へ
                    if (this.audience) this.audience.goto(d.index || 0, d.step || 0);
                }
                break;
            case 'edit-mode':
                this.file._deckEdit = !!d.on && this.editable;
                this._syncEditButton();
                break;
            case 'change':
                this._applyChange(d);
                break;
            case 'save':
                this._save();
                break;
            case 'undo':
            case 'redo':
                this._undo(d.type === 'redo');
                break;
            case 'present':
                if (this.presenting) this.stopPresenting(); else this.present();
                break;
            case 'present-exit':
                this.stopPresenting();
                break;
            case 'presenter':
                this._togglePresenter();
                break;
            default:
                break;
        }
    }

    // -----------------------------------------------------------------
    // ソースの書き換え
    // -----------------------------------------------------------------

    /** 書き換えを Undo 履歴に積んでバッファに反映する */
    _commit(change, { reload = false, index = null } = {}) {
        if (!change) return;
        this.file.content = recordDeckEdit(this.file, this.pane, change);
        this._markDirty();
        if (index != null) this.file._deckState = { index, step: 0 };
        this._renderFilm();
        if (reload) this._load();
    }

    _applyChange(change) {
        if (!this.editable) {
            this._post({ type: 'error', message: t('This deck cannot be edited here. Update it with jh-presentation first.') });
            return;
        }
        try {
            const r = applyDeckChange(this.file.content, change);
            this._commit({ from: r.from, to: r.to, insert: r.insert });
        } catch (err) {
            // 何も書き換えずに知らせ、ソースの内容で表示し直す
            console.warn('DeckView: edit not applied:', err);
            this._post({ type: 'error', message: t('The edit was not applied because the source has changed. Reloading the slides.') });
            setTimeout(() => this._load(), 1200);
        }
    }

    _structural(fn, index, reorder) {
        try {
            const r = fn();
            const count = this.slideInfo ? this.slideInfo.length : 0;
            // AI への依頼もスライドと一緒に動かす
            if (reorder) this.file._deckRequests = remapByIndex(this._requests(), count, reorder);
            this._commit(r.change, { reload: true, index });
        } catch (err) {
            if (window.showToast) window.showToast(err.message || String(err));
        }
    }

    _move(from, to) {
        const count = this.slideInfo ? this.slideInfo.length : 0;
        if (to < 0 || to >= count || from === to) return;
        this._structural(() => moveSlide(this.file.content, from, to), to, (list) => {
            const next = list.slice();
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
        });
    }

    _duplicate(index) {
        this._structural(() => duplicateSlide(this.file.content, index), index + 1, (list) => {
            const next = list.slice();
            next.splice(index + 1, 0, null);
            return next;
        });
    }

    _delete(index) {
        const count = this.slideInfo ? this.slideInfo.length : 0;
        if (count <= 1) return;
        // 確認は出さない: Ctrl+Z で戻せる
        this._structural(() => deleteSlide(this.file.content, index), Math.min(index, count - 2),
            (list) => list.filter((i) => i !== index));
    }

    _undo(redoIt) {
        this._commitNotes();
        const r = undoDeckEdit(this.file, this.pane, redoIt);
        if (!r) return;
        this.file.content = r.source;
        this._markDirty();
        // 変わった場所のスライドを表示する
        this.file._deckState = { index: slideIndexAt(r.source, r.offset), step: Infinity };
        this._renderFilm();
        this._load();
    }

    /** Ctrl+Z / Ctrl+Y (iframe の外にフォーカスがあるとき。Editor の app:undo / app:redo から呼ばれる) */
    undo() { this._undo(false); }

    redo() { this._undo(true); }

    _markDirty() {
        this.file._deckSeen = this.file.content;
        const dirty = !isAtSavedState(this.file);
        if (this.file.isDirty !== dirty) {
            this.file.isDirty = dirty;
            if (this.options.renderTabs) this.options.renderTabs();
        }
        if (this.options.updateStatusBar) this.options.updateStatusBar();
    }

    /** 保存の前に、入力途中のノートを反映する (Editor の saveFile から呼ばれる) */
    commitPendingEdits() {
        this._commitNotes();
        return true;
    }

    async _save() {
        this._commitNotes();
        if (!this.options.saveFile) return;
        const ok = await this.options.saveFile();
        // saved を受けたデッキは「保存しました」を出し、編集モードを終える
        if (ok) this._post({ type: 'saved' });
    }

    _setEdit(on) {
        if (!this.editable) return;
        this.file._deckEdit = !!on;
        this._post({ type: 'edit', on: !!on });
        this._syncEditButton();
        if (this.frame) this.frame.focus();
    }

    _syncEditButton() {
        if (!this.editBtn) return;
        this.editBtn.disabled = !this.editable;
        this.editBtn.classList.toggle('active', !!this.file._deckEdit && this.editable);
        this.editBtn.title = this.editable
            ? t('Double-click a box on a slide to edit it (E)')
            : t('This deck cannot be edited here. Update it with jh-presentation first.');
    }

    _showPos(index) {
        if (!this.posLabel) return;
        this.posLabel.textContent = this.slides ? t('Slide {n} / {total}', { n: index + 1, total: this.slides }) : '';
    }

    // -----------------------------------------------------------------
    // 発表 (全画面)
    // -----------------------------------------------------------------

    /** スライドだけを画面いっぱいに表示する (F5)。Esc / F5 で戻る */
    async present() {
        if (!this.frame || this.presenting) return;
        this.presenting = true;
        this._presentStart = Date.now();
        this.root.classList.add('presenting');
        // 経過時間の表示。発表している間だけ 1 秒ごとに描き直す
        const tick = () => {
            if (!this.presenting) return;
            this._renderPresenter();
            this._presenterTimer = setTimeout(tick, 1000);
        };
        tick();
        document.addEventListener('keydown', this._onPresentKey, true);
        this._post({ type: 'present', on: true });
        this.frame.focus();
        // モニターが 2 台以上なら、もう 1 台に発表用ウィンドウを開き、ここは発表者ビューにする
        await this._openAudience();
        if (!this.presenting) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const win = getCurrentWindow();
            this._wasFullscreen = await win.isFullscreen();
            if (!this._wasFullscreen) await win.setFullscreen(true);
        } catch (_) {
            // ウィンドウを全画面にできなくても、ウィンドウいっぱいの表示で発表できる
        }
    }

    async stopPresenting() {
        if (!this.presenting) return;
        this.presenting = false;
        clearTimeout(this._presenterTimer);
        if (this.audience) {
            const audience = this.audience;
            this.audience = null;
            audience.close();
        }
        if (this.root) this.root.classList.remove('presenting', 'with-presenter', 'dual');
        document.removeEventListener('keydown', this._onPresentKey, true);
        this._post({ type: 'present', on: false });
        try {
            if (!this._wasFullscreen) {
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                await getCurrentWindow().setFullscreen(false);
            }
        } catch (_) { /* 全画面にしていなければ何もしない */ }
    }

    /**
     * 発表用ウィンドウ (もう 1 台のモニター) を開く。開けたら、ここは発表者ビュー
     * (今のスライド・次のスライド・ノート・経過時間) になり、どちらで操作しても両方が動く。
     * モニターが 1 台、またはウィンドウを開けない環境では、今までどおり 1 画面で発表する。
     */
    async _openAudience() {
        const st = this.file._deckState || { index: 0, step: 0 };
        try {
            this.audience = await openAudience({
                content: this.file.content,
                path: this.file.path || null,
                index: st.index || 0,
                step: st.step || 0,
                // 発表用ウィンドウで操作されたら、発表者ビューも同じ位置へ
                onState: ({ index, step }) => {
                    const cur = this.file._deckState || {};
                    if (cur.index !== index || cur.step !== step) this._post({ type: 'goto', index, step });
                },
                // 発表用ウィンドウで終了した (Esc) / 閉じられた
                onExit: () => { if (this.audience) { this.audience = null; this.stopPresenting(); } },
            });
        } catch (err) {
            console.warn('DeckView: could not open the audience window:', err);
            this.audience = null;
            if (window.showToast) window.showToast(t('Could not open the presentation window. Presenting on this screen.'));
        }
        // 開いている間に発表を終えた / ビューを閉じた
        if (this.audience && !this.presenting) {
            this.audience.close();
            this.audience = null;
            return;
        }
        if (this.audience && this.root) {
            this.root.classList.add('with-presenter', 'dual');
            this._renderPresenter();
        }
    }

    /** 発表中に iframe の外へフォーカスが出たときの Esc / F5 / S */
    _onPresentKey(e) {
        if (e.key === 'Escape' || e.key === 'F5') {
            e.preventDefault();
            e.stopPropagation();
            this.stopPresenting();
        } else if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            this._togglePresenter();
        }
    }

    /**
     * 発表中の発表者向け表示 (S で切り替え): スライドの横にノート・次のスライド・経過時間を出す。
     * 1 つの画面で練習するとき用。プロジェクターと手元の 2 画面で発表するときは
     * 「ブラウザで開く」から、デッキ自身の発表者ビュー (別ウィンドウ) を使う。
     */
    _togglePresenter() {
        if (!this.presenting || !this.root || this.audience) return;
        this.root.classList.toggle('with-presenter');
        this._renderPresenter();
        if (this.frame) this.frame.focus();
    }

    /** 発表者向け表示の骨組み: 経過時間・位置・前へ / 次へ・次のスライド・ノート */
    _buildPresenter() {
        const panel = document.createElement('div');
        panel.className = 'deck-view-presenter';
        const part = (cls, tag = 'div') => { const e = document.createElement(tag); e.className = cls; return e; };
        const top = part('deck-view-presenter-top');
        this.pvTime = part('deck-view-presenter-time');
        this.pvPos = part('deck-view-presenter-pos');
        top.append(this.pvTime, this.pvPos);
        const nav = part('deck-view-presenter-nav');
        const prev = this._button('◀ ' + t('Previous'), null, () => { this._post({ type: 'prev' }); this.frame.focus(); });
        const next = this._button(t('Next') + ' ▶', null, () => { this._post({ type: 'next' }); this.frame.focus(); });
        next.classList.add('primary');
        nav.append(prev, next);
        const nextLabel = part('deck-view-presenter-label');
        nextLabel.textContent = t('Next slide');
        const nextBox = part('deck-view-presenter-next');
        this.pvNextFrame = document.createElement('iframe');
        this.pvNextFrame.setAttribute('sandbox', 'allow-scripts');
        this.pvNextFrame.title = t('Next slide');
        this.pvNextFrame.tabIndex = -1;
        this.pvNextEnd = part('deck-view-presenter-end');
        this.pvNextEnd.textContent = t('End');
        nextBox.append(this.pvNextFrame, this.pvNextEnd);
        nextBox.addEventListener('click', () => { this._post({ type: 'next' }); this.frame.focus(); });
        const notesLabel = part('deck-view-presenter-label');
        notesLabel.textContent = t('Notes');
        this.pvNotes = part('deck-view-presenter-notes');
        panel.append(top, nav, nextLabel, nextBox, notesLabel, this.pvNotes);
        return panel;
    }

    /** 次のスライドの枠: デッキを表示だけのモードで読み込み、goto で位置を決める */
    _ensureNextFrame() {
        if (!this.pvNextFrame || this._pvNextLoaded === this.file.content) return;
        this._pvNextLoaded = this.file.content;
        const doc = buildPreviewDocument(this.file.content, this.file.path)
            .replace(/<head[^>]*>/i, (m) => m + '<script>window.__JH_DECK_MODE__ = "embed";</script>');
        this.pvNextFrame.onload = () => { this._pvNextIndex = null; this._renderPresenter(); };
        this.pvNextFrame.srcdoc = doc;
    }

    _renderPresenter() {
        if (!this.presenterPanel || !this.presenting || !this.root.classList.contains('with-presenter')) return;
        this._ensureNextFrame();
        const index = this._currentIndex();
        const list = this.slideInfo || [];
        const cur = list[index];
        const sec = Math.floor((Date.now() - (this._presentStart || Date.now())) / 1000);
        this.pvTime.textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
        this.pvPos.textContent = t('Slide {n} / {total}', { n: index + 1, total: list.length });
        const last = index >= list.length - 1;
        this.pvNextEnd.hidden = !last;
        if (!last && this._pvNextIndex !== index + 1 && this.pvNextFrame.contentWindow) {
            this._pvNextIndex = index + 1;
            this.pvNextFrame.contentWindow.postMessage({ jhdeck: DeckEdit.PROTOCOL, type: 'goto', index: index + 1, step: Infinity }, '*');
        }
        // ノートはファイルの中身なので、HTML としては入れず文字で出す (エディタ本体の画面のため)
        this.pvNotes.textContent = cur && cur.notes ? cur.notes : t('(no notes)');
    }

    /** ブラウザで開く (2 画面での発表用。デッキの発表者ビューは S で別ウィンドウに出る) */
    async _openInBrowser() {
        if (!this.file.path) {
            if (window.showToast) window.showToast(t('Save the deck first.'));
            return;
        }
        if (this.file.isDirty && window.showToast) window.showToast(t('Opening the saved file. Unsaved changes are not included.'));
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('open_deck_in_browser', { path: this.file.path });
        } catch (err) {
            if (window.showToast) window.showToast(String(err && err.message ? err.message : err));
        }
    }

    // -----------------------------------------------------------------
    // ソース表示との行き来
    // -----------------------------------------------------------------

    /** ソース表示に切り替え、今のスライドの行へ移る */
    _showSource() {
        this._commitNotes();
        const info = this.slideInfo && this.slideInfo[this._currentIndex()];
        this.file.viewMode = 'text';
        if (this.options.renderEditor) this.options.renderEditor();
        if (this.options.renderTabs) this.options.renderTabs();
        if (info && window.app && typeof window.app.goToLine === 'function') {
            window.app.goToLine(this.file.content.slice(0, info.start).split('\n').length);
        }
    }

    focus() {
        if (this.frame) this.frame.focus();
    }

    destroy() {
        if (this.presenting) this.stopPresenting();
        this._closeAiModal();
        this._commitNotes();
        clearTimeout(this._notesTimer);
        clearTimeout(this._presenterTimer);
        window.removeEventListener('message', this._onMessage);
        document.removeEventListener('keydown', this._onPresentKey, true);
        this.frame = null;
        this.editBtn = null;
        this.posLabel = null;
        this.film = null;
        this.notesInput = null;
        this.proposalBar = null;
        this.presenterPanel = null;
        this.pvNextFrame = null;
        this._pvNextLoaded = null;
    }
}
