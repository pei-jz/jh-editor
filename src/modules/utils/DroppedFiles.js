/**
 * DroppedFiles.js — real paths for files dragged in from outside the app.
 *
 * The window runs with Tauri's native drag-drop handler switched off, because
 * that handler replaces WebView2's own drop target and the tabs and explorer
 * rely on HTML5 drag-and-drop. What the page receives instead is a plain DOM
 * drop, whose File objects carry a name but no path: File.path is an Electron
 * extension, and WebView2 has no such property. The old fallback read it
 * anyway, so it only ever had bare file names to open.
 *
 * WebView2 does offer a way through: `chrome.webview.postMessageWithAdditionalObjects`
 * hands DOM File objects to the host, where each one exposes its full path.
 * The Rust side (commands/drop.rs) answers with an event carrying the paths.
 */
import { listen } from '@tauri-apps/api/event';

/** Message prefix the host looks for; the rest of the message is a request id. */
export const DROP_MESSAGE_PREFIX = 'jh-editor:dropped-files:';
/** Event the host answers on: `{ id, paths }`. */
export const DROP_RESULT_EVENT = 'jh-dropped-files';

// Internal drags (tabs, explorer rows) carry these; they are not file drops.
const INTERNAL_TYPES = ['application/x-jheditor', 'application/x-editor-item'];

const pending = new Map();
let listening = null;
let sequence = 0;

/** Start listening for the host's answers. Safe to call more than once. */
export function initDroppedFiles() {
    if (!listening) {
        listening = listen(DROP_RESULT_EVENT, (event) => {
            const { id, paths } = (event && event.payload) || {};
            const resolve = pending.get(String(id));
            if (!resolve) return; // another window's drop
            pending.delete(String(id));
            resolve(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : []);
        }).catch((e) => {
            console.warn('DroppedFiles: could not listen for dropped paths', e);
            listening = null;
        });
    }
    return listening;
}

/** True for a drag of files from outside the app (not a tab or explorer row). */
export function isExternalFileDrag(dataTransfer) {
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types || []);
    if (types.some((type) => INTERNAL_TYPES.some((internal) => type.startsWith(internal)))) return false;
    return types.includes('Files');
}

/** Whether this webview can report dropped paths at all. */
export function canResolveDroppedPaths() {
    const webview = typeof window !== 'undefined' && window.chrome && window.chrome.webview;
    return !!(webview && typeof webview.postMessageWithAdditionalObjects === 'function');
}

/**
 * The full paths of dropped `files`, in order. Resolves to [] where the webview
 * cannot tell (not WebView2, too old a runtime, no answer in time).
 *
 * Call it from the drop handler itself: the files are handed over at once, and
 * only the answer is awaited.
 */
export function resolveDroppedPaths(files, { timeoutMs = 3000 } = {}) {
    const list = Array.from(files || []);
    if (!list.length || !canResolveDroppedPaths()) return Promise.resolve([]);
    initDroppedFiles();

    sequence += 1;
    const id = `${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            resolve([]);
        }, timeoutMs);
        pending.set(id, (paths) => {
            clearTimeout(timer);
            resolve(paths);
        });
        try {
            window.chrome.webview.postMessageWithAdditionalObjects(`${DROP_MESSAGE_PREFIX}${id}`, list);
        } catch (e) {
            console.warn('DroppedFiles: could not hand the files to the host', e);
            clearTimeout(timer);
            pending.delete(id);
            resolve([]);
        }
    });
}
