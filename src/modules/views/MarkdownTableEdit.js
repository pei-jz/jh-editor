/**
 * MarkdownTableEdit.js — 表示モードのまま Markdown の表を直す。
 *
 * セルをクリックするとその場で編集に入る。F2 の編集画面を開かずに済ませるのが目的で、
 * 表の組み替えが必要なときは右クリックのメニューか、今までどおり F2 を使う。
 *
 *   クリック          そのセルを編集 (クリックした位置にカーソル)
 *   Enter             確定して下のセルへ
 *   Tab / Shift+Tab   確定して右 / 左のセルへ
 *   ↑ / ↓             1 行目 / 最終行にカーソルがあれば上 / 下のセルへ
 *   ← / →             セルの先頭 / 末尾にカーソルがあれば左 / 右のセルへ
 *   Shift+Enter       セル内の改行 (<br>)
 *   Esc               取り消す
 *   外をクリック      確定
 *   Ctrl+Z / Ctrl+Y   入力の取り消し / やり直し。尽きたら確定済みの編集を文書の履歴で戻す
 *   Shift+矢印        セルの端まで文字を選んだら、隣のセルまでの範囲選択へ
 *   最後のセルで Tab  行を足して、その先頭のセルへ
 *   タブを含む貼り付け Excel などの複数のセルとして、このセルから書き込む
 *
 * 編集中のセルには原文 (**太字** などの記号も含む) を見せる。描画後の文字を編集して
 * しまうと、書式を書き戻す手段がなくなるため。
 *
 * セルの範囲選択 (編集はしていない状態)
 *
 *   ドラッグ          セルをまたぐと範囲選択。1 つのセルの中なら今までどおり文字を選ぶ
 *   Shift+クリック    編集中のセル / 選択の起点から、クリックしたセルまで
 *   Shift+矢印        範囲を広げる / 狭める
 *   Shift+Space       選択した行の全体
 *   Ctrl+A            表の全体
 *   Delete / BS       選択したセルを空にする
 *   Ctrl+C / X / V    コピー / 切り取り / 貼り付け (タブ区切り。Excel とやり取りできる)
 *   Enter / 矢印      選択をやめてセルの編集へ
 *   Esc               選択をやめてブロックの選択へ
 *   Ctrl+Shift++      選んだ行の数だけ上に行を足す (見出しから最終行まで選んだ列なら左に列)
 *   Ctrl+-            選んだ行を消す (見出しから最終行まで選んだ列なら列を消す)
 *   右クリック        行と列の挿入、選択した行や列の削除、内容の消去
 *
 * 範囲選択のあいだは、見えない入力欄 (.md-range-sink) がキーを受ける。ブロックの
 * Delete (ブロックの削除) や ↑↓ (ブロックの移動) は入力欄の中では働かないので、
 * セルへの操作と取り違えない。コピーと貼り付けも、その入力欄の標準のイベントで扱う。
 */

import { t } from '../utils/I18n.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { enableLightbox } from '../ui/Lightbox.js';
import * as MdAssets from '../utils/MarkdownAssets.js';
import { TableEditor } from '../editors/TableEditor.js';
import {
    applyTableOp, cellSource, clearCells, findTables, parseTsv, replaceCell, toCellSource, writeGrid,
} from '../utils/MarkdownTableCells.js';

/* global marked */

/** 列の境界として反応する幅 (px)。 */
const EDGE = 5;
const MIN_COLUMN_WIDTH = 40;
const WIDTH_STORE_KEY = 'md_table_col_widths';
const WIDTH_STORE_FILES = 200;
/**
 * Excel (と CSV の表) の行と列のキー。Ctrl+Shift++ は配列によって '+' / ';' / ':' / '='
 * で届き、テンキーの + は Shift なしで来る。
 * @returns {'insert'|'delete'|null}
 */
function structureKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
    if (e.shiftKey && ['+', ';', ':', '='].includes(e.key)) return 'insert';
    if (!e.shiftKey && e.key === '+') return 'insert';
    if (!e.shiftKey && e.key === '-') return 'delete';
    return null;
}

const ARROWS = {
    ArrowUp: { dr: -1, dc: 0 },
    ArrowDown: { dr: 1, dc: 0 },
    ArrowLeft: { dr: 0, dc: -1 },
    ArrowRight: { dr: 0, dc: 1 },
};

function readWidthStore() {
    try {
        return JSON.parse(localStorage.getItem(WIDTH_STORE_KEY) || '{}') || {};
    } catch (_) {
        return {};
    }
}

/** ブロック直下の表。引用やリストの中の表は原文との対応を取らない。 */
function topLevelTables(blockEl) {
    return Array.from(blockEl.querySelectorAll(':scope > table'));
}

function headerKey(table) {
    const head = table.rows[0];
    return head ? Array.from(head.cells, (c) => c.textContent.trim()).join('\u0001') : '';
}

/** 指定した列の全セル。 */
function columnCells(table, col) {
    return Array.from(table.rows, (r) => r.cells[col]).filter(Boolean);
}

function setColumnWidth(table, col, width) {
    for (const cell of columnCells(table, col)) {
        if (width === null) {
            cell.style.width = '';
            cell.style.minWidth = '';
            cell.style.maxWidth = '';
            cell.classList.remove('md-col-sized');
        } else {
            const px = `${Math.round(width)}px`;
            cell.style.width = px;
            cell.style.minWidth = px;
            cell.style.maxWidth = px;
            cell.classList.add('md-col-sized');
        }
    }
}

export class MarkdownTableEdit {
    /** @param {object} view MarkdownView */
    constructor(view) {
        this.view = view;
        this.active = null;
        /** セルの範囲選択。{ blockEl, index, tableIndex, anchor:{r,c}, focus:{r,c} } */
        this.range = null;
        this._sinkEl = null;
        /** 自分で描き直している間。入力欄が DOM から外れても選択を消さない。 */
        this._keepRange = false;
        this._suppressClick = false;
    }

    // ── 原文との対応 ──────────────────────────────────────────────────

