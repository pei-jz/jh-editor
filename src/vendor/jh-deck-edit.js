/*!
 * JH Deck Edit — デッキの「文字だけ編集」の共通ロジック (依存なし)
 *
 * デッキ (ブラウザ) とホスト (jh-editor など) の両方で同じルールを使うためのファイル。
 *   - ブラウザ: デッキに埋め込まれ、エンジンが編集できる要素の判定に使う
 *   - ホスト  : そのままコピーして読み込み (globalThis.JhDeckEdit)、ソースの書き換えに使う
 *
 * 「編集できる要素」は スライド番号 (0 始まり) + スライド内の順番 (0 始まり) で特定する。
 * ソース側は DOM を作り直さず、軽量なトークナイザーで要素の中身の位置 (オフセット) を求めて
 * その範囲だけを差し替えるので、ファイルの他の部分は 1 文字も変わらない。
 *
 * 仕様: docs/edit-protocol.md
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.JhDeckEdit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 編集ルールの版。デッキ (埋め込みエンジン) とホスト / 保存サーバーで一致している必要がある
  //   1: タグ・クラスの一覧で判定
  //   2: 構造で判定 (文字と行内要素だけを含む、いちばん外側の要素)
  var PROTOCOL = 2;

  // ------------------------------------------------------------------
  // 編集できる要素のルール (構造で判定)
  //   「文字を含み、中身が行内要素 (太字・リンク・改行など) だけの要素」を、いちばん外側の単位で編集対象にする。
  //   例: <div class="layer"><b>見出し</b><span>説明</span></div> → div 全体が 1 つの編集対象
  //       <div class="card"><h3>…</h3><ul><li>…</li></ul></div> → h3 と各 li が編集対象
  // ------------------------------------------------------------------
  /** 行内要素 (この要素だけを含む親は、まとめて 1 つの編集対象になる) */
  var INLINE = {
    a: 1, abbr: 1, b: 1, bdi: 1, bdo: 1, br: 1, cite: 1, code: 1, data: 1, del: 1, dfn: 1, em: 1, i: 1, ins: 1,
    kbd: 1, mark: 1, q: 1, rp: 1, rt: 1, ruby: 1, s: 1, samp: 1, small: 1, span: 1, strong: 1, sub: 1, sup: 1,
    time: 1, u: 1, var: 1, wbr: 1,
  };
  /** この要素とその中身は編集しない */
  var SKIP_TAGS = {
    pre: 1, svg: 1, math: 1, script: 1, style: 1, template: 1, noscript: 1, aside: 1,
    textarea: 1, input: 1, button: 1, select: 1, iframe: 1, canvas: 1, video: 1, audio: 1, object: 1, embed: 1,
  };
  /** この属性を持つ要素 (とその中身) は編集しない (表示中に JS が文字を書き換えるため) */
  var SKIP_ATTRS = ['data-count-to', 'data-typewriter'];
  var SKIP_CLASS = 'no-edit';

  function hasClass(classList, name) {
    for (var i = 0; i < classList.length; i++) if (classList[i] === name) return true;
    return false;
  }

  /** 要素自体が編集禁止の目印を持つか (この要素と中身をすべて除外) */
  function isBlocked(node) {
    if (SKIP_TAGS[node.tag]) return true;
    if (hasClass(node.classList, SKIP_CLASS)) return true;
    for (var i = 0; i < SKIP_ATTRS.length; i++) if (node.hasAttr(SKIP_ATTRS[i])) return true;
    return false;
  }

  /** 子孫がすべて行内要素で、編集禁止のものを含まないか */
  function inlineOnly(node) {
    var children = node.children;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (!INLINE[c.tag] || isBlocked(c) || !inlineOnly(c)) return false;
    }
    return true;
  }

  /**
   * 汎用の木構造 (node: { tag, classList, hasAttr(name), children, hasText() }) から、
   * スライドごとの編集できる要素を文書順に列挙する。
   * 上から順に見て、「編集禁止でなく・文字を含み・中身が行内要素だけ」の要素を見つけたら、
   * それを 1 つの編集対象にして、その中にはもう入らない。
   */
  function collect(slideNode) {
    var out = [];
    function walk(node) {
      if (isBlocked(node)) return;
      if (inlineOnly(node) && node.hasText()) { out.push(node); return; }
      var children = node.children;
      for (var i = 0; i < children.length; i++) walk(children[i]);
    }
    var top = slideNode.children;
    for (var i = 0; i < top.length; i++) walk(top[i]);
    return out;
  }

  // ------------------------------------------------------------------
  // ブラウザ (DOM) 用
  // ------------------------------------------------------------------
  function domNode(el) {
    return {
      el: el,
      tag: el.tagName.toLowerCase(),
      classList: el.classList ? Array.prototype.slice.call(el.classList) : [],
      hasAttr: function (n) { return el.hasAttribute(n); },
      hasText: function () { return normText(el.textContent || '', false) !== ''; },
      get children() { return Array.prototype.map.call(el.children, domNode); },
    };
  }

  /** DOM のスライド要素から、編集できる要素 (Element) の配列を返す */
  function editableElements(slideEl) {
    return collect(domNode(slideEl)).map(function (n) { return n.el; });
  }

  // ------------------------------------------------------------------
  // ソース (文字列) 用: 軽量トークナイザー
  // ------------------------------------------------------------------
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var RAW = { script: 1, style: 1, textarea: 1, title: 1 };
  /** 同じタグが来たら暗黙に閉じるもの (閉じタグの省略への最低限の対応) */
  var AUTO_CLOSE = { li: { li: 1 }, p: { p: 1 }, td: { td: 1, th: 1 }, th: { td: 1, th: 1 }, dt: { dt: 1, dd: 1 }, dd: { dt: 1, dd: 1 }, tr: { tr: 1 }, option: { option: 1 } };

  function parseAttrs(s) {
    var attrs = {}, re = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g, m;
    while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    return attrs;
  }

  function srcNode(tag, attrs, start, html, offset) {
    var classList = (attrs['class'] || '').split(/\s+/).filter(Boolean);
    var node = {
      tag: tag, attrs: attrs, classList: classList,
      hasAttr: function (n) { return Object.prototype.hasOwnProperty.call(attrs, n); },
      /** 中身に (タグ・コメントを除いた) 文字があるか */
      hasText: function () {
        var inner = html.slice(node.innerStart - offset, node.innerEnd - offset).replace(/<!--[\s\S]*?-->/g, '');
        return normText(inner, true) !== '';
      },
      start: start,        // 開始タグの先頭
      innerStart: -1,      // 中身の先頭 (開始タグの直後)
      innerEnd: -1,        // 中身の末尾 (終了タグの直前)
      end: -1,             // 終了タグの直後
      children: [],
    };
    return node;
  }

  /** HTML 文字列を簡易的な木にする (位置情報つき) */
  function parseTree(html, offset) {
    offset = offset || 0;
    var root = srcNode('#root', {}, 0, html, offset);
    root.innerStart = 0;
    var stack = [root];
    var re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=\/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/gi;
    var m;
    function close(node, at, endAt) { node.innerEnd = at; node.end = endAt; }
    while ((m = re.exec(html))) {
      if (m[1]) { // 終了タグ
        var name = m[1].toLowerCase();
        var i = stack.length - 1;
        while (i > 0 && stack[i].tag !== name) i--;
        if (i === 0) continue; // 対応する開始タグがない終了タグは無視
        // 間にある要素は終了タグが省略されたものとして閉じる
        while (stack.length - 1 > i) close(stack.pop(), m.index + offset, m.index + offset);
        close(stack.pop(), m.index + offset, m.index + m[0].length + offset);
        continue;
      }
      if (!m[2]) continue; // コメントなど
      var tag = m[2].toLowerCase();
      var top = stack[stack.length - 1];
      if (AUTO_CLOSE[top.tag] && AUTO_CLOSE[top.tag][tag]) close(stack.pop(), m.index + offset, m.index + offset);
      var node = srcNode(tag, parseAttrs(m[3] || ''), m.index + offset, html, offset);
      node.innerStart = m.index + m[0].length + offset;
      stack[stack.length - 1].children.push(node);
      if (VOID[tag] || m[4] === '/') { close(node, node.innerStart, node.innerStart); continue; }
      if (RAW[tag]) {
        var endRe = new RegExp('</' + tag + '\\s*>', 'gi');
        endRe.lastIndex = re.lastIndex;
        var em = endRe.exec(html);
        var endPos = em ? em.index : html.length;
        close(node, endPos + offset, (em ? endPos + em[0].length : endPos) + offset);
        re.lastIndex = em ? endRe.lastIndex : html.length;
        continue;
      }
      stack.push(node);
    }
    while (stack.length > 1) close(stack.pop(), html.length + offset, html.length + offset);
    return root;
  }

  /** ソース全体から jh:slides ブロックの範囲を返す */
  function slidesRange(source) {
    var open = '<!-- jh:slides -->', shut = '<!-- /jh:slides -->';
    var s = source.indexOf(open), e = source.indexOf(shut);
    if (s < 0 || e < s) return null;
    return { start: s + open.length, end: e };
  }

  /** 木から最上位の section.slide を文書順に集める (スライドの中の section は数えない) */
  function findSlides(tree) {
    var slides = [];
    (function find(node) {
      node.children.forEach(function (c) {
        if (c.tag === 'section' && hasClass(c.classList, 'slide')) slides.push(c);
        else find(c);
      });
    })(tree);
    return slides;
  }

  /**
   * スライド HTML (jh:slides の中身) から、各スライドの位置を返す。
   * @returns {{ start:number, end:number, id:string|null }[]}  start〜end が <section>…</section> 全体
   */
  function slideRanges(slidesHtml) {
    return findSlides(parseTree(String(slidesHtml), 0)).map(function (s) {
      return { start: s.start, end: s.end, id: s.attrs.id || null };
    });
  }

  /** ソースから、スライドごとの編集できる要素 (位置情報つき) を返す */
  function sourceEditables(source) {
    var r = slidesRange(source);
    if (!r) throw new Error('jh:slides ブロックがありません (jh-presentation のデッキではない)');
    return findSlides(parseTree(source.slice(r.start, r.end), r.start)).map(function (s) { return collect(s); });
  }

  // ------------------------------------------------------------------
  // 文字の比較 (安全確認用)
  // ------------------------------------------------------------------
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
    });
  }
  /** 比較用に正規化した文字列 (タグ除去・実体参照の展開・空白の圧縮) */
  function normText(htmlOrText, isHtml) {
    var s = isHtml ? decode(String(htmlOrText).replace(/<[^>]*>/g, '')) : String(htmlOrText);
    return s.replace(/[\s ]+/g, ' ').trim();
  }

  /**
   * 編集を 1 件ソースに反映する。
   * @param {string} source デッキファイル全体
   * @param {{slide:number, index:number, html:string, before?:string}} change
   * @returns {{ source:string, from:number, to:number, insert:string }} 差し替え範囲 (エディタのトランザクション用)
   */
  function applyEdit(source, change) {
    var all = sourceEditables(source);
    var list = all[change.slide];
    if (!list) throw new Error('スライドが見つかりません: ' + change.slide);
    var node = list[change.index];
    if (!node) throw new Error('編集対象が見つかりません: slide ' + change.slide + ' / index ' + change.index);
    var current = source.slice(node.innerStart, node.innerEnd);
    if (change.before != null && normText(current, true) !== normText(change.before, false)) {
      throw new Error('ソースとプレビューの内容が一致しません (ソースが変更された可能性があります。プレビューを更新してください)');
    }
    var insert = sanitize(change.html);
    return {
      source: source.slice(0, node.innerStart) + insert + source.slice(node.innerEnd),
      from: node.innerStart, to: node.innerEnd, insert: insert,
    };
  }

  /** 編集結果の HTML から、プレビュー側でしか意味のないものを取り除く */
  function sanitize(html) {
    return String(html)
      .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+contenteditable(="[^"]*")?/gi, '')
      .replace(/\s+data-jh-edit="[^"]*"/gi, '')
      .replace(/(<br\s*\/?>\s*)+$/i, '');
  }

  function isDeck(source) {
    return /<meta name="generator" content="jh-presentation[^"]*"/.test(String(source));
  }

  return {
    PROTOCOL: PROTOCOL,
    isDeck: isDeck,
    editableElements: editableElements,
    sourceEditables: sourceEditables,
    slideRanges: slideRanges,
    applyEdit: applyEdit,
    normText: normText,
    sanitize: sanitize,
    _parseTree: parseTree,
  };
});
