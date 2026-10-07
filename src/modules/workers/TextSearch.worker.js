/**
 * TextSearch.worker.js
 * Finds (or replaces) every search hit in a large document off the main
 * thread. One worker per run: cancelling is terminate().
 */
import { findAllMatches, replaceAllMatches } from '../utils/TextSearchCore.js';

self.onmessage = (e) => {
    const { text, replace, positions, ...opts } = e.data;
    try {
        let last = 0;
        const onProgress = (scanned, count) => {
            const now = Date.now();
            if (now - last < 50) return;
            last = now;
            self.postMessage({ type: 'progress', scanned, total: text.length, count });
        };
        if (replace != null) {
            self.postMessage({ type: 'done', ...replaceAllMatches(text, opts, replace, positions, onProgress) });
        } else {
            const res = findAllMatches(text, opts, onProgress);
            self.postMessage({ type: 'done', ...res }, [res.starts.buffer, res.ends.buffer]);
        }
    } catch (err) {
        self.postMessage({ type: 'error', error: String(err && err.message || err) });
    }
};
