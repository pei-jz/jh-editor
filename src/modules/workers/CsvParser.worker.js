/**
 * CsvParser.worker.js
 * Web Worker for parsing CSV data in the background.
 */

self.onmessage = (e) => {
    const { content, requestId } = e.data;
    
    try {
        const rows = parseCsv(content);
        self.postMessage({ 
            success: true, 
            rows, 
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

/**
 * Standard CSV parsing logic (simplified for the worker)
 */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (inQuotes) {
            if (char === '"') {
                if (nextChar === '"') {
                    cell += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += char;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                row.push(cell);
                cell = '';
            } else if (char === '\r' || char === '\n') {
                row.push(cell);
                if (row.length > 0) rows.push(row);
                row = [];
                cell = '';
                if (char === '\r' && nextChar === '\n') i++;
            } else {
                cell += char;
            }
        }
    }
    
    if (row.length > 0 || cell !== '') {
        row.push(cell);
        rows.push(row);
    }
    
    return rows;
}
