import { describe, it, expect, beforeEach, vi } from 'vitest';

// Tauri のウィンドウ・イベントを、メモリの中の小さな模型に置き換える
const bus = { listeners: {}, emitted: [], windows: [], invoked: [], autoReady: true };
const monitors = [
    { name: 'laptop', position: { x: 0, y: 0 }, size: { width: 2880, height: 1800 }, scaleFactor: 2 },
    { name: 'projector', position: { x: 2880, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
];
let monitorList = monitors;

vi.mock('@tauri-apps/api/window', () => ({
    // 本物と同じ形: currentMonitor はウィンドウのメソッドではなく、単独の関数
    availableMonitors: async () => monitorList,
    currentMonitor: async () => monitors[0],
    getCurrentWindow: () => ({
        label: 'main',
        setFocus: async () => {},
    }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: {
        getByLabel: async (label) => bus.windows.find((w) => w.label === label && !w.destroyed) || null,
    },
    getCurrentWebviewWindow: () => ({
        listen: async (ev, fn) => { bus.listeners[ev] = fn; return () => { delete bus.listeners[ev]; }; },
    }),
}));
vi.mock('@tauri-apps/api/event', () => ({
    emitTo: async (target, event, payload) => { bus.emitted.push({ target, event, payload }); },
}));
// 発表用ウィンドウは Rust のコマンドで作る。読み込まれたら、その画面が ready を送ってくる
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd, args) => {
        bus.invoked.push({ cmd, args });
        if (cmd === 'open_deck_audience') {
            // deck.rs と同じく、前の発表用ウィンドウが残っていれば閉じてから作る
            bus.windows.forEach((w) => { if (w.label === 'deck-audience') w.destroyed = true; });
            const win = {
                label: 'deck-audience', args, handlers: {}, destroyed: false,
                once(ev, fn) { this.handlers[ev] = fn; },
                async destroy() { this.destroyed = true; },
            };
            bus.windows.push(win);
            if (bus.autoReady) setTimeout(() => bus.listeners['deck-presenter:ready'] && bus.listeners['deck-presenter:ready'](), 0);
        }
    },
}));

const { applyAudienceMessage, pickAudienceMonitor, openAudience, DeckEdit } = await import('../src/modules/utils/DeckAudience.js');

beforeEach(() => {
    bus.listeners = {};
    bus.emitted = [];
    bus.windows = [];
    bus.invoked = [];
    bus.autoReady = true;
    monitorList = monitors;
});

describe('DeckAudience — what the audience window does with deck messages', () => {
    const msg = (o) => ({ jhdeck: DeckEdit.PROTOCOL, ...o });

    it('reports positions only after the deck is ready', () => {
        expect(applyAudienceMessage(msg({ type: 'state', index: 0, step: 0 }), { ready: false })).toEqual({});
        expect(applyAudienceMessage(msg({ type: 'ready' }), { ready: false })).toEqual({ ready: true });
        expect(applyAudienceMessage(msg({ type: 'state', index: 2, step: 1 }), { ready: true })).toEqual({ state: { index: 2, step: 1 } });
    });

    it('treats Esc / F5 in the audience window as ending the presentation', () => {
        expect(applyAudienceMessage(msg({ type: 'present-exit' }), { ready: true })).toEqual({ exit: true });
        expect(applyAudienceMessage(msg({ type: 'present' }), { ready: true })).toEqual({ exit: true });
        expect(applyAudienceMessage({ type: 'state' }, { ready: true })).toEqual({});
    });

    it('puts the audience window on a monitor other than the editor\'s', () => {
        expect(pickAudienceMonitor(monitors, monitors[0]).name).toBe('projector');
        expect(pickAudienceMonitor(monitors, monitors[1]).name).toBe('laptop');
        expect(pickAudienceMonitor([monitors[0]], monitors[0])).toBeNull();
    });
});

