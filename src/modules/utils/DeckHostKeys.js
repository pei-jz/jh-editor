/**
 * DeckHostKeys.js — 古いエンジンのデッキでも、エディタの中で発表中の Esc / F5 が効くようにする。
 *
 * Deck View と発表用ウィンドウ (deck-audience.js) の両方が使う。発表用ウィンドウにも
 * 読み込まれるので、CodeMirror に頼る DeckHost.js とは分けてある。
 */
import '../../vendor/jh-deck-edit.js';

const DeckEdit = globalThis.JhDeckEdit;

/**
 * 古いエンジンのデッキに足す、発表中のキー操作の肩代わり。
 *
 * iframe の中にフォーカスがある間、キーはデッキのエンジンが受け取る。エディタの中での
 * F5 (発表の開始・終了) と、発表中の Esc (発表の終了) をエディタに渡す処理は
 * jh-presentation 0.8 系のエンジンから入ったもので、それより前のデッキでは
 *   - F5 が止められず、エディタの画面ごと再読み込みされて Welcome に戻る
 *   - Esc がデッキ自身のスライド一覧を開き、発表が終わらない
 * ため、同じことをするスクリプトを先頭に足す。window の capture で先に受け取るので、
 * エンジンにはそのキーが届かない。スライド一覧・ヘルプ・枠の編集中の Esc は、従来どおり
 * エンジンに任せる (それぞれを閉じるのが先)。
 */
const HOST_KEYS_SHIM = `<script>(function(){
if (window.parent === window) return;
var P = ${DeckEdit.PROTOCOL}, presenting = false;
function tell(type){ window.parent.postMessage({ jhdeck: P, type: type }, '*'); }
window.addEventListener('message', function(ev){
  var d = ev.data;
  if (ev.source === window.parent && d && d.jhdeck && d.type === 'present') presenting = !!d.on;
});
window.addEventListener('keydown', function(ev){
  var k = ev.key, mod = ev.ctrlKey || ev.metaKey;
  if (k === 'F5' || (mod && (k === 'r' || k === 'R'))) {
    ev.preventDefault(); ev.stopImmediatePropagation();
    if (k === 'F5') tell('present');
    return;
  }
  if (k !== 'Escape' || !presenting) return;
  var t = ev.target, b = document.body;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if ((b && b.classList.contains('deck-editing')) || document.querySelector('.deck-overview, .deck-help')) return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  tell('present-exit');
}, true);
})();</script>`;

/**
 * Deck View・発表用ウィンドウの iframe に入れる HTML。
 * エンジンが発表中のキーをエディタに渡せない (present-exit を知らない) デッキにだけ、
 * HOST_KEYS_SHIM を <head> の先頭に足す。新しいエンジンのデッキはそのまま返す
 */
export function withHostKeys(html) {
    const src = String(html == null ? '' : html);
    if (src.includes('present-exit')) return src;
    if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => m + HOST_KEYS_SHIM);
    return HOST_KEYS_SHIM + src;
}
