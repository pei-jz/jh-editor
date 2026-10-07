/**
 * DeckHost.js — jh-presentation のデッキを Deck View で扱うための共通処理。
 *
 * デッキ (1 ファイルの HTML) は、プレビューの iframe の中でスライドとして動き、
 * 文字を直すと postMessage で「どのスライドの何番目の枠を、何に変えたか」を送ってくる。
 * ここではその内容をソースに当てはめる。判定・照合のルールはデッキに埋め込まれているものと
 * 同じ src/vendor/jh-deck-edit.js (jh-presentation の engine/deck-edit.js の写し) を使うので、
 * デッキ側とエディタ側で食い違わない。
 *
 * 仕様: jh-presentation の docs/edit-protocol.md
 */
import '../../vendor/jh-deck-edit.js';
import { EditorState } from '@codemirror/state';
import { history, historyField, undo, redo } from '@codemirror/commands';

/** jh-presentation の編集ライブラリ (isDeck / sourceEditables / applyEdit / PROTOCOL) */
export const DeckEdit = globalThis.JhDeckEdit;

const TRUST_KEY = 'settings_deckTrustedPaths';
const TRUST_MAX = 500;
// パスのない (未保存の) タブは、そのタブを開いている間だけ許可を覚える
const trustedUntitled = new WeakSet();

/** HTML ファイルで、jh-presentation のデッキか */
export function isDeckFile(file) {
    if (!file || typeof file.content !== 'string') return false;
    const name = (file.path || file.name || '').toLowerCase();
    if (!name.endsWith('.html') && !name.endsWith('.htm')) return false;
    return DeckEdit.isDeck(file.content);
}

/** 許可の記録に使うパス (区切りと大文字小文字の違いを無視する) */
function trustKey(path) {
    return String(path).replace(/\\/g, '/').toLowerCase();
}

function readTrusted() {
    try {
        const list = JSON.parse(localStorage.getItem(TRUST_KEY) || '[]');
        return Array.isArray(list) ? list : [];
    } catch (_) {
        return [];
    }
}

/** このデッキのスクリプトを実行してよいと、すでに許可されているか */
export function isDeckTrusted(file) {
    if (!file) return false;
    if (!file.path) return trustedUntitled.has(file);
    return readTrusted().includes(trustKey(file.path));
}

/** このデッキのスクリプトの実行を許可する (次回からは確認しない) */
export function trustDeck(file) {
    if (!file) return;
    if (!file.path) { trustedUntitled.add(file); return; }
    const key = trustKey(file.path);
    // 新しいものを先頭に。古い記録から捨てて上限を保つ
    const list = [key, ...readTrusted().filter((p) => p !== key)].slice(0, TRUST_MAX);
    try { localStorage.setItem(TRUST_KEY, JSON.stringify(list)); } catch (_) { /* 保存できなくても今回は表示する */ }
}

/** ソースの、スライドごとの編集できる枠の数。読めないときは null */
export function editableCounts(source) {
    try {
        return DeckEdit.sourceEditables(source).map((list) => list.length);
    } catch (_) {
        return null;
    }
}

/**
 * デッキから届いた ready と、ソースの内容が対応しているか。
 * 編集ルールの版と、スライドごとの枠の数が一致しなければ、文字の編集はさせない
 * (何番目の枠かがずれて、別の場所を書き換えてしまうため)。
 */
export function canEditDeck(ready, source) {
    if (!ready || ready.jhdeck !== DeckEdit.PROTOCOL) return false;
    const counts = editableCounts(source);
    const theirs = ready.editables;
    if (!counts || !Array.isArray(theirs) || counts.length !== theirs.length) return false;
    return counts.every((n, i) => n === theirs[i]);
}

/**
 * デッキから届いた change をソースに当てはめる。
 * 枠が見つからない・直す前の文字がソースと合わないときは例外を投げる (何も書き換えない)。
 * @returns {{ source: string, from: number, to: number, insert: string }}
 */
export function applyDeckChange(source, change) {
    if (!change || change.protocol !== DeckEdit.PROTOCOL) {
        throw new Error('The deck uses a different edit rule version.');
    }
    return DeckEdit.applyEdit(source, change);
}

