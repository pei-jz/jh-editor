/**
 * MermaidTheme.js — 図の色と形を、いま開いているテーマから決める。
 *
 * 以前は isDarkTheme() で 'dark' / 'default' のどちらかを選ぶだけだった。
 * それだと Paper の生成り地に真っ白な箱、Solarized の紺地に灰色の箱が乗り、
 * 図だけが別のアプリから貼ったように浮く。mermaid の `base` テーマは
 * themeVariables を受け取るので、テーマの CSS 変数から色を作って渡す。
 *
 * 色は「反転色」ではなく、テーマ自身の文字色・強調色から作る。背景の反転は
 * 中間の明るさの地で 1:1 近くまでコントラストが落ちるが、文字色はそのテーマで
 * 読めることが前提の色なので、線と文字に使えば必ず見える。
 */

import { isDarkTheme } from './ThemeInfo.js';

/** 変数が読めないときの色。Light テーマの値に合わせてある。 */
const FALLBACK = {
    bg: '#ffffff',
    text: '#24292f',
    primary: '#0969da',
    border: '#d0d7de',
};

/**
 * '#rgb' / '#rrggbb' / 'rgb()' / 'rgba()' を {r,g,b,a} にする。
 * それ以外の書き方は null。ブラウザで正規化した後の値を受ける前提なので、
 * この範囲で足りる。
 */
export function parseColor(value) {
    const s = String(value || '').trim().toLowerCase();
    let m = s.match(/^#([0-9a-f]{3})$/);
    if (m) {
        const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
        return { r, g, b, a: 1 };
    }
    m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
    if (m) {
        const n = parseInt(m[1], 16);
        const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
    }
    m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/);
    if (m) {
        let a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (m[5] === '%') a /= 100;
        return { r: +m[1], g: +m[2], b: +m[3], a: Math.max(0, Math.min(1, a)) };
    }
    return null;
}

const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

/** {r,g,b} を '#rrggbb' に。mermaid の色計算 (khroma) が確実に読める形。 */
export function toHex(c) {
    return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/** a を下地、b を上に t の割合で重ねた色。t=0 で a、t=1 で b。 */
export function mix(a, b, t) {
    return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
        a: 1,
    };
}

/** 半透明の色を下地に乗せて不透明にする。--border-color は rgba のテーマが多い。 */
function flatten(c, under) {
    return c.a >= 1 ? c : mix(under, c, c.a);
}

/**
 * CSS の色をブラウザに正規化させてから読む。テーマは color-mix() や名前色で
 * 書かれていることがあり、それを自前で解釈するより canvas に任せる方が確実。
 */
function readCssColor(style, name) {
    const raw = style.getPropertyValue(name).trim();
    if (!raw) return null;
    const direct = parseColor(raw);
    if (direct) return direct;
    try {
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#010203';
        ctx.fillStyle = raw;
        // 解釈できなかった値は代入が無視され、番兵の色が残る。
        if (ctx.fillStyle === '#010203') return null;
        return parseColor(ctx.fillStyle);
    } catch (_) {
        return null;
    }
}

/**
 * テーマの基本色から mermaid の themeVariables を作る。DOM に触れないので
 * テストから直接呼べる。
 *
 * @param {{bg:string, text:string, primary:string, border:string}} palette
 * @param {boolean} dark
 */
