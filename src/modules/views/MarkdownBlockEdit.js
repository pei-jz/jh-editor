/**
 * MarkdownBlockEdit.js — 表示モードのまま、段落・見出し・リスト・引用をその場で直す。
 *
 * 短い修正のたびに F2 のモーダルを開かずに済ませるのが目的。長い文章を書くときや、
 * コード・図・数式・HTML のブロックは今までどおりモーダル (F2) で編集する。
 * スクロール表示でも本の表示でも同じように働く。本の表示では、確定してもページの
 * 割り付けはやり直さない (そのブロックだけ描き直す。ページは中で縦に流れる)。
 *
 *   Enter                 選択中のブロックをその場で編集 (できないブロックはモーダル)
 *   選択中のブロックをもう一度クリック
 *                         その場で編集 (ダブルクリックは単語の選択のまま)
 *   + Add Block           その場で新しいブロックを書く
 *
 * 編集中
 *
 *   Enter / Shift+Enter   改行 (空行を入れるとブロックが分かれる)
 *   Ctrl+Enter            確定してブロックの選択へ
 *   Esc                   取り消す
 *   外をクリック          確定
 *   F2                    確定してモーダルで開き直す
 *
 * 編集中は原文 (**太字** や # などの記号も含む) を見せる。描画後の文字を編集して
 * しまうと、書式を書き戻す手段がなくなるため。表のセルの編集 (MarkdownTableEdit) と
 * 同じ考え方。
 *
 * 入力欄には md-cell-editing を付ける。ShortcutManager とブロックのキー操作は、
 * これを「文字の入力欄」として扱い、Delete (ブロックの削除) や ↑↓ (ブロックの移動)
 * に手を出さない。
 */

import { State } from '../core/Store.js';

/* global marked */

/** その場で編集できるトークンの種類。これ以外が 1 つでも入っていればモーダルに任せる。 */
const INLINE_TYPES = new Set(['paragraph', 'heading', 'list', 'list_item', 'blockquote', 'space', 'hr', 'text']);

/** 選択中のブロックの 2 度目のクリックから編集に入るまで。ダブルクリックと区別する。 */
const CLICK_DELAY = 450;

/** ブロックの中の、編集の合図にしない要素。 */
const NOT_A_TEXT_CLICK = 'a, img, button, input, textarea, select, table, svg, .mermaid, .katex, details, summary, .md-block-tools';

function tokensAreInline(tokens) {
    for (const token of tokens || []) {
        if (!token || !INLINE_TYPES.has(token.type)) return false;
        if (token.tokens && token.type !== 'paragraph' && token.type !== 'heading' && token.type !== 'text'
            && !tokensAreInline(token.tokens)) return false;
        if (token.items && !token.items.every((item) => tokensAreInline(item.tokens))) return false;
    }
    return true;
}

/**
 * その場で編集できる原文か。段落・見出し・リスト・引用だけからなり、HTML や
 * 数式のブロックを含まないもの。
 */
export function canEditInPlace(text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    if (typeof marked === 'undefined') return false;
    // $$ ... $$ の数式は段落として読まれるが、描画は KaTeX のブロックになる。
    if (/\$\$/.test(text) || /^\s*\\\[/m.test(text)) return false;
    let tokens;
    try {
        tokens = marked.lexer(text);
    } catch (_) {
        return false;
    }
    return tokens.length > 0 && tokensAreInline(tokens);
}

/** 描画された文字がそのまま原文と同じか (書式も記号もない段落)。 */
function isPlain(div, text) {
    const kids = Array.from(div.children).filter((el) => !el.classList.contains('md-block-tools'));
    if (kids.length !== 1 || kids[0].tagName !== 'P' || kids[0].children.length) return false;
    return kids[0].textContent === text.trim();
}

/** 画面上の位置 (x, y) が、要素の文字の何文字目にあたるか。分からなければ null。 */
function textOffsetAt(el, x, y) {
    if (typeof document.caretRangeFromPoint !== 'function') return null;
    const at = document.caretRangeFromPoint(x, y);
    if (!at || !el.contains(at.startContainer)) return null;
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(at.startContainer, at.startOffset);
    return before.toString().length;
}

function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
}

export class MarkdownBlockEdit {
    /** @param {object} view MarkdownView */
    constructor(view) {
        this.view = view;
        this.active = null;
        this._clickTimer = null;
    }

    _blockEl(index) {
        const container = this.view.container;
        if (!container) return null;
        const count = this.view.blocksData ? this.view.blocksData.length : 0;
        if (index === count) return container.querySelector('.md-block.phantom');
        // 本の表示では、めくりのために同じブロックの写しが描かれていることがある。
        // 見えているものを選ぶ。
        const all = Array.from(container.querySelectorAll(`.md-block[data-index="${index}"]:not(.phantom)`));
        return all.find((el) => el.offsetParent !== null) || all[0] || null;
    }