    /** ブロック内の n 番目の表について、原文の情報を返す。対応が取れなければ null。 */
    _locate(blockEl, index, tableEl) {
        if (typeof marked === 'undefined') return null;
        const text = this.view.blocksData && this.view.blocksData[index];
        if (typeof text !== 'string') return null;
        const domTables = topLevelTables(blockEl);
        const tableIndex = domTables.indexOf(tableEl);
        if (tableIndex < 0) return null;

        let tables;
        try {
            tables = findTables(text, marked.lexer(text));
        } catch (err) {
            console.error('Markdown table: could not read the source', err);
            return null;
        }
        // 素の HTML で書かれた <table> が混ざると何番目かが食い違う。
        if (tables.length !== domTables.length) return null;
        const source = tables[tableIndex];
        if (!source.editable) return null;
        if (source.rows.length !== tableEl.rows.length) return null;
        if (!tableEl.rows[0] || tableEl.rows[0].cells.length !== source.columns) return null;
        return { text, source, tableIndex };
    }

    /** ブロックの原文を更新して、ファイルと履歴へ反映する。 */
    _writeBlock(index, newText) {
        const view = this.view;
        const file = view._viewFile();
        if (!file) return false;
        view.blocksData[index] = newText;
        // 履歴はこの時点のカーソルのブロックを覚え、Ctrl+Z はそこへ戻る。セルの範囲
        // 選択はブロックを選ばずに始まるので、そのままだと先頭のブロックへ飛んでいた。
        if (typeof view._setCursor === 'function') view._setCursor(index);
        view._commitContent(file, view._joinBlocks(file));
        if (view.renderTabs) view.renderTabs();
        return true;
    }

    // ── セルの編集 ────────────────────────────────────────────────────

    /**
     * ブロックのクリックを受ける。セルの編集が引き受けたクリックなら true を返すので、
     * 呼び出し側はブロックの選択処理をしない。
     */
    handleClick(e, blockEl, index) {
        // 列幅のドラッグの終わりに来るクリック。編集に入ってはいけない。
        if (this._suppressClick) {
            this._suppressClick = false;
            return true;
        }
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return false;
        if (target.closest('.md-cell-editing')) return true;
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
        if (target.closest('a, img, input, button, .md-block-tools')) return false;

        const cell = target.closest('td, th');
        const table = cell && cell.closest('table');
        if (!cell || !table || table.parentElement !== blockEl) return false;

        // ドラッグで文字を選んだ終わりのクリックは、コピーのための操作。
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && blockEl.contains(sel.anchorNode)) return false;

        const located = this._locate(blockEl, index, table);
        if (!located) return false;

