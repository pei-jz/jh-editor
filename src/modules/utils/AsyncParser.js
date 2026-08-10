/**
 * AsyncParser.js
 * Provides an asynchronous interface for parsing structured data (XML, JSON, HTML)
 * using Web Workers.
 */

let worker = null;
let nextRequestId = 0;
const pendingRequests = new Map();

function getWorker() {
    if (!worker) {
        try {
            worker = new Worker(new URL('../workers/Parser.worker.js', import.meta.url), { 
                type: 'module' 
            });
            
            worker.onmessage = (e) => {
                const { success, rootNode, error, requestId } = e.data;
                const handler = pendingRequests.get(requestId);
                
                if (handler) {
                    pendingRequests.delete(requestId);
                    if (success) {
                        handler.resolve(rootNode);
                    } else {
                        handler.reject(new Error(error));
                    }
                }
            };

            worker.onerror = (err) => {
                console.error('Parser Worker Error:', err);
                for (const [id, handler] of pendingRequests) {
                    handler.reject(new Error('Worker error: ' + err.message));
                }
                pendingRequests.clear();
                worker = null;
            };
        } catch (e) {
            console.error('Failed to start Parser Worker:', e);
            return null;
        }
    }
    return worker;
}

/**
 * Perform asynchronous parsing
 * @param {string} content - The string to parse
 * @param {string} type - 'xml', 'json', or 'html'
 * @returns {Promise<Object>} - The root node of the parsed tree
 */
export function parseAsync(content, type) {
    return new Promise((resolve, reject) => {
        const w = getWorker();
        if (!w) {
            // Static Fallback
            // Requires dynamic imports for all parsers which might be heavy
            // For now, if worker fails, we reject
            reject(new Error('Parser background worker not available'));
            return;
        }

        const requestId = nextRequestId++;
        pendingRequests.set(requestId, { resolve, reject });
        w.postMessage({ content, type, requestId });
    });
}
