/**
 * AsyncFormatter.js
 * Provides an asynchronous interface for code formatting using Web Workers.
 * This prevents the UI from freezing when formatting large files.
 */

let worker = null;
let nextRequestId = 0;
const pendingRequests = new Map();

/**
 * Initialize or get the existing Web Worker
 */
function getWorker() {
    if (!worker) {
        // Note: type: 'module' is required for the worker to use modern imports
        try {
            worker = new Worker(new URL('../workers/CodeFormatter.worker.js', import.meta.url), { 
                type: 'module' 
            });
            
            worker.onmessage = (e) => {
                const { success, formatted, error, requestId } = e.data;
                const handler = pendingRequests.get(requestId);
                
                if (handler) {
                    pendingRequests.delete(requestId);
                    if (success) {
                        handler.resolve(formatted);
                    } else {
                        handler.reject(new Error(error));
                    }
                }
            };

            worker.onerror = (err) => {
                console.error('CodeFormatter Worker Error:', err);
                // Fail all pending requests
                for (const [id, handler] of pendingRequests) {
                    handler.reject(new Error('Worker error: ' + err.message));
                }
                pendingRequests.clear();
                worker = null;
            };
        } catch (e) {
            console.error('Failed to start CodeFormatter Worker:', e);
            return null;
        }
    }
    return worker;
}

/**
 * Perform asynchronous formatting
 * @param {string} content - The code to format
 * @param {string} type - File extension/type
 * @returns {Promise<string>} - The formatted content
 */
export function formatAsync(content, type) {
    return new Promise((resolve, reject) => {
        const w = getWorker();
        if (!w) {
            // Fallback to sync if worker fails to start
            import('./CodeFormatter.js').then(m => {
                try {
                    resolve(m.CodeFormatter.format(content, type));
                } catch (e) {
                    reject(e);
                }
            });
            return;
        }

        const requestId = nextRequestId++;
        pendingRequests.set(requestId, { resolve, reject });
        w.postMessage({ content, type, requestId });
    });
}