        this.view.selectBlock(index, { focus: false, reveal: null });
        this._begin(blockEl, index, cell, located, { x: e.clientX, y: e.clientY });
        return true;
    }

    /**
     * 表のブロックで Enter: 最初の本文のセル (本文がなければ見出し) の編集から始める。
     * @returns {boolean} 始められたか (始められなければ呼び出し側がモーダルを開く)
     */
    beginAtFirstCell(index) {
        const container = this.view.container;
        const blockEl = container && container.querySelector(`.md-block[data-index="${index}"]:not(.phantom)`);
        if (!blockEl || !blockEl.dataset.rendered) return false;
        const table = topLevelTables(blockEl)[0];
        if (!table || !table.rows.length) return false;
        const located = this._locate(blockEl, index, table);
        if (!located) return false;
        const cell = table.rows[table.rows.length > 1 ? 1 : 0].cells[0];
        if (!cell) return false;
        this.view.selectBlock(index, { focus: false, reveal: null });
        this._begin(blockEl, index, cell, located, 'end');
        return true;
    }

    _begin(blockEl, index, cell, located, caret) {
        this.clearRange();
        const table = cell.closest('table');
        const row = cell.parentElement.rowIndex;
        const col = cell.cellIndex;
        const raw = cellSource(located.text, located.source, row, col);

        // 書式のないセルは DOM を差し替えない。ブラウザーが計算した、クリックした
        // 位置のカーソルをそのまま使えるようにするため。
        const plain = cell.children.length === 0 && cell.textContent === raw;
        const caretRange = plain && caret && typeof caret === 'object'
            && typeof document.caretRangeFromPoint === 'function'
            ? document.caretRangeFromPoint(caret.x, caret.y)
            : null;
        const nodes = Array.from(cell.childNodes);
        if (!plain) cell.textContent = raw;

        try {
            cell.contentEditable = 'plaintext-only';
        } catch (_) {
            cell.contentEditable = 'true';
        }
        cell.spellcheck = false;
        cell.classList.add('md-cell-editing');

        const state = {
            blockEl, index, cell, table, row, col, raw, plain, nodes, tableIndex: located.tableIndex,
            headerBefore: headerKey(table),
        };
        state.onKeyDown = (e) => this._onKeyDown(e, state);
        state.onBlur = () => this._onBlur(state);
        state.onPaste = (e) => this._onCellPaste(e, state);
        cell.addEventListener('keydown', state.onKeyDown);
        cell.addEventListener('blur', state.onBlur);
        cell.addEventListener('paste', state.onPaste);
        this.active = state;

        cell.focus({ preventScroll: true });
        this._placeCaret(cell, caret, caretRange);
    }

    _placeCaret(cell, caret, caretRange) {
        const sel = window.getSelection();
        if (!sel) return;
        const range = document.createRange();
        if (caretRange && cell.contains(caretRange.startContainer)) {
            range.setStart(caretRange.startContainer, caretRange.startOffset);
            range.collapse(true);
        } else {
            range.selectNodeContents(cell);
            if (caret === 'start') range.collapse(true);
            else if (caret !== 'all') range.collapse(false);
        }
        sel.removeAllRanges();
        sel.addRange(range);
    }

    /** 編集の見た目を片付ける。リスナーを先に外すので blur で二重に確定しない。 */
    _detach(state) {
        const { cell } = state;
        cell.removeEventListener('keydown', state.onKeyDown);
        cell.removeEventListener('blur', state.onBlur);
        cell.removeEventListener('paste', state.onPaste);
        cell.removeAttribute('contenteditable');
        cell.removeAttribute('spellcheck');
        cell.classList.remove('md-cell-editing');
        if (this.active === state) this.active = null;
    }

    _restore(state) {
        if (state.plain) state.cell.textContent = state.raw;
        else state.cell.replaceChildren(...state.nodes);
    }

    /**
     * 編集中のセルを確定する。ビューの作り直しの前にも呼ばれる。
     * @returns {boolean} 文書が変わったか
     */
    commit() {
        const state = this.active;
        if (!state) return false;
        const value = toCellSource(state.cell.textContent);
        this._detach(state);
        if (value === state.raw) {
            this._restore(state);
            return false;
        }

        const located = this._locate(state.blockEl, state.index, state.table);
        if (!located) {
            this._restore(state);
            return false;
        }
        const next = replaceCell(located.text, located.source, state.row, state.col, value);
        if (!this._writeBlock(state.index, next)) {
            this._restore(state);
            return false;
        }
        this._paintCell(state, next);
        return true;
    }

    /** セルだけ描き直す。ブロックごと作り直すとスクロールや列幅の計算が揺れる。 */
    _paintCell(state, text) {
        const scratch = document.createElement('div');
        scratch.innerHTML = this.view._parseMarkdown(text);
        const table = topLevelTables(scratch)[state.tableIndex];
        const fresh = table && table.rows[state.row] && table.rows[state.row].cells[state.col];
        if (!fresh) {
            // 入力で表の形そのものが変わった場合。ブロックごと描き直す。
            this.view._rerenderBlock(state.blockEl);
            return;
        }
        state.cell.replaceChildren(...fresh.childNodes);
        state.cell.querySelectorAll('a[data-file-link]').forEach((a) => {
            if (a.dataset.fileLink) this.view._installLinkPreview(a, a.dataset.fileLink);
        });
        enableLightbox(state.cell);
        if (MdAssets.hasMath(text)) MdAssets.renderMath(state.cell);
        if (state.row === 0) this._moveStoredWidths(state.headerBefore, headerKey(state.table));
    }

    cancel() {
        const state = this.active;
        if (!state) return;
        this._detach(state);
        this._restore(state);
    }

    _onBlur(state) {
        const { blockEl } = state;
        this.commit();
        // Ctrl+S のように、確定したあと行き先のないまま終わる操作のために、
        // キー操作を続けられる場所へフォーカスを戻す。
        setTimeout(() => {
            if (document.activeElement === document.body && blockEl.isConnected) {
                blockEl.focus({ preventScroll: true });
            }
        }, 0);
    }

    /** ブロックの選択へ戻る (Esc や、表の端で移動先がないとき)。 */
    _leave(state) {
        this.view.selectBlock(state.index, { reveal: null });
    }

    _moveTo(state, row, col, caret) {
        const nextCell = state.table.rows[row] && state.table.rows[row].cells[col];
        this.commit();
        if (!nextCell) {
            this._leave(state);
            return;
        }
        const located = this._locate(state.blockEl, state.index, state.table);
        if (!located) {
            this._leave(state);
            return;
        }
        this._begin(state.blockEl, state.index, nextCell, located, caret);
        nextCell.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }

    /** カーソルがセルの先頭行 (dir<0) / 最終行 (dir>0) にあるか。 */
    _caretOnEdgeLine(cell, dir) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return true;
        const rects = sel.getRangeAt(0).getClientRects();
        if (!rects.length) return true;            // 空のセル
        const caret = rects[dir < 0 ? 0 : rects.length - 1];
        const probe = document.createRange();
        probe.selectNodeContents(cell);
        const all = probe.getClientRects();
        if (!all.length) return true;
        const edge = all[dir < 0 ? 0 : all.length - 1];
        return dir < 0
            ? caret.top < edge.bottom - 1
            : caret.bottom > edge.top + 1;
    }

    /** カーソルがセルの先頭 (dir<0) / 末尾 (dir>0) にあるか。文字を選択中なら false。 */
    _caretAtCellEnd(cell, dir) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
        const caret = sel.getRangeAt(0);
        const rest = document.createRange();
        rest.selectNodeContents(cell);
        if (dir < 0) rest.setEnd(caret.startContainer, caret.startOffset);
        else rest.setStart(caret.endContainer, caret.endOffset);
        return rest.toString().length === 0;
    }

    /** 選択の動く側 (focus) がセルの先頭 (dir<0) / 末尾 (dir>0) にあるか。 */
    _focusAtCellEnd(cell, dir) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.focusNode || !cell.contains(sel.focusNode)) return true;
        const rest = document.createRange();
        rest.selectNodeContents(cell);
        if (dir < 0) rest.setEnd(sel.focusNode, sel.focusOffset);
        else rest.setStart(sel.focusNode, sel.focusOffset);
        return rest.toString().length === 0;
    }

    /** 選択の動く側がセルの先頭行 (dir<0) / 最終行 (dir>0) にあるか。 */
    _focusOnEdgeLine(cell, dir) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.focusNode || !cell.contains(sel.focusNode)) return true;
        const at = document.createRange();
        at.setStart(sel.focusNode, sel.focusOffset);
        at.collapse(true);
        const rects = at.getClientRects();
        if (!rects.length) return this._focusAtCellEnd(cell, dir);
        const probe = document.createRange();
        probe.selectNodeContents(cell);
        const all = probe.getClientRects();
        if (!all.length) return true;
        const edge = all[dir < 0 ? 0 : all.length - 1];
        return dir < 0 ? rects[0].top < edge.bottom - 1 : rects[0].bottom > edge.top + 1;
    }

    /**
     * 編集中のセルへの貼り付け。タブを含む文字は Excel などの複数のセルとして扱い、
     * このセルを左上に書き込む。タブのない文字は今までどおりセルの中へ入る。
     */
    _onCellPaste(e, state) {
        const text = e.clipboardData && e.clipboardData.getData('text/plain');
        if (!text || !text.includes('\t')) return;
        e.preventDefault();
        e.stopPropagation();
        const grid = parseTsv(text);
        if (!grid.length) return;
        const { blockEl, index, tableIndex, row, col } = state;
        this.commit();
        this._pasteGrid({ blockEl, index, tableIndex }, row, col, grid);
    }

    /**
     * セルの中の Ctrl+Z / Ctrl+Y。このセルで入力した分はブラウザーの標準の取り消しに
     * 任せる。それが尽きたら、確定済みの編集を文書の履歴から戻す。Enter で次のセルへ
     * 移った直後は、新しいセルに戻せるものがないので、ここを通らないと何も起きない。
     *
     * @returns {boolean} 文書の履歴で処理した (標準の動作を止めた) か
     */
    _handleHistoryKey(e, state, dir) {
        const unchanged = toCellSource(state.cell.textContent) === state.raw;
        if (dir === 'undo') {
            if (!unchanged) {
                state.undidNatively = true;
                return false;
            }
        } else if (!unchanged || state.undidNatively) {
            // 標準の取り消しで元に戻した直後なら、やり直しも標準の動作で入力を復元する。
            return false;
        }

        e.preventDefault();
        e.stopPropagation();
        const view = this.view;
        const file = view._viewFile();
        const stack = file && file._mdHistory && file._mdHistory[dir];
        // 戻すものがなければ、編集を続けられるようにセルに留まる。
        if (!stack || !stack.length) return true;
        // 文書を描き直すので、未入力のセルの編集は閉じる。戻した先はブロックの選択。
        this.cancel();
        view[dir]();
        return true;
    }

    _onKeyDown(e, state) {
        if (e.isComposing || e.keyCode === 229) return;
        const { row, col, table, cell } = state;
        const columns = table.rows[0] ? table.rows[0].cells.length : 0;

        const structure = structureKey(e);
        if (structure) {
            e.preventDefault();
            e.stopPropagation();
            const { blockEl, index, tableIndex } = state;
            this.commit();
            this._structureOp({ blockEl, index, tableIndex }, { r1: row, r2: row, c1: col, c2: col }, structure);
            return;
        }

        const key = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'z' || key === 'y')) {
            this._handleHistoryKey(e, state, key === 'y' || e.shiftKey ? 'redo' : 'undo');
            return;
        }

        const arrow = ARROWS[e.key];
        if (arrow && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            // 文字の選択をセルの端まで広げきってから、隣のセルへ。
            const dir = arrow.dr || arrow.dc;
            const atEdge = arrow.dr ? this._focusOnEdgeLine(cell, dir) : this._focusAtCellEnd(cell, dir);
            const target = table.rows[row + arrow.dr] && table.rows[row + arrow.dr].cells[col + arrow.dc];
            if (atEdge && target) {
                e.preventDefault();
                e.stopPropagation();
                this._rangeFromEdit(state, { r: row + arrow.dr, c: col + arrow.dc });
            }
            return;
        }

        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.cancel();
            this._leave(state);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) {
                document.execCommand('insertText', false, '<br>');
            } else if (!e.ctrlKey && !e.altKey) {
                this._moveTo(state, row + 1, col, 'end');
            }
        } else if (e.key === 'Tab' && !e.ctrlKey) {
            e.preventDefault();
            e.stopPropagation();
            const delta = e.shiftKey ? -1 : 1;
            let r = row;
            let c = col + delta;
            if (c >= columns) { c = 0; r++; }
            if (c < 0) { c = columns - 1; r--; }
            // 最後のセルの Tab は行を足して、その先頭のセルへ (Word や Notion の表と同じ)。
            if (r >= table.rows.length) this._appendRowAndEdit(state);
            else this._moveTo(state, r, c, 'all');
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey) {
            const dir = e.key === 'ArrowUp' ? -1 : 1;
            const target = table.rows[row + dir];
            if (target && this._caretOnEdgeLine(cell, dir)) {
                e.preventDefault();
                e.stopPropagation();
                this._moveTo(state, row + dir, col, 'end');
            }
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const dir = e.key === 'ArrowLeft' ? -1 : 1;
            let r = row;
            let c = col + dir;
            if (c >= columns) { c = 0; r++; }
            if (c < 0) { c = columns - 1; r--; }
            // 表の端では移動先がない。セルの中に留まる。
            if (table.rows[r] && table.rows[r].cells[c] && this._caretAtCellEnd(cell, dir)) {
                e.preventDefault();
                e.stopPropagation();
                this._moveTo(state, r, c, dir < 0 ? 'end' : 'start');
            }
        }
    }

    // ── 行と列の増減 (右クリック) ─────────────────────────────────────

    handleContextMenu(e, blockEl, index) {
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        // 編集中のセルは文字の入力欄なので、標準のメニュー (コピーなど) を出す。
        if (target.closest('.md-cell-editing')) {
            e.stopPropagation();
            return;
        }
        const cell = target.closest('td, th');
        const table = cell && cell.closest('table');
        if (!cell || !table || table.parentElement !== blockEl) return;
        if (target.closest('a, img')) return;

        const located = this._locate(blockEl, index, table);
        if (!located) return;

        const view = this.view;
        const tableIndex = located.tableIndex;
        const pos = { r: cell.parentElement.rowIndex, c: cell.cellIndex };

        // 選択した範囲の上なら範囲に対して、外なら押したセルに対して働く。
        // メニューを開くと入力欄からフォーカスが離れて選択が消えるので、ここで控えておく。
        const kept = this._rangeOn(blockEl, tableIndex) && this._inRange(pos);
        const b = kept ? this._bounds() : { r1: pos.r, r2: pos.r, c1: pos.c, c2: pos.c };
        if (!kept) this.clearRange();
        view.selectBlock(index, { reveal: null, keepSelection: true, focus: !kept });

        const where = { blockEl, index, tableIndex };
        const restore = () => {
            this.range = { ...where, anchor: { r: b.r1, c: b.c1 }, focus: { r: b.r2, c: b.c2 } };
        };
        const op = (name, row, col, endRow, endCol) => () => {
            this.clearRange();
            const fresh = this._locateAt(where);
            if (!fresh) return;
            const next = applyTableOp(fresh.text, fresh.source, name, row, col, endRow, endCol);
            if (next !== fresh.text && this._writeBlock(index, next)) view._rerenderBlock(blockEl);
        };

        const copy = kept
            ? () => {
                // 範囲のコピーは Ctrl+C と同じ道 (入力欄の copy イベント) を通す。
                restore();
                if (this._showRange()) document.execCommand('copy');
            }
            : () => view.copy();
        const items = [{ label: t('Copy'), action: copy }, { type: 'separator' }];
        if (b.r1 > 0) items.push({ label: t('Insert Row Above'), hint: 'Ctrl+Shift++', action: op('row-above', b.r1, b.c1) });
        items.push(
            { label: t('Insert Row Below'), action: op('row-below', b.r2, b.c1) },
            { label: t('Insert Column Left'), action: op('col-left', b.r1, b.c1) },
            { label: t('Insert Column Right'), action: op('col-right', b.r1, b.c2) },
        );

        // 見出し行は消さない。範囲に含まれていても数えない。
        const firstRow = Math.max(1, b.r1);
        const rowsToDelete = b.r2 - firstRow + 1;
        const colsToDelete = b.c2 - b.c1 + 1;
        items.push({ type: 'separator' });
        items.push({
            label: t('Clear Contents'),
            action: () => {
                restore();
                this._rewrite((loc) => clearCells(loc.text, loc.source, b));
            },
        });
        if (rowsToDelete > 0) {
            items.push({
                label: rowsToDelete > 1 ? t('Delete {n} Rows', { n: rowsToDelete }) : t('Delete Row'),
                hint: 'Ctrl+-',
                action: op('row-delete', firstRow, b.c1, b.r2, b.c2),
            });
        }
        if (colsToDelete < located.source.columns) {
            items.push({
                label: colsToDelete > 1 ? t('Delete {n} Columns', { n: colsToDelete }) : t('Delete Column'),
                action: op('col-delete', b.r1, b.c1, b.r2, b.c2),
            });
        }
        items.push(
            { type: 'separator' },
            { label: t('Edit this block'), hint: 'F2', action: () => view.editSelectedBlock() },
        );
        ContextMenu.show(e, items);
    }

    // ── セルの範囲選択 ────────────────────────────────────────────────

    _rangeOn(blockEl, tableIndex) {
        const r = this.range;
        return !!r && r.blockEl === blockEl && r.tableIndex === tableIndex;
    }

    _bounds(r = this.range) {
        return {
            r1: Math.min(r.anchor.r, r.focus.r),
            r2: Math.max(r.anchor.r, r.focus.r),
            c1: Math.min(r.anchor.c, r.focus.c),
            c2: Math.max(r.anchor.c, r.focus.c),
        };
    }

    _inRange(pos) {
        if (!this.range) return false;
        const b = this._bounds();
        return pos.r >= b.r1 && pos.r <= b.r2 && pos.c >= b.c1 && pos.c <= b.c2;
    }

    /** where = { blockEl, index, tableIndex } の表。描き直したあとも番号で探し直す。 */
    _tableAt(where) {
        if (!where || !where.blockEl || !where.blockEl.isConnected) return null;
        return topLevelTables(where.blockEl)[where.tableIndex] || null;
    }

    _locateAt(where) {
        const table = this._tableAt(where);
        return table ? this._locate(where.blockEl, where.index, table) : null;
    }

    _unpaint(table) {
        if (!table) return;
        table.querySelectorAll('.md-cell-range, .md-cell-range-focus').forEach((c) => {
            c.classList.remove('md-cell-range', 'md-cell-range-focus');
        });
        table.classList.remove('md-range-dragging');
    }

    _paintRange() {
        const r = this.range;
        const table = this._tableAt(r);
        if (!table) return null;
        this._unpaint(table);
        const b = this._bounds();
        for (let row = b.r1; row <= b.r2; row++) {
            const tr = table.rows[row];
            for (let col = b.c1; col <= b.c2 && tr; col++) {
                if (tr.cells[col]) tr.cells[col].classList.add('md-cell-range');
            }
        }
        const focusCell = table.rows[r.focus.r] && table.rows[r.focus.r].cells[r.focus.c];
        if (focusCell) focusCell.classList.add('md-cell-range-focus');
        return table;
    }

    /** 選択を表の大きさに収めて描き、キーを受ける入力欄へフォーカスを移す。 */
    _showRange() {
        const r = this.range;
        const table = this._tableAt(r);
        if (!table || !table.rows.length || !table.rows[0].cells.length) {
            this.clearRange();
            return false;
        }
        const rows = table.rows.length;
        const cols = table.rows[0].cells.length;
        const clamp = (p) => ({ r: Math.max(0, Math.min(p.r, rows - 1)), c: Math.max(0, Math.min(p.c, cols - 1)) });
        r.anchor = clamp(r.anchor);
        r.focus = clamp(r.focus);
        this._paintRange();
        this._focusSink();
        const focusCell = table.rows[r.focus.r].cells[r.focus.c];
        if (focusCell && typeof focusCell.scrollIntoView === 'function') {
            focusCell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        return true;
    }

    /** 範囲選択をやめる。フォーカスの行き先は呼び出し側が決める。 */
    clearRange() {
        const r = this.range;
        this.range = null;
        if (r) this._unpaint(this._tableAt(r));
        const sink = this._sinkEl;
        // フォーカスのある要素を外すと、ブラウザーはその場で blur を起こす。blur から
        // ここへ戻ってきて 2 度目の remove() を呼ぶと例外になり、呼び出し元の処理
        // (Ctrl+Z の取り消しなど) がそこで止まっていた。
        if (sink && sink.isConnected && !this._removingSink) {
            this._removingSink = true;
            try {
                sink.remove();
            } finally {
                this._removingSink = false;
            }
        }
    }

    _sink() {
        if (this._sinkEl) return this._sinkEl;
        const sink = document.createElement('textarea');
        // md-cell-editing は、ShortcutManager とブロックのキー操作が「文字の入力欄」
        // として扱い、キーに手を出さないための目印。
        sink.className = 'md-cell-editing md-range-sink';
        sink.setAttribute('aria-label', t('Selected cells'));
        sink.setAttribute('tabindex', '-1');
        sink.spellcheck = false;
        sink.addEventListener('keydown', (e) => this._onRangeKey(e));
        sink.addEventListener('copy', (e) => this._onRangeCopy(e, false));
        sink.addEventListener('cut', (e) => this._onRangeCopy(e, true));
        sink.addEventListener('paste', (e) => this._onRangePaste(e));
        // 文字の入力は受け付けない (Enter か矢印で編集に入る)。
        sink.addEventListener('input', () => this._resetSink());
        sink.addEventListener('blur', () => {
            if (!this._keepRange && this.range) this.clearRange();
        });
        this._sinkEl = sink;
        return sink;
    }

    /** copy イベントを確実に起こすため、1 文字を選んだ状態にしておく。 */
    _resetSink() {
        const sink = this._sinkEl;
        if (!sink) return;
        sink.value = ' ';
        sink.select();
    }

    _focusSink() {
        const sink = this._sink();
        const blockEl = this.range.blockEl;
        this._keepRange = true;
        try {
            if (sink.parentElement !== blockEl) blockEl.appendChild(sink);
            sink.focus({ preventScroll: true });
            this._resetSink();
        } finally {
            this._keepRange = false;
        }
    }

    _rangeFromEdit(state, focus) {
        const { blockEl, index, tableIndex, row, col } = state;
        this.commit();
        this.range = { blockEl, index, tableIndex, anchor: { r: row, c: col }, focus };
        this._showRange();
    }

    /** 選択をやめて、指定のセルの編集に入る。 */
    _editAt(pos, caret = 'end') {
        const r = this.range;
        const where = { blockEl: r.blockEl, index: r.index, tableIndex: r.tableIndex };
        this.clearRange();
        const table = this._tableAt(where);
        const cell = table && table.rows[pos.r] && table.rows[pos.r].cells[pos.c];
        const located = cell && this._locate(where.blockEl, where.index, table);
        if (!located) {
            this._leaveTo(where.index);
            return;
        }
        this._begin(where.blockEl, where.index, cell, located, caret);
        if (typeof cell.scrollIntoView === 'function') cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    _leaveTo(index) {
        this.view.selectBlock(index, { reveal: null });
    }

    /**
     * 選択している表の原文を書き換えて描き直し、選択を描き直した表の上へ戻す。
     * 書き換え後に選んでおきたい範囲は、呼び出し側で this.range に入れておく。
     */
    _rewrite(mutate) {
        const r = this.range;
        if (!r) return false;
        const located = this._locateAt(r);
        if (!located) {
            this.clearRange();
            return false;
        }
        const next = mutate(located);
        let changed = false;
        if (next !== located.text) {
            this._keepRange = true;
            try {
                changed = this._writeBlock(r.index, next);
                if (changed) this.view._rerenderBlock(r.blockEl);
            } finally {
                this._keepRange = false;
            }
        }
        if (this.range === r) this._showRange();
        return changed;
    }

    /**
     * Ctrl+Shift++ / Ctrl+- (CSV の表と同じ、Excel のキー)。範囲が見出しから最終行
     * まで縦に通っていれば列として、そうでなければ行として、選んだ数だけ足す / 消す。
     * 行は選択の上に、列は左に足す。見出し行と最後の 1 列は消さない。
     */
    _structureOp(where, b, kind) {
        const table = this._tableAt(where);
        if (!table || !table.rows[0]) return;
        const rows = table.rows.length;
        const cols = table.rows[0].cells.length;
        const wholeColumns = b.r1 === 0 && b.r2 === rows - 1 && rows > 1;
        const firstRow = Math.max(1, b.r1);
        const rowCount = Math.max(1, b.r2 - firstRow + 1);
        const colCount = b.c2 - b.c1 + 1;

        let op;
        let args;
        let anchor;
        let focus;
        if (kind === 'insert' && wholeColumns) {
            op = 'col-left';
            args = [0, b.c1, 0, b.c2];
            anchor = { r: 0, c: b.c1 };
            focus = { r: rows - 1, c: b.c1 + colCount - 1 };
        } else if (kind === 'insert') {
            op = 'row-above';
            args = [firstRow, b.c1, firstRow + rowCount - 1, b.c2];
            anchor = { r: firstRow, c: 0 };
            focus = { r: firstRow + rowCount - 1, c: cols - 1 };
        } else if (wholeColumns) {
            if (colCount >= cols) return;
            op = 'col-delete';
            args = [0, b.c1, rows - 1, b.c2];
            anchor = { r: 0, c: b.c1 };
            focus = { r: rows - 1, c: b.c1 };
        } else {
            if (b.r2 < 1) return;
            op = 'row-delete';
            args = [firstRow, b.c1, b.r2, b.c2];
            anchor = { r: firstRow, c: b.c1 };
            focus = { r: firstRow, c: b.c2 };
        }
        this.range = { ...where, anchor, focus };
        this._rewrite((loc) => applyTableOp(loc.text, loc.source, op, ...args));
    }

    /** 最後のセルから Tab: 行を足して、その行の先頭のセルの編集へ。 */
    _appendRowAndEdit(state) {
        const { blockEl, index, tableIndex } = state;
        const where = { blockEl, index, tableIndex };
        this.commit();
        const located = this._locateAt(where);
        if (!located) return;
        const last = located.source.rows.length - 1;
        const next = applyTableOp(located.text, located.source, 'row-below', last, 0);
        if (!this._writeBlock(index, next)) return;
        this.view._rerenderBlock(blockEl);
        const table = this._tableAt(where);
        const cell = table && table.rows[last + 1] && table.rows[last + 1].cells[0];
        const fresh = cell && this._locate(blockEl, index, table);
        if (!fresh) return;
        this._begin(blockEl, index, cell, fresh, 'end');
        if (typeof cell.scrollIntoView === 'function') cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    _pasteGrid(where, row, col, grid) {
        const width = Math.max(...grid.map((g) => g.length));
        this.range = { ...where, anchor: { r: row, c: col }, focus: { r: row + grid.length - 1, c: col + width - 1 } };
        return this._rewrite((loc) => writeGrid(loc.text, loc.source, row, col, grid));
    }

    _onRangeKey(e) {
        if (e.isComposing || e.keyCode === 229) return;
        const r = this.range;
        const table = r && this._tableAt(r);
        if (!table) {
            this.clearRange();
            return;
        }
        const rows = table.rows.length;
        const cols = table.rows[0] ? table.rows[0].cells.length : 0;
        const stop = () => { e.preventDefault(); e.stopPropagation(); };
        const ctrl = e.ctrlKey || e.metaKey;

        const structure = structureKey(e);
        if (structure) {
            stop();
            this._structureOp({ blockEl: r.blockEl, index: r.index, tableIndex: r.tableIndex }, this._bounds(), structure);
            return;
        }

        if (ctrl && !e.altKey) {
            const key = e.key.toLowerCase();
            if (key === 'a') {
                stop();
                r.anchor = { r: 0, c: 0 };
                r.focus = { r: rows - 1, c: cols - 1 };
                this._showRange();
            } else if (key === 'z' || key === 'y') {
                stop();
                const dir = key === 'y' || e.shiftKey ? 'redo' : 'undo';
                const index = r.index;
                this.clearRange();
                this._leaveTo(index);
                this.view[dir]();
            }
            // C / X / V は入力欄の copy / cut / paste イベントで受ける。
            return;
        }

        const arrow = ARROWS[e.key];
        if (arrow && !e.altKey) {
            stop();
            const next = { r: r.focus.r + arrow.dr, c: r.focus.c + arrow.dc };
            if (e.shiftKey) {
                r.focus = next;
                this._showRange();
            } else {
                this._editAt({
                    r: Math.max(0, Math.min(next.r, rows - 1)),
                    c: Math.max(0, Math.min(next.c, cols - 1)),
                });
            }
        } else if (e.key === 'Enter' && !e.altKey && !e.shiftKey) {
            stop();
            this._editAt(r.focus);
        } else if (e.key === 'Escape') {
            stop();
            const index = r.index;
            this.clearRange();
            this._leaveTo(index);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            stop();
            const b = this._bounds();
            this._rewrite((loc) => clearCells(loc.text, loc.source, b));
        } else if (e.key === ' ' && e.shiftKey && !e.altKey) {
            stop();
            r.anchor = { r: r.anchor.r, c: 0 };
            r.focus = { r: r.focus.r, c: cols - 1 };
            this._showRange();
        } else if (e.key === 'Tab') {
            // フォーカスが表の外へ抜けて、選択が消えるのを防ぐ。
            stop();
        }
    }

    /**
     * 範囲のコピー。text/plain は原文 (エディターの表へ貼り戻すと書式が残る)、
     * text/html は書式を反映した表 (Excel や Word はこちらを読む)。
     */
    _onRangeCopy(e, cut) {
        const r = this.range;
        const located = r && this._locateAt(r);
        if (!located || !e.clipboardData) return;
        e.preventDefault();
        const b = this._bounds();
        const slice = [];
        for (let row = b.r1; row <= b.r2; row++) {
            const values = [];
            for (let col = b.c1; col <= b.c2; col++) values.push(cellSource(located.text, located.source, row, col));
            slice.push(values);
        }
        e.clipboardData.setData('text/plain', slice.map((v) => v.join('\t')).join('\n'));
        try {
            e.clipboardData.setData('text/html', TableEditor.toHtml(slice, { formatted: true, header: b.r1 === 0 }));
        } catch (_) { /* text/plain だけでも貼り付けられる */ }
        if (cut) this._rewrite((loc) => clearCells(loc.text, loc.source, b));
    }

    /**
     * 範囲への貼り付け。1 つの値なら選んだセルすべてに、複数の値なら選択の左上から
     * 書き込む。表からはみ出す分は行や列を足す。
     */
    _onRangePaste(e) {
        const r = this.range;
        if (!r || !e.clipboardData) return;
        e.preventDefault();
        let grid = parseTsv(e.clipboardData.getData('text/plain'));
        if (!grid.length) return;
        const b = this._bounds();
        if (grid.length === 1 && grid[0].length === 1) {
            const value = grid[0][0];
            grid = [];
            for (let row = b.r1; row <= b.r2; row++) grid.push(new Array(b.c2 - b.c1 + 1).fill(value));
        }
        this._pasteGrid({ blockEl: r.blockEl, index: r.index, tableIndex: r.tableIndex }, b.r1, b.c1, grid);
    }

    /**
     * 表の上の mousedown。Shift+クリックと、セルをまたぐドラッグを範囲選択にする。
     * 1 つのセルの中のドラッグは文字の選択のまま (コピーのため)。
     */
    _onTableMouseDown(e, blockEl, table) {
        if (e.defaultPrevented) return;
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        const cell = target.closest('td, th');
        if (!cell || cell.closest('table') !== table) return;
        if (target.closest('a, img, input, button')) return;
        const tableIndex = topLevelTables(blockEl).indexOf(table);
        if (tableIndex < 0) return;
        const index = Number(blockEl.dataset.index);
        const where = { blockEl, index, tableIndex };
        const pos = { r: cell.parentElement.rowIndex, c: cell.cellIndex };
        const inThisTable = this._rangeOn(blockEl, tableIndex);

        if (e.button === 2) {
            // 右クリックで入力欄からフォーカスが離れると、選択が消えてしまう。
            if (inThisTable && this._inRange(pos)) e.preventDefault();
            return;
        }
        if (e.button !== 0) return;

        if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            let anchor = null;
            if (inThisTable) anchor = this.range.anchor;
            else if (this.active && this.active.blockEl === blockEl && this.active.tableIndex === tableIndex) {
                anchor = { r: this.active.row, c: this.active.col };
            }
            if (!anchor) return;            // ブロックの範囲選択に任せる
            if (!this._locate(blockEl, index, table)) return;
            e.preventDefault();
            this._suppressClickUntilMouseUp();
            this.commit();
            this.range = { ...where, anchor, focus: pos };
            this._showRange();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if (!this._locate(blockEl, index, table)) return;

        let ranging = false;
        const onMove = (ev) => {
            if (!(ev.buttons & 1)) { end(); return; }
            const now = this._tableAt(where);
            const over = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('td, th') : null;
            if (!now || !over || over.closest('table') !== now) return;
            const p = { r: over.parentElement.rowIndex, c: over.cellIndex };
            if (!ranging) {
                if (p.r === pos.r && p.c === pos.c) return;
                ranging = true;
                this.commit();
                this.range = { ...where, anchor: pos, focus: p };
            } else if (this.range) {
                this.range.focus = p;
            } else {
                end();
                return;
            }
            const sel = window.getSelection();
            if (sel) sel.removeAllRanges();
            const painted = this._paintRange();
            if (painted) painted.classList.add('md-range-dragging');
        };
        const end = () => {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
        };
        const onUp = () => {
            end();
            if (!ranging || !this.range) return;
            // 離した位置で click が来る。セルの編集の合図ではない。
            this._suppressClick = true;
            setTimeout(() => { this._suppressClick = false; }, 0);
            this._showRange();
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
    }

    /** Shift+クリックに続く click を、ボタンを離すまで編集に回さない。 */
    _suppressClickUntilMouseUp() {
        this._suppressClick = true;
        const release = () => {
            document.removeEventListener('mouseup', release, true);
            setTimeout(() => { this._suppressClick = false; }, 0);
        };
        document.addEventListener('mouseup', release, true);
    }

    // ── 列幅 ──────────────────────────────────────────────────────────
    //
    // Markdown には列幅を書く場所がないので、ファイルの中身は変えず、ファイルのパスと
    // 見出し行に結びつけてこの PC に覚えておく。

    _widthsOwner() {
        const file = this.view.file;
        return file && file.path ? file.path : null;
    }

    _storedWidths(table) {
        const key = headerKey(table);
        const path = this._widthsOwner();
        if (!path) {
            const file = this.view.file;
            return (file && file._mdColWidths && file._mdColWidths[key]) || null;
        }
        const entry = readWidthStore()[path];
        return (entry && entry[key]) || null;
    }

    _saveWidths(table, widths) {
        const key = headerKey(table);
        const path = this._widthsOwner();
        if (!path) {
            const file = this.view.file;
            if (file) (file._mdColWidths || (file._mdColWidths = {}))[key] = widths;
            return;
        }
        const store = readWidthStore();
        const entry = store[path] || {};
        if (Object.keys(widths).length) entry[key] = widths;
        else delete entry[key];
        // 使ったファイルを末尾に置き直し、古いものから捨てる。
        delete store[path];
        if (Object.keys(entry).length) store[path] = entry;
        const paths = Object.keys(store);
        for (let i = 0; i < paths.length - WIDTH_STORE_FILES; i++) delete store[paths[i]];
        try {
            localStorage.setItem(WIDTH_STORE_KEY, JSON.stringify(store));
        } catch (_) {
            /* 保存できなくても、この表示のあいだは効いている */
        }
    }

    /** 見出しを書き換えても、指定した列幅を失わないようにする。 */
    _moveStoredWidths(fromKey, toKey) {
        if (fromKey === toKey) return;
        const path = this._widthsOwner();
        if (!path) {
            const all = this.view.file && this.view.file._mdColWidths;
            if (all && all[fromKey]) { all[toKey] = all[fromKey]; delete all[fromKey]; }
            return;
        }
        const store = readWidthStore();
        const entry = store[path];
        if (!entry || !entry[fromKey]) return;
        entry[toKey] = entry[fromKey];
        delete entry[fromKey];
        try {
            localStorage.setItem(WIDTH_STORE_KEY, JSON.stringify(store));
        } catch (_) { /* 同上 */ }
    }

    /** マウスの位置が列の右の境界の上なら、その列番号を返す。 */
    _edgeColumn(e, table) {
        const cell = e.target && e.target.closest ? e.target.closest('td, th') : null;
        if (!cell || cell.closest('table') !== table) return -1;
        const rect = cell.getBoundingClientRect();
        if (rect.right - e.clientX <= EDGE && rect.right - e.clientX >= -1) return cell.cellIndex;
        if (e.clientX - rect.left <= EDGE && cell.cellIndex > 0) return cell.cellIndex - 1;
        return -1;
    }

    /** 描画したブロックの表に、列幅の操作と保存した幅を与える。 */
    attach(blockEl, index) {
        const tables = topLevelTables(blockEl);
        if (!tables.length) return;

        for (const table of tables) {
            const stored = this._storedWidths(table);
            if (stored) {
                for (const [col, width] of Object.entries(stored)) setColumnWidth(table, Number(col), width);
            }
            this._attachResize(table);
            table.addEventListener('mousedown', (e) => this._onTableMouseDown(e, blockEl, table));
        }
        // ブロックの要素は描き直しても同じものが使われる。描くたびに足すと、
        // 右クリック 1 回でメニューの処理が何度も走る。
        if (blockEl.__mdTableMenu) return;
        blockEl.__mdTableMenu = true;
        blockEl.addEventListener('contextmenu', (e) => this.handleContextMenu(e, blockEl, Number(blockEl.dataset.index)));
    }

    _attachResize(table) {
        table.addEventListener('pointermove', (e) => {
            if (e.buttons) return;
            table.classList.toggle('md-col-resize-hover', this._edgeColumn(e, table) >= 0);
        });
        table.addEventListener('pointerleave', () => table.classList.remove('md-col-resize-hover'));

        table.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const col = this._edgeColumn(e, table);
            if (col < 0) return;
            e.preventDefault();
            e.stopPropagation();
            this.commit();

            const head = table.rows[0] && table.rows[0].cells[col];
            if (!head) return;
            const startX = e.clientX;
            const startWidth = head.getBoundingClientRect().width;
            let moved = false;
            table.setPointerCapture?.(e.pointerId);

            const onMove = (ev) => {
                if (Math.abs(ev.clientX - startX) > 1) moved = true;
                if (moved) setColumnWidth(table, col, Math.max(MIN_COLUMN_WIDTH, startWidth + ev.clientX - startX));
            };
            const onUp = () => {
                table.removeEventListener('pointermove', onMove);
                table.removeEventListener('pointerup', onUp);
                table.removeEventListener('pointercancel', onUp);
                // 境界の上で離したので、続いて来るクリックは編集の合図ではない。
                this._suppressClick = true;
                setTimeout(() => { this._suppressClick = false; }, 0);
                if (!moved) return;
                const widths = { ...(this._storedWidths(table) || {}) };
                widths[col] = Math.round(head.getBoundingClientRect().width);
                this._saveWidths(table, widths);
            };
            table.addEventListener('pointermove', onMove);
            table.addEventListener('pointerup', onUp);
            table.addEventListener('pointercancel', onUp);
        });

        // 境界のダブルクリックで、列幅を内容に合わせた状態へ戻す。
        table.addEventListener('dblclick', (e) => {
            const col = this._edgeColumn(e, table);
            if (col < 0) return;
            e.preventDefault();
            e.stopPropagation();
            setColumnWidth(table, col, null);
            const widths = { ...(this._storedWidths(table) || {}) };
            delete widths[col];
            this._saveWidths(table, widths);
        });
    }
}
