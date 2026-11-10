/**
 * NativeDrag.js — dragging files out of the app (commands/file_drag.rs).
 *
 * Other applications do not understand an HTML5 drag, so where the OS drag
 * exists it replaces it. Over the app's own panels it then looks like files
 * from outside, which is why the explorer remembers what it is dragging.
 */
import { invoke } from '@tauri-apps/api/core';

/** Only on Windows, and only inside the app rather than a plain browser page. */
export function nativeDragAvailable() {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
        && /Windows/i.test(navigator.userAgent || '');
}

/** Resolves when the drag has ended, wherever it ended. */
export function startNativeDrag(paths) {
    return invoke('start_file_drag', { paths });
}