    /**
     * ブロックをその場の編集にする。できないとき (コードや表のブロック、本の表示、
     * まだ描画されていないブロック) は false を返すので、呼び出し側がモーダルを開く。
     *
     * @param {number} index ブロックの番号。末尾の + Add Block は blocksData.length
     * @param {{x:number, y:number}} [point] クリックした位置。そこにカーソルを置く
     */
    begin(index, point = null) {
        const view = this.view;
        if (this.active) this.commit();
        const div = this._blockEl(index);
        if (!div || div.classList.contains('editing') || div.classList.contains('md-inline-editing')) return false;
        const phantom = div.classList.contains('phantom');
        const raw = phantom ? '' : view.blocksData[index];
        if (!phantom && (!div.dataset.rendered || !canEditInPlace(raw))) return false;

        view.tableEdit.commit();
        view.tableEdit.clearRange();

        // 書式のない段落は、描画された文字と原文の位置が一致する。クリックした
        // 位置にカーソルを置ける。ほかは末尾。
        const text = raw.replace(/\r\n?/g, '\n');
        let caret = text.length;
        if (point && !phantom && isPlain(div, text)) {
            const offset = textOffsetAt(div.querySelector('p'), point.x, point.y);
            if (offset !== null) caret = offset + (text.length - text.trimStart().length);
        }

        const ta = document.createElement('textarea');
        ta.className = 'md-cell-editing md-block-inline-editor';
        ta.spellcheck = false;
        ta.rows = 1;
        ta.value = text;
        if (phantom) ta.placeholder = '';

        const saved = Array.from(div.childNodes);
        div.classList.add('md-inline-editing');
        div.replaceChildren(ta);

        const state = { div, index, text, ta, saved, phantom };
        state.onKeyDown = (e) => this._onKeyDown(e, state);
        state.onBlur = () => this.commit();
        state.onInput = () => autoGrow(ta);
        ta.addEventListener('keydown', state.onKeyDown);
        ta.addEventListener('blur', state.onBlur);
        ta.addEventListener('input', state.onInput);
        this.active = state;

        if (typeof view._setCursor === 'function') view._setCursor(index);
        autoGrow(ta);
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(caret, caret);
        return true;
    }

    /** 編集の見た目を片付ける。リスナーを先に外すので blur で二重に確定しない。 */
    _detach(state) {
        state.ta.removeEventListener('keydown', state.onKeyDown);
        state.ta.removeEventListener('blur', state.onBlur);
        state.ta.removeEventListener('input', state.onInput);
        state.div.classList.remove('md-inline-editing');
        if (this.active === state) this.active = null;
    }

    _restore(state) {
        state.div.replaceChildren(...state.saved);
    }

    /**
     * 編集中のブロックを確定する。ビューの作り直しの前にも呼ばれる。
     * @returns {boolean} 文書が変わったか
     */
    commit() {
        const state = this.active;
        if (!state) return false;
        this._detach(state);
        const value = state.ta.value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
        if (value === state.text.replace(/\s+$/, '') || (state.phantom && !value.trim())) {
            this._restore(state);
            return false;
        }

        const view = this.view;
        if (typeof view._setCursor === 'function') view._setCursor(state.index);
        const single = !state.phantom && value.trim() && view._splitIntoBlocks(value).length === 1;
        if (single) {
            // 1 つのブロックのままなら、そのブロックだけ描き直す。ほかのブロックの
            // DOM を残すので、スクロールも、外をクリックした先のクリックも狂わない。
            if (!view._applyBlockText(state.index, value)) {
                this._restore(state);
                return false;
            }
            view._rerenderBlock(state.div);
            if (view.renderTabs) view.renderTabs();
            if (view.updateOutline) view.updateOutline();
        } else {
            // 分かれた / 空になった / 新しいブロック。文書ごと描き直す。
            view.saveBlock(state.index, value);
        }
        return true;
    }

    /** 確定せずに元へ戻す。 */
    cancel() {
        const state = this.active;
        if (!state) return;
        this._detach(state);
        this._restore(state);
    }

    _leave(index) {
        const view = this.view;
        const count = view.blocksData ? view.blocksData.length : 0;
        view.selectBlock(Math.min(index, count), { reveal: 'nearest' });
    }

    _onKeyDown(e, state) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.cancel();
            this._leave(state.index);
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            this.commit();
            this._leave(state.index);
        }
    }

    // ── クリックから ──────────────────────────────────────────────────

    /** このブロックだけが選ばれているか (2 度目のクリックの判定に使う)。 */
    isSoleSelection(index) {
        const range = this.view.selectedRange ? this.view.selectedRange() : null;
        if (range && range.to > range.from) return false;
        return State.vimState.selectedIndex === index;
    }

    /**
     * 選択中のブロックのクリック。少し待ってから編集に入る。ダブルクリック
     * (単語の選択) やドラッグでの文字の選択になったら、編集には入らない。
     */
    scheduleFromClick(e, div, index) {
        this.cancelClick();
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
        const target = e.target;
        if (!target || typeof target.closest !== 'function' || target.closest(NOT_A_TEXT_CLICK)) return;
        if (!canEditInPlace(this.view.blocksData[index])) return;
        const point = { x: e.clientX, y: e.clientY };
        const onDblClick = () => this.cancelClick();
        div.addEventListener('dblclick', onDblClick, { once: true });
        this._clickTimer = setTimeout(() => {
            this._clickTimer = null;
            div.removeEventListener('dblclick', onDblClick);
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;
            if (!div.isConnected || !this.isSoleSelection(index)) return;
            this.begin(index, point);
        }, CLICK_DELAY);
    }

    cancelClick() {
        if (this._clickTimer) clearTimeout(this._clickTimer);
        this._clickTimer = null;
    }
}