// ---------------------------------------------------------------------------
// スライド単位の操作 (一覧・並べ替え・複製・削除・ノート)
// ---------------------------------------------------------------------------
const OPEN = '<!-- jh:slides -->';
const SHUT = '<!-- /jh:slides -->';

function slidesBlock(source) {
    const s = source.indexOf(OPEN);
    const e = source.indexOf(SHUT);
    if (s < 0 || e < s) return null;
    return { start: s + OPEN.length, end: e };
}

function decodeEntities(text) {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** タグを外した文字 (改行は段落・br の区切りだけ) */
function plainText(html) {
    return decodeEntities(String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|li|div|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]*>/g, ''))
        .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

const NOTES_RE = /<aside\b[^>]*class="[^"]*\bnotes\b[^"]*"[^>]*>([\s\S]*?)<\/aside>/i;

/**
 * ソースのスライド一覧。start / end はソース全体での <section>…</section> の範囲。
 * @returns {{ index:number, id:string|null, title:string, notes:string, start:number, end:number }[]}
 */
export function slideList(source) {
    const block = slidesBlock(source);
    if (!block) return [];
    const html = source.slice(block.start, block.end);
    return DeckEdit.slideRanges(html).map((r, index) => {
        const section = html.slice(r.start, r.end);
        const body = section.replace(NOTES_RE, '');
        const heading = body.match(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i);
        const notes = section.match(NOTES_RE);
        return {
            index,
            id: r.id,
            title: heading ? plainText(heading[2]).replace(/\n/g, ' ') : '',
            notes: notes ? plainText(notes[1]) : '',
            start: block.start + r.start,
            end: block.start + r.end,
        };
    });
}

/** ソースの位置 (オフセット) が何枚目のスライドの中か。スライドの間ならその次のスライド */
export function slideIndexAt(source, offset) {
    const list = slideList(source);
    if (!list.length) return 0;
    const i = list.findIndex((s) => offset < s.end);
    return i < 0 ? list.length - 1 : i;
}

/**
 * スライドを並べ直したソースを作る。スライドの間の空白は位置ごとに元のまま使う。
 * @param {(sections: string[]) => string[]} reorder
 * @returns {{ source: string, change: { from:number, to:number, insert:string } }}
 */
function rebuildSlides(source, reorder) {
    const list = slideList(source);
    if (!list.length) throw new Error('No slides in this deck.');
    const sections = list.map((s) => source.slice(s.start, s.end));
    const gaps = list.slice(0, -1).map((s, i) => source.slice(s.end, list[i + 1].start));
    const next = reorder(sections);
    const gap = (i) => (gaps.length ? gaps[Math.min(i, gaps.length - 1)] : '\n\n');
    const insert = next.map((sec, i) => (i ? gap(i - 1) : '') + sec).join('');
    const from = list[0].start;
    const to = list[list.length - 1].end;
    return { source: source.slice(0, from) + insert + source.slice(to), change: { from, to, insert } };
}

/** from 枚目のスライドを to 枚目に移す */
export function moveSlide(source, from, to) {
    return rebuildSlides(source, (sections) => {
        const list = sections.slice();
        const [moved] = list.splice(from, 1);
        list.splice(Math.max(0, Math.min(to, list.length)), 0, moved);
        return list;
    });
}

/** index 枚目のスライドを複製して直後に置く。id は重ならないよう番号を付ける */
export function duplicateSlide(source, index) {
    const ids = new Set(slideList(source).map((s) => s.id).filter(Boolean));
    return rebuildSlides(source, (sections) => {
        let copy = sections[index];
        copy = copy.replace(/^(<section\b[^>]*?\sid=")([^"]*)(")/i, (m, a, id, b) => {
            let n = 2;
            while (ids.has(`${id}-${n}`)) n++;
            return a + `${id}-${n}` + b;
        });
        const list = sections.slice();
        list.splice(index + 1, 0, copy);
        return list;
    });
}

/** index 枚目のスライドを消す (最後の 1 枚は消せない) */
export function deleteSlide(source, index) {
    return rebuildSlides(source, (sections) => {
        if (sections.length <= 1) throw new Error('A deck needs at least one slide.');
        return sections.filter((_, i) => i !== index);
    });
}

