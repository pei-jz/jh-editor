/**
 * deck-audience.js — 発表用ウィンドウ (聞き手に見せる画面)。
 *
 * Deck View の「発表」は、モニターが 2 台以上あるとき、もう 1 台にこのウィンドウを全画面で開き、
 * 元のウィンドウを発表者ビューにする。どちらで操作しても、もう一方が同じ位置へ移る。
 *
 * やり取り (Tauri のイベント):
 *   エディタ → ここ: deck-audience:load { content, path, index, step } / goto { index, step } / close
 *   ここ → エディタ: deck-presenter:ready / state { index, step } / exit
 *
 * デッキは Deck View と同じく、スクリプトだけを許した sandbox の iframe で動かす。
 */
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { buildPreviewDocument } from './modules/ui/HtmlPreview.js';
import { DeckEdit, applyAudienceMessage } from './modules/utils/DeckAudience.js';

const win = getCurrentWebviewWindow();
const frame = document.getElementById('deck');
// 発表者ビューのウィンドウ (開いた側)。ウィンドウを作るときに Rust 側が入れておく (deck.rs)
const owner = window.__JH_DECK_OWNER__ || new URLSearchParams(location.search).get('owner') || 'main';
let pending = null; // 読み込み後に移る位置
let ready = false;

const post = (msg) => {
    if (frame.contentWindow) frame.contentWindow.postMessage({ ...msg, jhdeck: DeckEdit.PROTOCOL }, '*');
};
const tell = (event, payload = {}) => emitTo(owner, `deck-presenter:${event}`, payload).catch(() => { /* 発表者側が閉じた */ });

async function start() {
    // 待ち受けを済ませてから ready を送る (送った直後に届く load を取りこぼさない)
    await Promise.all([
        win.listen('deck-audience:load', ({ payload }) => {
            ready = false;
            pending = { index: payload.index || 0, step: payload.step || 0 };
            frame.srcdoc = buildPreviewDocument(payload.content, payload.path);
        }),
        win.listen('deck-audience:goto', ({ payload }) => {
            if (ready) post({ type: 'goto', index: payload.index, step: payload.step });
            else pending = payload;
        }),
        win.listen('deck-audience:close', () => { win.close(); }),
    ]);

    window.addEventListener('message', (ev) => {
        if (ev.source !== frame.contentWindow || !ev.data || !ev.data.jhdeck) return;
        const action = applyAudienceMessage(ev.data, { ready });
        if (action.ready) {
            ready = true;
            // 発表中であることを伝える (デッキの Esc が「発表の終了」になる)
            post({ type: 'present', on: true });
            if (pending) post({ type: 'goto', index: pending.index, step: pending.step });
            pending = null;
        }
        if (action.state) tell('state', action.state);
        if (action.exit) tell('exit');
    });

    // このウィンドウを閉じたら、発表者側も発表を終える
    window.addEventListener('beforeunload', () => { tell('exit'); });
    tell('ready');
}

start();
