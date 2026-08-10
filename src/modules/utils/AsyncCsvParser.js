/**
 * AsyncCsvParser.js
 * Provides an asynchronous interface for CSV parsing using Web Workers.
 */

let worker = null;
let nextRequestId = 0;
const pendingRequests = new Map();

function getWorker() {
    if (!worker) {
        try {
            worker = new Worker(new URL('../workers/CsvParser.worker.js', import.meta.url), { 
                type: 'module' 
            });
            
            worker.onmessage = (e) => {
                const { success, rows, error, requestId } = e.data;
                const handler = pendingRequests.get(requestId);
                
                if (handler) {
                    pendingRequests.delete(requestId);
                    if (success) {
                        handler.resolve(rows);
                    } else {
                        handler.reject(new Error(error));
                    }
                }
            };

            worker.onerror = (err) => {
                console.error('CsvParser Worker Error:', err);
                for (const [id, handler] of pendingRequests) {
                    handler.reject(new Error('Worker error: ' + err.message));
                }
                pendingRequests.clear();
                worker = null;
            };
        } catch (e) {
            console.error('Failed to start CsvParser Worker:', e);
            return null;
        }
    }
    return worker;
}

/**
 * Perform asynchronous CSV parsing
 * @param {string} content - The CSV text to parse
 * @returns {Promise<Array[]>} - The parsed rows
 */
export function parseCsvAsync(content) {
    return new Promise((resolve, reject) => {
        const w = getWorker();
        if (!w) {
            reject(new Error('CsvParser background worker not available'));
            return;
        }

        const requestId = nextRequestId++;
        pendingRequests.set(requestId, { resolve, reject });
        w.postMessage({ content, requestId });
    });
}