describe('DeckAudience — opening the window and keeping both in step', () => {
    const open = (extra = {}) => openAudience({
        content: '<html>deck</html>', path: 'C:/d/talk.html', index: 3, step: 1,
        onState: vi.fn(), onExit: vi.fn(), ...extra,
    });

    it('closes a window that never loads and falls back to one screen', async () => {
        bus.autoReady = false;
        const onExit = vi.fn();
        await expect(open({ onExit, readyTimeout: 20 })).rejects.toThrow();
        expect(bus.windows[0].destroyed).toBe(true);
        expect(onExit).not.toHaveBeenCalled();
    });

    it('does nothing with a single monitor', async () => {
        monitorList = [monitors[0]];
        expect(await open()).toBeNull();
        expect(bus.windows).toHaveLength(0);
    });

    it('opens on the other monitor through the Rust command and sends the deck once it loads', async () => {
        const audience = await open();
        expect(audience).not.toBeNull();
        const call = bus.invoked.find((c) => c.cmd === 'open_deck_audience');
        expect(call.args.owner).toBe('main');
        expect(call.args.x).toBeGreaterThanOrEqual(2880);
        expect(bus.emitted.at(-1)).toEqual({
            target: 'deck-audience',
            event: 'deck-audience:load',
            payload: { content: '<html>deck</html>', path: 'C:/d/talk.html', index: 3, step: 1 },
        });
    });

    it('moves the audience window with the presenter, and the presenter with the audience window', async () => {
        const onState = vi.fn();
        const audience = await open({ onState });
        audience.goto(4, 0);
        expect(bus.emitted.at(-1)).toEqual({ target: 'deck-audience', event: 'deck-audience:goto', payload: { index: 4, step: 0 } });
        // 同じ位置を何度送っても 1 回だけ
        const before = bus.emitted.length;
        audience.goto(4, 0);
        expect(bus.emitted.length).toBe(before);

        bus.listeners['deck-presenter:state']({ payload: { index: 5, step: 2 } });
        expect(onState).toHaveBeenCalledWith({ index: 5, step: 2 });
    });

    it('ends when the audience window says so or is closed, and closes it from the presenter', async () => {
        const onExit = vi.fn();
        const audience = await open({ onExit });
        bus.listeners['deck-presenter:exit']();
        expect(onExit).toHaveBeenCalledTimes(1);
        // 一度終わったら、閉じる操作で二重に知らせない
        audience.close();
        expect(onExit).toHaveBeenCalledTimes(1);

        const onExit2 = vi.fn();
        const second = await open({ onExit: onExit2 });
        second.close();
        expect(bus.windows.at(-1).destroyed).toBe(true);
        expect(bus.emitted.some((e) => e.event === 'deck-audience:close')).toBe(true);
        expect(onExit2).toHaveBeenCalledTimes(1);
    });
});

describe('DeckAudience — the Tauri API it relies on really looks like that', () => {
    it('uses only functions and methods the real @tauri-apps/api provides', async () => {
        const win = await vi.importActual('@tauri-apps/api/window');
        const wv = await vi.importActual('@tauri-apps/api/webviewWindow');
        const ev = await vi.importActual('@tauri-apps/api/event');
        // 単独の関数
        for (const fn of ['availableMonitors', 'currentMonitor', 'getCurrentWindow']) expect(typeof win[fn], fn).toBe('function');
        expect(typeof wv.getCurrentWebviewWindow).toBe('function');
        expect(typeof ev.emitTo).toBe('function');
        const core = await vi.importActual('@tauri-apps/api/core');
        expect(typeof core.invoke).toBe('function');
        // ウィンドウのメソッド (WebviewWindow は Window のメソッドも持つ)
        for (const m of ['setFocus', 'setFullscreen', 'destroy', 'once', 'listen']) {
            expect(typeof wv.WebviewWindow.prototype[m], m).toBe('function');
        }
        expect(typeof win.Window.prototype.setFocus).toBe('function');
        expect(typeof wv.WebviewWindow.getByLabel).toBe('function');
        // currentMonitor はウィンドウのメソッドではない (これを取り違えて動かなかった)
        expect(win.Window.prototype.currentMonitor).toBeUndefined();
    });
});