export function buildThemeVariables(palette, dark) {
    const bg = flatten(parseColor(palette.bg) || parseColor(FALLBACK.bg), { r: 255, g: 255, b: 255, a: 1 });
    const text = flatten(parseColor(palette.text) || parseColor(FALLBACK.text), bg);
    const primary = flatten(parseColor(palette.primary) || parseColor(FALLBACK.primary), bg);
    const border = flatten(parseColor(palette.border) || parseColor(FALLBACK.border), bg);

    // 箱は地に強調色をうっすら混ぜた色。濃くすると文字色とのコントラストが
    // 落ちるので、暗いテーマでも 2 割を超えない。
    const nodeFill = mix(bg, primary, dark ? 0.18 : 0.12);
    const line = mix(bg, text, 0.75);
    const muted = mix(bg, text, dark ? 0.08 : 0.05);
    const note = mix(bg, primary, dark ? 0.28 : 0.2);

    const T = toHex(text);
    return {
        darkMode: dark,
        background: toHex(bg),

        primaryColor: toHex(nodeFill),
        primaryTextColor: T,
        primaryBorderColor: toHex(primary),
        // secondary / tertiary は渡さない。base テーマが primaryColor から
        // 色相をずらして作るので、円グラフや状態図の塗り分けが残る。

        mainBkg: toHex(nodeFill),
        nodeBorder: toHex(primary),
        nodeTextColor: T,
        textColor: T,
        titleColor: T,
        lineColor: toHex(line),
        defaultLinkColor: toHex(line),
        edgeLabelBackground: toHex(bg),

        clusterBkg: toHex(muted),
        clusterBorder: toHex(border),

        noteBkgColor: toHex(note),
        noteTextColor: T,
        noteBorderColor: toHex(primary),

        // シーケンス図
        actorBkg: toHex(nodeFill),
        actorBorder: toHex(primary),
        actorTextColor: T,
        actorLineColor: toHex(line),
        signalColor: toHex(line),
        signalTextColor: T,
        labelBoxBkgColor: toHex(nodeFill),
        labelBoxBorderColor: toHex(primary),
        labelTextColor: T,
        loopTextColor: T,
        activationBkgColor: toHex(muted),
        activationBorderColor: toHex(line),
        sequenceNumberColor: toHex(bg),
    };
}

/** いまの <body> のテーマ変数を読む。 */
export function currentPalette(doc = document) {
    const body = doc && doc.body;
    const view = doc && doc.defaultView;
    if (!body || !view) return { ...FALLBACK };
    const style = view.getComputedStyle(body);
    const pick = (name, fb) => {
        const c = readCssColor(style, name);
        return c ? (c.a >= 1 ? toHex(c) : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`) : fb;
    };
    return {
        bg: pick('--bg-color', FALLBACK.bg),
        text: pick('--text-color', FALLBACK.text),
        primary: pick('--primary-color', FALLBACK.primary),
        border: pick('--border-color', FALLBACK.border),
    };
}

/**
 * mermaid.initialize に渡す設定一式。
 *
 * 図ごとの `%%{init}%%` やフロントマターはこれより優先されるので、個別に
 * 曲線や別テーマを指定した図はそのまま描かれる。
 *
 * 色は描く先の文書から読む。印刷用の iframe にはテーマのクラスも変数も
 * 無いので、画面がダークでも紙向けの明るい配色になる。
 *
 * themed=false は、図が自分でテーマを指定しているとき。全体設定に
 * themeVariables があると、図の側で forest や dark を選んでも上から塗られて
 * しまう (mermaid は名前付きテーマにも themeVariables を重ねる)。そういう図
 * には以前どおり名前付きテーマだけを渡し、図の指定に任せる。
 *
 * @param {{elk?: boolean, doc?: Document, themed?: boolean}} opts
 *   elk は ELK を登録できたときだけ true
 */
export function mermaidConfig({ elk = false, doc = document, themed = true } = {}) {
    const dark = isDarkTheme(doc && doc.body);
    const colours = themed
        ? { theme: 'base', themeVariables: buildThemeVariables(currentPalette(doc), dark) }
        : { theme: dark ? 'dark' : 'default' };
    return {
        startOnLoad: false,
        // 'strict' の理由は Markdown.js の initMermaid() を参照。
        securityLevel: 'strict',
        ...colours,
        // ELK は辺を直交で引き、交差とラベルの重なりを避けて配置する。
        // 読み込めなかったときは mermaid 標準の dagre に戻る。
        layout: elk ? 'elk' : 'dagre',
        elk: {
            // 同じ箱へ入る線を 1 本にまとめると、どこから来た線か追えなくなる。
            mergeEdges: false,
            nodePlacementStrategy: 'BRANDES_KOEPF',
        },
        flowchart: {
            // dagre に戻ったときもカギ線にする。ELK は自分で直交経路を作る。
            curve: 'step',
            nodeSpacing: 50,
            rankSpacing: 60,
            padding: 12,
        },
    };
}

/**
 * 図の記述が自分でテーマを決めているか。`%%{init: {"theme": …}}%%` と、
 * フロントマターの `config:` 下の `theme:` の二つの書き方がある。
 */
export function hasOwnTheme(src) {
    const text = String(src || '');
    if (/%%\{[\s\S]*?["']?theme["']?\s*:[\s\S]*?\}%%/.test(text)) return true;
    const fm = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
    return !!fm && /^\s+theme\s*:/m.test(fm[1]);
}
