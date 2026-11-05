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
 *
 * 編集中のセルには原文 (**太字** などの記号も含む) を見せる。描画後の文字を編集して
 * しまうと、書式を書き戻す手段がなくなるため。
 */

import { t } from '../utils/I18n.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { enableLightbox } from '../ui/Lightbox.js';
import * as MdAssets from '../utils/MarkdownAssets.js';
import { applyTableOp, cellSource, findTables, replaceCell, toCellSource } from '../utils/MarkdownTableCells.js';

/* global marked */

/** 列の境界として反応する幅 (px)。 */
const EDGE = 5;
const MIN_COLUMN_WIDTH = 40;
const WIDTH_STORE_KEY = 'md_table_col_widths';
const WIDTH_STORE_FILES = 200;

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

    _begin(blockEl, index, cell, located, caret) {
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
        cell.addEventListener('keydown', state.onKeyDown);
        cell.addEventListener('blur', state.onBlur);
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

        const key = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'z' || key === 'y')) {
            this._handleHistoryKey(e, state, key === 'y' || e.shiftKey ? 'redo' : 'undo');
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
            this._moveTo(state, r, c, 'all');
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
        view.selectBlock(index, { reveal: null, keepSelection: true });

        const row = cell.parentElement.rowIndex;
        const col = cell.cellIndex;
        const op = (name) => () => {
            const fresh = this._locate(blockEl, index, table);
            if (!fresh) return;
            const next = applyTableOp(fresh.text, fresh.source, name, row, col);
            if (next !== fresh.text && this._writeBlock(index, next)) view._rerenderBlock(blockEl);
        };

        const items = [{ label: t('Copy'), action: () => view.copy() }, { type: 'separator' }];
        if (row > 0) items.push({ label: t('Insert Row Above'), action: op('row-above') });
        items.push(
            { label: t('Insert Row Below'), action: op('row-below') },
            { label: t('Insert Column Left'), action: op('col-left') },
            { label: t('Insert Column Right'), action: op('col-right') },
        );
        const canDeleteRow = row > 0;
        const canDeleteCol = located.source.columns > 1;
        if (canDeleteRow || canDeleteCol) items.push({ type: 'separator' });
        if (canDeleteRow) items.push({ label: t('Delete Row'), action: op('row-delete') });
        if (canDeleteCol) items.push({ label: t('Delete Column'), action: op('col-delete') });
        items.push(
            { type: 'separator' },
            { label: t('Edit this block'), hint: 'F2', action: () => view.editSelectedBlock() },
        );
        ContextMenu.show(e, items);
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
        }
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