/**
 * index 枚目のスライドの発表者ノートを書き換える。1 行が 1 段落 (<p>) になる。
 * ノートがなければ、スライドの末尾に <aside class="notes"> を足す。
 */
export function setSlideNotes(source, index, text) {
    const slide = slideList(source)[index];
    if (!slide) throw new Error('Slide not found: ' + index);
    const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
    const inner = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('');
    const section = source.slice(slide.start, slide.end);
    const m = section.match(NOTES_RE);
    let from, to, insert;
    if (m) {
        const innerStart = slide.start + m.index + m[0].indexOf('>') + 1;
        from = innerStart;
        to = innerStart + m[1].length;
        insert = inner;
    } else {
        if (!inner) return { source, change: null };
        const close = section.lastIndexOf('</section>');
        from = to = slide.start + close;
        insert = `  <aside class="notes">${inner}</aside>\n`;
    }
    return { source: source.slice(0, from) + insert + source.slice(to), change: { from, to, insert } };
}

// ---------------------------------------------------------------------------
// 元に戻す / やり直す (ソース表示の Undo 履歴と共有する)
// ---------------------------------------------------------------------------
//
// ソース表示 (CodeMirrorView) は、カーソル・スクロール・Undo 履歴をペインごとに
// file._cmViewState[pane] = { doc, selection, history, content, scrollTop } に残し、
// content が今のバッファと同じなら、次に開いたときにそのまま使う。
// Deck View での書き換えもこの履歴に積むので、ソース表示に切り替えても Ctrl+Z で戻せるし、
// Deck View の「元に戻す」もソース表示で入力した分まで同じ順番で戻せる。

function viewSlot(file, pane) {
    const slot = file._cmViewState && file._cmViewState[pane || 'left'];
    return slot && slot.doc ? slot : null;
}

function writeSlot(file, pane, state, prev) {
    if (!file._cmViewState) file._cmViewState = {};
    file._cmViewState[pane || 'left'] = {
        doc: state.doc,
        selection: state.selection,
        history: state.field(historyField, false),
        content: state.doc.toString(),
        // 書き換えた後の文書には古いスナップショットは合わないので、スクロール量だけ引き継ぐ
        scrollTop: prev ? prev.scrollTop || 0 : 0,
    };
}

function stateFor(file, pane, source) {
    const slot = viewSlot(file, pane);
    if (slot && slot.content === source) {
        try {
            return {
                slot,
                state: EditorState.create({
                    doc: slot.doc,
                    selection: slot.selection,
                    extensions: slot.history ? [history(), historyField.init(() => slot.history)] : [history()],
                }),
            };
        } catch (_) { /* 作り直す */ }
    }
    return { slot, state: EditorState.create({ doc: source, extensions: [history()] }) };
}

/**
 * Deck View でソースを書き換えたことを、ソース表示の Undo 履歴に積む。
 * @param {object} file   バッファ (file.content は書き換え前)
 * @param {string} pane   'left' / 'right'
 * @param {{from:number,to:number,insert:string}} change
 * @returns {string} 書き換え後のソース
 */
export function recordDeckEdit(file, pane, change) {
    const { slot, state } = stateFor(file, pane, file.content);
    const tr = state.update({
        changes: change,
        selection: { anchor: change.from + change.insert.length },
        userEvent: 'input.deck',
    });
    writeSlot(file, pane, tr.state, slot);
    return tr.state.doc.toString();
}

/**
 * 2 つの文字列が最初に食い違う位置。
 * 戻した後のカーソルは「書き換える前の位置」で、並べ替えの記録はスライド全体にかかるので、
 * どのスライドが変わったかは実際の差分から求める。
 */
function firstDifference(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}

/**
 * 元に戻す (redo = true でやり直す)。戻せるものがなければ null。
 * @returns {{ source: string, offset: number } | null}  offset は変わった場所
 */
export function undoDeckEdit(file, pane, redoIt = false) {
    const { slot, state } = stateFor(file, pane, file.content);
    let next = null;
    const ok = (redoIt ? redo : undo)({ state, dispatch: (tr) => { next = tr.state; } });
    if (!ok || !next) return null;
    writeSlot(file, pane, next, slot);
    const source = next.doc.toString();
    return { source, offset: firstDifference(file.content, source) };
}
