/**
 * DeckAudience.js — 2 画面での発表 (発表用ウィンドウ ⇔ 発表者ビュー)。
 *
 * Deck View の「発表」は、モニターが 2 台以上あれば、もう 1 台に発表用ウィンドウ
 * (deck-audience.html) を全画面で開く。元のウィンドウは発表者ビュー (今のスライド・次のスライド・
 * ノート・経過時間) になり、どちらで操作しても、もう一方が同じスライド・ステップへ移る。
 *
 * ここには発表用ウィンドウの開閉とイベントの受け渡し、それと単体で試せる判定だけを置く。
 * 画面は DeckView (発表者ビュー) と src/deck-audience.js (発表用ウィンドウ) にある。
 */
import '../../vendor/jh-deck-edit.js';

/** jh-presentation の編集ライブラリ (PROTOCOL を使う) */
export const DeckEdit = globalThis.JhDeckEdit;

export const AUDIENCE_LABEL = 'deck-audience';

/** 発表用ウィンドウが読み込まれるのを待つ時間 (ms)。過ぎたら閉じて 1 画面で発表する */
const READY_TIMEOUT = 8000;

/**
 * 発表用ウィンドウで、デッキ (iframe) から届いたメッセージをどう扱うか。
 * @returns {{ ready?: true, state?: {index:number, step:number}, exit?: true }}
 */
export function applyAudienceMessage(d, { ready }) {
    if (!d || !d.jhdeck) return {};
    switch (d.type) {
        case 'ready': return { ready: true };
        // 読み込み直後のデッキは ready より先に 1 枚目の state を送るので、ready までは伝えない
        case 'state': return ready ? { state: { index: d.index || 0, step: d.step || 0 } } : {};
        // 発表用ウィンドウでの Esc / F5 は、発表の終了
        case 'present-exit':
        case 'present': return { exit: true };
        default: return {};
    }
}

/** 発表用ウィンドウを出すモニター: 今のウィンドウがあるモニター以外の 1 台 (なければ null) */
export function pickAudienceMonitor(monitors, current) {
    if (!Array.isArray(monitors) || monitors.length < 2) return null;
    const same = (a, b) => !!a && !!b && a.position.x === b.position.x && a.position.y === b.position.y;
    return monitors.find((m) => !same(m, current)) || null;
}

/**
 * 発表用ウィンドウを開く。モニターが 1 台なら null (1 画面での発表になる)。
 * @param {object} o
 * @param {string} o.content   デッキのソース
 * @param {string|null} o.path
 * @param {number} o.index
 * @param {number} o.step
 * @param {(s:{index:number, step:number}) => void} o.onState  発表用ウィンドウで移ったとき
 * @param {() => void} o.onExit   発表用ウィンドウで終了した / 閉じたとき
 * @param {number} [o.readyTimeout]  読み込みを待つ時間 (テスト用)
 * @returns {Promise<{ goto: Function, close: Function } | null>}
 */
export async function openAudience({ content, path, index, step, onState, onExit, readyTimeout = READY_TIMEOUT }) {
    const [{ availableMonitors, currentMonitor, getCurrentWindow }, { WebviewWindow, getCurrentWebviewWindow }, { emitTo }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/webviewWindow'),
        import('@tauri-apps/api/event'),
        import('@tauri-apps/api/core'),
    ]);
    const me = getCurrentWindow();
    const target = pickAudienceMonitor(await availableMonitors(), await currentMonitor());
    if (!target) return null;

    // 開いたウィンドウからの知らせは、ウィンドウを作る前に待ち受けておく (ready を取りこぼさない)
    let latest = { index, step };
    let closed = false;
    let win = null;
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    const unlisten = [];
    const stopListening = () => unlisten.forEach((u) => { try { u(); } catch (_) { /* 解除済み */ } });
    const finish = () => {
        if (closed) return;
        closed = true;
        stopListening();
        onExit();
    };
    const self = getCurrentWebviewWindow();
    unlisten.push(...await Promise.all([
        self.listen('deck-presenter:ready', () => {
            markReady();
            emitTo(AUDIENCE_LABEL, 'deck-audience:load', { content, path, index: latest.index, step: latest.step });
        }),
        self.listen('deck-presenter:state', ({ payload }) => onState(payload)),
        self.listen('deck-presenter:exit', finish),
    ]));

    // 作るのは Rust 側 (メインウィンドウと同じ WebView2 の起動オプションが要るため。deck.rs)。
    // モニターの位置は物理ピクセル、ウィンドウの指定は論理ピクセル
    const sf = target.scaleFactor || 1;
    try {
        await invoke('open_deck_audience', {
            owner: me.label,
            x: target.position.x / sf + 40,
            y: target.position.y / sf + 40,
            width: Math.max(640, target.size.width / sf - 80),
            height: Math.max(360, target.size.height / sf - 80),
        });
        win = await WebviewWindow.getByLabel(AUDIENCE_LABEL);
        // 開いたのに画面が読み込まれない (真っ白のまま) なら、閉じて 1 画面での発表にする
        const ok = await Promise.race([ready.then(() => true), new Promise((r) => setTimeout(() => r(false), readyTimeout))]);
        if (!ok) throw new Error('The presentation window did not load.');
    } catch (err) {
        closed = true;
        stopListening();
        if (win) await win.destroy().catch(() => {});
        throw err;
    }
    if (win) win.once('tauri://destroyed', finish);
    // 操作は発表者ビュー (元のウィンドウ) で続けられるようにする
    await me.setFocus().catch(() => {});

    return {
        goto(i, s) {
            if (closed || (latest.index === i && latest.step === s)) return;
            latest = { index: i, step: s };
            emitTo(AUDIENCE_LABEL, 'deck-audience:goto', latest).catch(() => {});
        },
        close() {
            if (closed) return;
            emitTo(AUDIENCE_LABEL, 'deck-audience:close').catch(() => {});
            if (win) win.destroy().catch(() => {});
            finish();
        },
    };
}
