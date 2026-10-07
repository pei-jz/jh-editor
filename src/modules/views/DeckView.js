import { BaseView } from './BaseView.js';
import { t } from '../utils/I18n.js';
import { iconEl } from '../ui/Icons.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { buildPreviewDocument } from '../ui/HtmlPreview.js';
import { isAtSavedState } from '../utils/DirtyState.js';
import {
    DeckEdit, isDeckTrusted, trustDeck, canEditDeck, applyDeckChange,
    slideList, moveSlide, duplicateSlide, deleteSlide, setSlideNotes,
    recordDeckEdit, undoDeckEdit, slideIndexAt,
} from '../utils/DeckHost.js';

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
 * 一覧での並べ替え・複製・削除とノートの編集は、ソースの書き換えとして行う。
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
        const sourceBtn = this._button(t('Source'), 'file-code', () => this._showSource(), 'Ctrl+Shift+E');

        head.append(this.posLabel, undoBtn, redoBtn, this.editBtn, presentBtn, sourceBtn);

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

        const notes = document.createElement('div');
        notes.className = 'deck-view-notes';
        const notesLabel = document.createElement('label');
        notesLabel.textContent = t('Notes');
        this.notesInput = document.createElement('textarea');
        this.notesInput.rows = 3;
        this.notesInput.placeholder = t('Speaker notes for this slide (one paragraph per line)');
        this.notesInput.addEventListener('input', () => {
            clearTimeout(this._notesTimer);
            this._notesTimer = setTimeout(() => this._commitNotes(), 600);
        });
        this.notesInput.addEventListener('blur', () => this._commitNotes());
        notesLabel.htmlFor = this.notesInput.id = `deck-notes-${this.pane}`;
        notes.append(notesLabel, this.notesInput);

        this.root.append(head, body, notes);
        window.addEventListener('message', this._onMessage);
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

    _syncNotes() {
        if (!this.notesInput || document.activeElement === this.notesInput) return;
        const info = this.slideInfo && this.slideInfo[this._currentIndex()];
        this.notesInput.value = info ? info.notes : '';
        this._notesShown = this.notesInput.value;
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
                    this.file._deckState = { index: d.index || 0, step: d.step || 0 };
                    if (changed) { this._markActive(d.index || 0); this._syncNotes(); }
                    this._showPos(d.index || 0);
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

    _structural(fn, index) {
        try {
            const r = fn();
            this._commit(r.change, { reload: true, index });
        } catch (err) {
            if (window.showToast) window.showToast(err.message || String(err));
        }
    }

    _move(from, to) {
        const count = this.slideInfo ? this.slideInfo.length : 0;
        if (to < 0 || to >= count || from === to) return;
        this._structural(() => moveSlide(this.file.content, from, to), to);
    }

    _duplicate(index) {
        this._structural(() => duplicateSlide(this.file.content, index), index + 1);
    }

    _delete(index) {
        const count = this.slideInfo ? this.slideInfo.length : 0;
        if (count <= 1) return;
        // 確認は出さない: Ctrl+Z で戻せる
        this._structural(() => deleteSlide(this.file.content, index), Math.min(index, count - 2));
    }

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
            }
        } catch (err) {
            console.warn('DeckView: notes not saved:', err);
        }
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
        this.root.classList.add('presenting');
        document.addEventListener('keydown', this._onPresentKey, true);
        this._post({ type: 'present', on: true });
        this.frame.focus();
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
        if (this.root) this.root.classList.remove('presenting');
        document.removeEventListener('keydown', this._onPresentKey, true);
        this._post({ type: 'present', on: false });
        try {
            if (!this._wasFullscreen) {
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                await getCurrentWindow().setFullscreen(false);
            }
        } catch (_) { /* 全画面にしていなければ何もしない */ }
    }

    /** 発表中に iframe の外へフォーカスが出たときの Esc / F5 */
    _onPresentKey(e) {
        if (e.key === 'Escape' || e.key === 'F5') {
            e.preventDefault();
            e.stopPropagation();
            this.stopPresenting();
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
        this._commitNotes();
        clearTimeout(this._notesTimer);
        window.removeEventListener('message', this._onMessage);
        document.removeEventListener('keydown', this._onPresentKey, true);
        this.frame = null;
        this.editBtn = null;
        this.posLabel = null;
        this.film = null;
        this.notesInput = null;
    }
}
