/**
 * 描いた図 (Mermaid の SVG) を、読める大きさで画面に収める。
 *
 * 決め方は三つの上限の小さい方:
 *   1. 元の大きさ (viewBox) より大きくしない — 小さな図を引き伸ばさない
 *   2. 枠の幅に収める — width: 100% と max-width で、幅が変わっても追従する
 *   3. 高さを maxHeight に収める — 縦に長い図が画面何枚分にもならないように
 *
 * ただし 3 で縮めるのは READABLE_SCALE まで。それより縮めると文字が
 * 読めなくなるので、そこから先は縦にスクロールしてもらう (以前、小さすぎて
 * 読めないと言われた側に戻さないための下限)。幅に収める 2 には下限を
 * 付けない — はみ出すと横スクロールになり、図の全体が見えなくなる。
 *
 * 図の種類によって mermaid が付ける大きさの指定はまちまち (max-width が
 * 付かない、height="100%" になる など) なので、viewBox から全部決め直す。
 */

/** 高さ合わせで縮めてよい下限。mermaid の 16px の文字が 10px 前後になる。 */
export const READABLE_SCALE = 0.6;

/** viewBox から元の大きさを読む。無ければ null。 */
export function naturalSize(svg) {
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    return vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? { w: vb[2], h: vb[3] } : null;
}

/**
 * 高さの上限だけから決まる倍率 (幅は CSS の width: 100% が受け持つ)。
 * @param {{w:number,h:number}} n 元の大きさ
 * @param {number} maxHeight 収めたい高さ (px)。Infinity なら高さは見ない
 */
export function heightCapScale(n, maxHeight) {
    if (!(maxHeight > 0) || !Number.isFinite(maxHeight)) return 1;
    return Math.min(1, Math.max(maxHeight / n.h, READABLE_SCALE));
}

/**
 * SVG に大きさを付け直す。
 * @param {SVGSVGElement} svg
 * @param {number} [maxHeight=Infinity]
 * @returns {boolean} viewBox があって付け直せたら true
 */
export function fitDiagram(svg, maxHeight = Infinity) {
    const n = naturalSize(svg);
    if (!n) return false;
    const scale = heightCapScale(n, maxHeight);
    svg.removeAttribute('height');
    svg.setAttribute('width', '100%');
    svg.style.width = '100%';
    svg.style.maxWidth = `${Math.round(n.w * scale)}px`;
    svg.style.height = 'auto';
    // height: auto の解決を viewBox 任せにしない (種類によって 0 に潰れた)。
    svg.style.aspectRatio = `${n.w} / ${n.h}`;
    return true;
}

/**
 * 文書の中の図に使う高さの上限。窓の 7 割、ただし極端に小さな窓でも
 * 360px は確保する。
 */
export function documentMaxHeight(win = typeof window !== 'undefined' ? window : null) {
    const h = win && win.innerHeight;
    return h > 0 ? Math.max(360, Math.round(h * 0.7)) : Infinity;
}
