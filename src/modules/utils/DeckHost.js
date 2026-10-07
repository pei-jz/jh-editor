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
