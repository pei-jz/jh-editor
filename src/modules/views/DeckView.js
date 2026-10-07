import { BaseView } from './BaseView.js';
import { t } from '../utils/I18n.js';
import { iconEl } from '../ui/Icons.js';
import { buildPreviewDocument } from '../ui/HtmlPreview.js';
import { isAtSavedState } from '../utils/DirtyState.js';
import { DeckEdit, isDeckTrusted, trustDeck, canEditDeck, applyDeckChange } from '../utils/DeckHost.js';

/**
 * DeckView — jh-presentation のデッキをスライドとして表示し、その場で文字を直すビュー。
 *
 * デッキはスクリプトで動くので、ファイルごとに最初の 1 回だけ実行の許可を求める
 * (開いただけでは中の JavaScript を実行しない、という HTML プレビューと同じ考え方)。
 * iframe は allow-scripts だけの sandbox で、allow-same-origin は付けない。
 * エディタとのやり取りは postMessage だけで、ソースの書き換えはエディタ側で行う。
 *
 * デッキ → エディタ: ready / state / edit-mode / change / save
 * エディタ → デッキ: goto / edit / error / saved
 *
 * ソースを書き換えてもプレビューは読み込み直さない (編集中の位置・フォーカスを失わないため)。
 * 読み込み直したとき (ビューの作り直し・照合の失敗) は、ready を受けて元のスライドへ戻す。
 */
export class DeckView extends BaseView {
    constructor(container, options = {}) {
        super(container);
        this.options = options;
        this.frame = null;
        this.editable = false;
        this._onMessage = this._onMessage.bind(this);
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
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'deck-view-btn primary';
        open.textContent = t('Show slides');
        open.onclick = () => {
            trustDeck(this.file);
            this.root.innerHTML = '';
            this._renderDeck();
        };
        const source = document.createElement('button');
        source.type = 'button';
        source.className = 'deck-view-btn';
        source.textContent = t('Keep the source');
        source.onclick = () => this._showSource();
        actions.append(open, source);

        box.append(title, text, actions);
        this.root.appendChild(box);
        open.focus();
    }

    _renderDeck() {
        const head = document.createElement('div');
        head.className = 'deck-view-head';

        this.posLabel = document.createElement('span');
        this.posLabel.className = 'deck-view-pos';

        this.editBtn = document.createElement('button');
        this.editBtn.type = 'button';
        this.editBtn.className = 'deck-view-btn';
        this.editBtn.append(iconEl('pencil', { size: 12 }), document.createTextNode(t('Edit text')));
        this.editBtn.disabled = true;
        this.editBtn.onclick = () => this._setEdit(!this.file._deckEdit);

        const sourceBtn = document.createElement('button');
        sourceBtn.type = 'button';
        sourceBtn.className = 'deck-view-btn';
        sourceBtn.title = 'Ctrl+Shift+E';
        sourceBtn.append(iconEl('file-code', { size: 12 }), document.createTextNode(t('Source')));
        sourceBtn.onclick = () => this._showSource();

        head.append(this.posLabel, this.editBtn, sourceBtn);

        this.frame = document.createElement('iframe');
        this.frame.className = 'deck-view-frame';
        this.frame.title = t('Slides');
        this.frame.setAttribute('sandbox', 'allow-scripts');

        this.root.append(head, this.frame);
        window.addEventListener('message', this._onMessage);
        this._load();
    }

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
                this._syncEditButton();
                this._showPos(index);
                break;
            }
            case 'state':
                // 読み込み直後、デッキは ready より先に 1 枚目の state を送ってくる。
                // それで覚えていた位置を上書きしないよう、ready までは無視する
                if (!this.ready) break;
                this.file._deckState = { index: d.index || 0, step: d.step || 0 };
                this._showPos(d.index || 0);
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
            default:
                break;
        }
    }

    _applyChange(change) {
        if (!this.editable) {
            this._post({ type: 'error', message: t('This deck cannot be edited here. Update it with jh-presentation first.') });
            return;
        }
        try {
            const r = applyDeckChange(this.file.content, change);
            this.file.content = r.source;
            this._markDirty();
        } catch (err) {
            // 何も書き換えずに知らせ、ソースの内容で表示し直す
            console.warn('DeckView: edit not applied:', err);
            this._post({ type: 'error', message: t('The edit was not applied because the source has changed. Reloading the slides.') });
            setTimeout(() => this._load(), 1200);
        }
    }

    _markDirty() {
        const dirty = !isAtSavedState(this.file);
        if (this.file.isDirty !== dirty) {
            this.file.isDirty = dirty;
            if (this.options.renderTabs) this.options.renderTabs();
        }
        if (this.options.updateStatusBar) this.options.updateStatusBar();
    }

    async _save() {
        if (!this.options.saveFile) return;
        const ok = await this.options.saveFile();
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

    _showSource() {
        this.file.viewMode = 'text';
        if (this.options.renderEditor) this.options.renderEditor();
        if (this.options.renderTabs) this.options.renderTabs();
    }

    focus() {
        if (this.frame) this.frame.focus();
    }

    destroy() {
        window.removeEventListener('message', this._onMessage);
        this.frame = null;
        this.editBtn = null;
        this.posLabel = null;
    }
}
