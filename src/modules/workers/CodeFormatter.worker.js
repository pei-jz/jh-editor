/**
 * CodeFormatter.worker.js
 * Web Worker for running code formatting logic in a background thread.
 */
import { CodeFormatter } from '../utils/CodeFormatter.js';

self.onmessage = (e) => {
    const { content, type, requestId } = e.data;
    
    try {
        const formatted = CodeFormatter.format(content, type);
        self.postMessage({ 
            success: true, 
            formatted, 
            requestId 
        });
    } catch (err) {
        self.postMessage({ 
            success: false, 
            error: err.toString(), 
            requestId 
        });
    }
};
